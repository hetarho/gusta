import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fixture, git, archiveTask } from './helpers/vibe-fixture.mjs'
import { vibeLoop, executeVibeUnit } from '../src/vibe-loop.mjs'
import { buildCatalog } from '../src/agent-catalog.mjs'

const cli = fileURLToPath(new URL('../bin/gusta.mjs', import.meta.url))
const passed = async () => ({ ok: true, checks: [] })
const HINT = '/gusta-init으로 쓸 AI 목록(SETTINGS agents)을 정한 뒤 다시 실행하세요'
const CLAUDE = { installed: true, loggedIn: true, models: ['haiku', 'sonnet', 'opus', 'fable'].map((model) => ({ model, efforts: ['low', 'medium', 'high', 'xhigh', 'max'], context: null })) }
const CODEX = { installed: true, loggedIn: true, models: ['luna-mini', 'terra', 'sol', 'astra'].map((model, priority) => ({ model, efforts: ['low', 'medium', 'high', 'xhigh'], context: 272000, priority })) }
const catalog = (agents) => () => buildCatalog({ claude: CLAUDE, codex: CODEX }, agents)

// The planned run: of each task and SETTINGS agents, committed like a planning slice.
async function plan(root, runs, agents) {
  for (const [id, run] of Object.entries(runs)) {
    const file = path.join(root, `spec/tasks/${id}.example.md`)
    await writeFile(file, (await readFile(file, 'utf8')).replace('touches:src/', `touches:src/ | run:${run}`))
  }
  if (agents) await writeFile(path.join(root, 'spec/SETTINGS.md'), `# SETTINGS\n- agents: ${agents}\n`)
  await git(root, 'add', '-A'); await git(root, 'commit', '-q', '-m', 'plan runs')
}
const complete = (root, seen) => async (_options, job) => {
  seen.push({ task: job.brief.taskId, route: job.route })
  await archiveTask(root, job.brief.taskId)
  await writeFile(path.join(root, `${job.brief.taskId}.js`), `// ${job.brief.taskId}\n`)
  await git(root, 'add', '-A'); await git(root, 'commit', '-q', '-m', `${job.brief.taskId} done`)
  return { exitCode: 0, result: { kind: 'task', id: job.brief.taskId, outcome: 'completed', pushed: false, next: 'implementation' } }
}

test('agents가 미정이면 --provider 없는 loop는 시작하지 않고 needs-init으로 끝난다 (dry-run·CLI 포함)', async (t) => {
  const { root, initial } = await fixture(t)
  const never = { execute: () => assert.fail('no unit'), preflight: () => assert.fail('no preflight'), catalog: () => assert.fail('no catalog'), claim: () => assert.fail('no claim') }
  for (const dryRun of [false, true]) {
    const result = await vibeLoop({ targetRoot: root, tag: 'route1', dryRun }, never)
    assert.deepEqual([result.ok, result.reason, result.hint, result.unset, result.modelRequests], [false, 'needs-init', HINT, ['agents'], 0])
  }
  assert.deepEqual([await git(root, 'rev-parse', 'HEAD'), await git(root, 'status', '--porcelain')], [initial, ''])
  const run = await promisify(execFile)(process.execPath, [cli, 'vibe', 'loop', '--tag', 'route1', '--target', root, '--json']).then(() => assert.fail('exit 0'), (error) => error)
  assert.equal(run.code, 1)
  assert.deepEqual([JSON.parse(run.stdout).reason, JSON.parse(run.stdout).hint], ['needs-init', HINT])
  // A person's explicit --provider (or a command adapter) runs without agents: the task's run: as written.
  await plan(root, { T001: 'claude/sonnet@high', T002: 'codex/sol@high' })
  const pinned = await vibeLoop({ targetRoot: root, tag: 'route1', provider: 'claude', dryRun: true }, never)
  assert.deepEqual(pinned.routing.map(({ task, run, source }) => [task, run, source]), [['T001', 'claude/sonnet@high', 'explicit'], ['T002', 'claude', 'explicit'], ['T003', 'claude', 'explicit']])
  await assert.rejects(vibeLoop({ targetRoot: root, tag: 'route1', model: 'opus', dryRun: true }, never), /--model은 --provider와 함께/)
  await assert.rejects(vibeLoop({ targetRoot: root, tag: 'route1', provider: 'claude', effort: 'huge', dryRun: true }, never), /--effort/)
})

test('loop는 단위마다 그 태스크의 run:을 agents 안에서 배정해 실행기에 넘기고 dispatch·이벤트·보고서에 남긴다', async (t) => {
  const { root } = await fixture(t)
  // T002 asks for an effort Codex lacks (terra@max = 8): the nearest allowed score runs instead.
  await plan(root, { T001: 'codex/sol@high', T002: 'codex/terra@max' }, 'claude,codex')
  const seen = []
  const deps = { catalog: catalog(['claude', 'codex']), preflight: passed, execute: complete(root, seen) }
  const dry = await vibeLoop({ targetRoot: root, tag: 'route2', dryRun: true }, { ...deps, execute: () => assert.fail('no unit') })
  assert.deepEqual([dry.provider, dry.agents, dry.modelRequests], ['route', ['claude', 'codex'], 0])
  assert.deepEqual(dry.routing.map(({ task, recommended, run, source }) => [task, recommended, run, source]), [
    ['T001', 'codex/sol@high', 'codex/sol@high', 'task'],
    ['T002', 'codex/terra@max', 'claude/sonnet@max', 'nearest'],
    // No run: the first allowed tool at its own setting (model and effort left to the person's config).
    ['T003', null, 'claude', 'default'],
  ])
  assert.equal(dry.routing[1].skipped[0].reason, 'effort-unsupported')
  const result = await vibeLoop({ targetRoot: root, tag: 'route2', maxUnits: 3 }, deps)
  assert.equal(result.ok, true, result.error)
  const routes = Object.fromEntries(seen.map(({ task, route }) => [task, route]))
  assert.deepEqual(routes, {
    T001: { tool: 'codex', model: 'sol', effort: 'high', source: 'task', recommended: 'codex/sol@high' },
    T002: { tool: 'claude', model: 'sonnet', effort: 'max', source: 'nearest', recommended: 'codex/terra@max' },
    T003: { tool: 'claude', model: null, effort: null, source: 'default', recommended: null },
  })
  const manifest = JSON.parse(await readFile(result.manifest, 'utf8'))
  assert.deepEqual(Object.fromEntries(manifest.dispatches.map((entry) => [entry.task, entry.route])), routes)
  const events = (await readFile(path.join(path.dirname(result.manifest), 'events.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line)).filter((event) => event.type === 'unit-route')
  assert.deepEqual(Object.fromEntries(events.map((event) => [event.task, event.route])), routes)
  // The report's done line names what ran; where routing moved it, recommended → actual.
  const report = await readFile(path.join(root, result.report), 'utf8')
  assert.match(report, /- task T001: completed · codex\/sol@high \(/)
  assert.match(report, /- task T002: completed · codex\/terra@max → claude\/sonnet@max \(/)
  assert.match(report, /- task T003: completed · claude \(/)
})

test('agents의 도구를 하나도 쓸 수 없으면 loop는 preflight 전에 이유와 함께 멈춘다', async (t) => {
  const { root } = await fixture(t)
  await plan(root, {}, 'codex')
  const offline = () => buildCatalog({ claude: CLAUDE, codex: { ...CODEX, loggedIn: false } }, ['codex'])
  await assert.rejects(vibeLoop({ targetRoot: root, tag: 'route3' }, { catalog: offline, preflight: () => assert.fail('no preflight') }), (error) => /실행할 수 있는 것이 없습니다/.test(error.message) && error.details.includes('codex: not-logged-in'))
})

test('내장 어댑터 단위는 route의 도구·모델·에포트로 실행된다 (Claude: --effort와 env, ultra→max)', async (t) => {
  const { root, temporary, initial } = await fixture(t)
  const bin = path.join(temporary, 'bin'); await mkdir(bin)
  const record = path.join(temporary, 'claude-call.json')
  await writeFile(path.join(bin, 'claude'), `#!${process.execPath}\nconst a=process.argv.slice(2);if(a.includes('--help'))console.log('--print');else{process.stdin.resume();process.stdin.on('end',()=>{require('node:fs').writeFileSync(${JSON.stringify(record)},JSON.stringify({args:a,effort:process.env.CLAUDE_CODE_EFFORT_LEVEL??null}));console.log(JSON.stringify({type:'result',is_error:false,structured_output:{kind:'none',id:'',outcome:'no_work',pushed:false,next:'stop'}}))})}`, { mode: 0o755 })
  const directory = path.join(temporary, 'logs'); await mkdir(directory)
  // The user's shell exported a different level: the routed one still wins.
  const r = await executeVibeUnit({ tag: 'route4', env: { PATH: `${bin}${path.delimiter}${process.env.PATH}`, CLAUDE_CODE_EFFORT_LEVEL: 'low' } },
    { workspace: root, role: 'unit', diffBase: initial, route: { tool: 'claude', model: 'opus', effort: 'ultra', source: 'task', recommended: 'claude/opus@ultra' } }, directory, { stopFile: path.join(directory, 'STOP'), deadline: Date.now() + 60000, timeoutMs: 60000 })
  assert.equal(r.result?.outcome, 'no_work', r.error)
  const call = JSON.parse(await readFile(record, 'utf8'))
  const flag = (key) => call.args[call.args.indexOf(key) + 1]
  assert.deepEqual([flag('--model'), flag('--effort'), call.effort], ['opus', 'max', 'max'])
})
