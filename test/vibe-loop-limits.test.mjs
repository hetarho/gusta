import test from 'node:test'
import { vibeLoop } from './helpers/unit-policy.mjs'
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fixture, git, archiveTask } from './helpers/vibe-fixture.mjs'
import { executeVibeUnit } from '../src/vibe-loop.mjs'
import { buildCatalog } from '../src/agent-catalog.mjs'
import { inspectWorkspace } from '../src/workspace.mjs'
import { runtimeRoot } from '../src/work-runtime.mjs'
import { readLimits, OVERLOAD_RETRY_MS, LIMIT_POLL_MS, LIMIT_EXIT } from '../src/provider-limits.mjs'

// A usage limit ends an attempt, not a unit: the loop moves the same task to the next combination SETTINGS
// agents allows, waits for a reset without a model call when nothing is left, or stops on usage-limit.
// Units, sleeps and the clock are injected: no provider runs, no real wait.
const CLAUDE = { installed: true, loggedIn: true, models: ['haiku', 'sonnet', 'opus', 'fable'].map((model) => ({ model, efforts: ['low', 'medium', 'high', 'xhigh', 'max'], context: null })) }
const CODEX = { installed: true, loggedIn: true, models: ['luna-mini', 'terra', 'sol', 'astra'].map((model, priority) => ({ model, efforts: ['low', 'medium', 'high', 'xhigh'], context: 272000, priority })) }
const passed = async () => ({ ok: true, checks: [] })
const label = (route) => `${route.tool}${route.model ? `/${route.model}` : ''}`

async function setup(t, agents) {
  const made = await fixture(t)
  await writeFile(path.join(made.root, 'spec/SETTINGS.md'), `# SETTINGS\n- agents: ${agents}\n`)
  await git(made.root, 'add', '-A'); await git(made.root, 'commit', '-q', '-m', 'agents')
  const runtime = runtimeRoot(await inspectWorkspace({ targetRoot: made.root }))
  return { ...made, runtime }
}
// The injected clock: only the loop's own sleeps move it.
function clock() {
  const state = { now: Date.now(), sleeps: [] }
  return { state, deps: { now: () => state.now, sleep: async (ms) => { state.sleeps.push(ms); state.now += ms }, checkpoint: async () => ({}) } }
}
// scripted(task, attempt, job): 'complete', or a failure the adapter would report ({kind, tool, ...}).
function units(root, scripted) {
  const calls = []
  const execute = async (_options, job) => {
    const task = job.brief.taskId, attempt = calls.filter((call) => call.task === task).length + 1
    calls.push({ task, route: label(job.route), recovery: job.recovery ?? null })
    const step = await scripted(task, attempt, job)
    if (step !== 'complete') return { exitCode: 75, stopped: null, error: `${step.kind}: ${step.message}`, result: null, failure: { scope: 'tool', message: 'limit', ...step } }
    await archiveTask(root, task)
    await writeFile(path.join(root, `${task}.js`), `// ${task}\n`)
    await git(root, 'add', '-A'); await git(root, 'commit', '-q', '-m', `${task} done`)
    return { exitCode: 0, result: { kind: 'task', id: task, outcome: 'completed', pushed: false, next: 'implementation' } }
  }
  return { calls, execute }
}
const events = async (result) => (await readFile(path.join(path.dirname(result.manifest), 'events.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line))

test('한도에 걸린 단위는 같은 태스크를 agents 안 다음 후보로 바로 다시 띄우고, 단위·사다리·관문·실패 횟수에 세지 않는다', async (t) => {
  const { root, runtime } = await setup(t, 'claude,codex')
  const { state, deps } = clock()
  const resetAt = new Date(state.now + 2 * 3600000).toISOString()
  const { calls, execute } = units(root, async (task, attempt) => {
    // T001's first attempt leaves uncommitted work, then hits Claude's session limit.
    if (task === 'T001' && attempt === 1) { await writeFile(path.join(root, 'half.js'), '// half\n'); return { kind: 'usage-limit', tool: 'claude', resetAt } }
    return 'complete'
  })
  const result = await vibeLoop({ targetRoot: root, tag: 'lim1', maxUnits: 3 }, { ...deps, catalog: () => buildCatalog({ claude: CLAUDE, codex: CODEX }, ['claude', 'codex']), preflight: passed, execute })
  assert.equal(result.ok, true, result.error)
  // No run: → the first tool at its own setting; the limit moves T001 and the later tasks to Codex's own setting.
  assert.deepEqual(calls.map(({ task, route }) => [task, route]), [['T001', 'claude'], ['T001', 'codex'], ['T002', 'codex'], ['T003', 'codex']])
  // The new session restores the attempt's uncommitted work from its snapshot (cause usage-limit), not a rung.
  const handed = calls[1].recovery
  assert.deepEqual([handed.reason, handed.cause, handed.taskId, handed.cuts], ['interrupted', 'usage-limit', 'T001', undefined])
  assert.deepEqual(handed.snapshot.files, ['half.js'])
  // Three units within max-units 3: the limited attempt was not one. No failure streak, rung or gate failure.
  assert.deepEqual([result.units, result.reason, result.gate.failures, result.recovery], [3, 'max-units', 0, null])
  const manifest = JSON.parse(await readFile(result.manifest, 'utf8'))
  assert.deepEqual(manifest.dispatches.map((entry) => entry.limit ?? entry.result.outcome), ['usage-limit', 'completed', 'completed', 'completed'])
  assert.deepEqual(manifest.usageLimits.map(({ task, route, kind, tool, resetAt: at }) => [task, route, kind, tool, at]), [['T001', 'claude', 'usage-limit', 'claude', resetAt]])
  assert.ok(manifest.time.units.limit, 'the limited attempt has its own time line')
  const seen = await events(result)
  assert.deepEqual(seen.filter((event) => event.type === 'limit-hit').map(({ task, kind, tool }) => [task, kind, tool]), [['T001', 'usage-limit', 'claude']])
  assert.deepEqual(seen.filter((event) => event.type === 'route-fallback').map(({ task, from, to, reason }) => [task, from, to, reason]), [['T001', 'claude', 'codex', 'usage-limit']])
  assert.ok(!seen.some((event) => ['unit-cut', 'task-parked'].includes(event.type)))
  // The block is in the clone's shared record until its reset; the snapshot went with the finished task.
  assert.deepEqual((await readLimits(runtime)).entries.map(({ tool, reason, resetAt: at, source }) => [tool, reason, at, source]), [['claude', 'usage-limit', resetAt, 'reported']])
  assert.equal(await git(root, 'for-each-ref', 'refs/gusta/units'), '')
  const report = await readFile(path.join(root, result.report), 'utf8')
  assert.match(report, /- task T001: completed · codex \(← claude limit, resets (\d{2}-\d{2} )?\d{2}:\d{2}\) \(/)
  assert.match(report, /- task T002: completed · codex \(/)
})

test('모든 후보가 막히고 리셋이 작업 시간 안이면 모델 호출 없이 기다렸다가 같은 태스크를 다시 띄운다', async (t) => {
  const { root } = await setup(t, 'claude')
  const { state, deps } = clock()
  const started = state.now
  // No reset in the message: a guessed 30 minutes.
  const { calls, execute } = units(root, async (task, attempt) => task === 'T001' && attempt === 1 ? { kind: 'usage-limit', tool: 'claude' } : 'complete')
  const result = await vibeLoop({ targetRoot: root, tag: 'lim2', maxUnits: 1 }, { ...deps, catalog: () => buildCatalog({ claude: CLAUDE }, ['claude']), preflight: passed, execute })
  assert.equal(result.ok, true, result.error)
  assert.deepEqual(calls.map(({ task, route }) => [task, route]), [['T001', 'claude'], ['T001', 'claude']])
  // Minute-long sleeps up to the reset, nothing else ran meanwhile.
  assert.ok(state.sleeps.length >= 30 && state.sleeps.every((ms) => ms <= LIMIT_POLL_MS), JSON.stringify(state.sleeps))
  assert.ok(state.now - started >= 30 * 60000)
  const seen = await events(result)
  const wait = seen.find((event) => event.type === 'limit-wait')
  assert.equal(wait.limits[0].tool, 'claude'); assert.equal(wait.limits[0].source, 'estimated')
  assert.deepEqual([result.units, result.reason], [1, 'max-units'])
  assert.match(await readFile(path.join(root, result.report), 'utf8'), /- task T001: completed · claude \(← claude limit, resets ~(\d{2}-\d{2} )?\d{2}:\d{2}\) \(/)
})

test('리셋이 작업 시간 밖이면 usage-limit으로 멈추고(마감 관문·보고서는 그대로) 같은 clone의 다음 loop는 그 기록을 보고 다른 도구로 간다', async (t) => {
  const { root, runtime } = await setup(t, 'claude')
  const { state, deps } = clock()
  const resetAt = new Date(state.now + 3 * 3600000).toISOString()
  const first = units(root, async () => ({ kind: 'usage-limit', tool: 'claude', resetAt }))
  const stopped = await vibeLoop({ targetRoot: root, tag: 'lim3', maxHours: 1 }, { ...deps, catalog: () => buildCatalog({ claude: CLAUDE }, ['claude']), preflight: passed, execute: first.execute })
  assert.deepEqual([stopped.ok, stopped.reason, stopped.units, first.calls.length], [true, 'usage-limit', 0, 1])
  assert.match(stopped.hint, /^claude (\d{2}-\d{2} )?\d{2}:\d{2}까지 사용량 한도 — 그 뒤 다시 실행하세요$/)
  assert.equal(state.sleeps.length, 0, 'no wait for a reset past the work window')
  const report = await readFile(path.join(root, stopped.report), 'utf8')
  assert.match(report, /- loop stopped: usage-limit — claude .*까지 사용량 한도/)
  // The owner's notice asks for attention: the run names when to rerun.
  const terminal = JSON.parse(await readFile(path.join(path.dirname(stopped.manifest), 'terminal-event.json'), 'utf8'))
  assert.deepEqual([terminal.level, terminal.reason, terminal.hint], ['attention', 'usage-limit', stopped.hint])
  assert.equal((await events(stopped)).filter((event) => event.type === 'limit-stop').length, 1)
  // Another loop of this clone (another tag, Codex now allowed) never sends T002 to Claude.
  await writeFile(path.join(root, 'spec/SETTINGS.md'), '# SETTINGS\n- agents: claude,codex\n')
  await git(root, 'add', '-A'); await git(root, 'commit', '-q', '-m', 'allow codex')
  const second = units(root, async () => 'complete')
  const catalog = () => buildCatalog({ claude: CLAUDE, codex: CODEX }, ['claude', 'codex'])
  const dry = await vibeLoop({ targetRoot: root, tag: 'lim4', tasks: 'T002', dryRun: true }, { ...deps, catalog })
  assert.deepEqual([dry.routing[0].run, dry.routing[0].skipped.some((entry) => entry.reason === 'usage-limit')], ['codex', true])
  const next = await vibeLoop({ targetRoot: root, tag: 'lim4', tasks: 'T002' }, { ...deps, catalog, preflight: passed, execute: second.execute })
  assert.equal(next.ok, true, next.error)
  assert.deepEqual(second.calls.map(({ task, route }) => [task, route]), [['T002', 'codex']])
  assert.equal((await readLimits(runtime)).entries.length, 1)
})

test('과부하는 차단하지 않고 같은 후보로 한 번 짧게 다시 띄운 뒤 다음 후보로 간다', async (t) => {
  const { root, runtime } = await setup(t, 'claude,codex')
  const { state, deps } = clock()
  const { calls, execute } = units(root, async (task, attempt) => task === 'T001' && attempt <= 2 ? { kind: 'overloaded', tool: 'claude', scope: null } : 'complete')
  const result = await vibeLoop({ targetRoot: root, tag: 'lim5', maxUnits: 1 }, { ...deps, catalog: () => buildCatalog({ claude: CLAUDE, codex: CODEX }, ['claude', 'codex']), preflight: passed, execute })
  assert.equal(result.ok, true, result.error)
  assert.deepEqual(calls.map(({ route }) => route), ['claude', 'claude', 'codex'])
  assert.deepEqual(state.sleeps, [OVERLOAD_RETRY_MS])
  assert.deepEqual((await readLimits(runtime)).entries, [], 'an overload is not a recorded block')
  assert.deepEqual([result.units, result.reason], [1, 'max-units'])
})

test('로그인 실패는 그 도구를 이번 실행에서 빼고 다음 후보로 가며, 결정함에 로그인 필요를 남긴다', async (t) => {
  const { root, runtime } = await setup(t, 'claude,codex')
  const { deps } = clock()
  const { calls, execute } = units(root, async (task, attempt) => task === 'T001' && attempt === 1 ? { kind: 'auth', tool: 'claude', message: 'Invalid API key · Please run /login' } : 'complete')
  const result = await vibeLoop({ targetRoot: root, tag: 'lim6', maxUnits: 2 }, { ...deps, catalog: () => buildCatalog({ claude: CLAUDE, codex: CODEX }, ['claude', 'codex']), preflight: passed, execute })
  assert.equal(result.ok, true, result.error)
  assert.deepEqual(calls.map(({ task, route }) => [task, route]), [['T001', 'claude'], ['T001', 'codex'], ['T002', 'codex']])
  assert.deepEqual((await readLimits(runtime)).entries, [])
  const report = await readFile(path.join(root, result.report), 'utf8')
  assert.match(report, /## parked\n- \d{6} parked -: claude needs a login: a headless unit failed sign-in \(Invalid API key · Please run \/login\)\./)
})

test('내장 어댑터 단위의 한도 실패는 종료 코드 75와 failure로 receipt에 실린다', async (t) => {
  const { root, temporary, initial } = await fixture(t)
  const bin = path.join(temporary, 'bin'); await mkdir(bin)
  await writeFile(path.join(bin, 'claude'), `#!${process.execPath}\nconst a=process.argv.slice(2);if(a.includes('--help'))console.log('--print');else{process.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({type:'rate_limit_event',rate_limit_info:{status:'rejected',rateLimitType:'five_hour'}}));console.log(JSON.stringify({type:'result',is_error:true,result:"You've hit your session limit · resets 3:45pm"}));process.exitCode=1})}`, { mode: 0o755 })
  const directory = path.join(temporary, 'logs'); await mkdir(directory)
  const receipt = await executeVibeUnit({ tag: 'lim7', env: { PATH: `${bin}${path.delimiter}${process.env.PATH}` } },
    { workspace: root, role: 'unit', diffBase: initial, route: { tool: 'claude', model: null, effort: null, source: 'default', recommended: null } }, directory, { stopFile: path.join(directory, 'STOP'), deadline: Date.now() + 60000, timeoutMs: 60000 })
  assert.deepEqual([receipt.exitCode, receipt.result, receipt.failure.kind, receipt.failure.scope, receipt.failure.tool], [LIMIT_EXIT, null, 'usage-limit', 'tool', 'claude'])
  // "resets 3:45pm" in the machine's local time.
  assert.deepEqual([new Date(receipt.failure.resetAt).getHours(), new Date(receipt.failure.resetAt).getMinutes()], [15, 45])
  assert.match(receipt.error, /^usage-limit: /)
})
