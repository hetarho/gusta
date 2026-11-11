import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { startWork, updateWork, submitWork, workBoard } from '../src/work-groups.mjs'
import { nextWork } from '../src/work-wait.mjs'
import { runWork } from '../src/work-runner.mjs'
import { lintSpec } from '../src/spec-lint.mjs'
import { inspectWorkspace } from '../src/workspace.mjs'
import { runtimeRoot, readRuntime } from '../src/work-runtime.mjs'

const execute = promisify(execFile)
const cli = fileURLToPath(new URL('../bin/haeram-spec-creator.mjs', import.meta.url))
const git = (cwd, ...args) => execute('git', ['-C', cwd, ...args], { encoding: 'utf8' })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const commit = async (cwd, message) => {
  await git(cwd, 'add', '-A')
  await git(cwd, 'commit', '-q', '-m', message)
  return (await git(cwd, 'rev-parse', 'HEAD')).stdout.trim()
}
const taskFile = (id, ssot, base) => `# ${id} example\n> st:todo | ssot:${ssot} | base:${base} | dep:- | touches:- | lane:-\n\n## goal\nimplement ${id}\n\n## acceptance\n- [ ] result exists\n\n## impl notes\n- -\n\n## result\n`

async function fixture(t) {
  const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), 'haeram-autopilot-')))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const root = path.join(temporary, 'repo')
  await mkdir(path.join(root, 'spec/tasks'), { recursive: true })
  await mkdir(path.join(root, 'spec/ssot'), { recursive: true })
  await git(temporary, 'init', '-q', '-b', 'trunk', root)
  for (const [key, value] of [['user.name', 'Test'], ['user.email', 'test@example.com'], ['commit.gpgsign', 'false'], ['core.hooksPath', path.join(temporary, 'no-hooks')]]) await git(root, 'config', key, value)
  await writeFile(path.join(root, 'spec/FORMAT.md'), '# FORMAT\n')
  await writeFile(path.join(root, 'spec/STATE.md'), '# STATE\n\n## cfg\n- level: expert\n- lang: ko\n- docs: en\n- push: trunk\n\n## ssot\n| id | rev | tasked | pending | [?] |\n|---|---|---|---|---|\n| ARCH | 1 | 1 | - | 0 |\n| ITEM | 1 | 1 | - | 0 |\n\n## tasks\n| id | title | ssot | dep | st |\n|---|---|---|---|---|\n| T001 | limits | ITEM | - | todo |\n| T002 | runtime | ARCH | - | todo |\n\n## next\n- implement-task\n\n## log\n- 261012 create-task ARCH ITEM\n')
  await writeFile(path.join(root, 'spec/ssot/ARCH.md'), '# ARCH architecture\n> r1 | architecture\n\n## decisions\n- ARCH-1 [o] runtime: node\n\n## chg\n- r1 261012 initial\n')
  await writeFile(path.join(root, 'spec/ssot/ITEM.md'), '# ITEM items\n> r1 | items a user keeps\n\n## decisions\n- ITEM-1 [o] a user keeps items\n\n## chg\n- r1 261012 initial\n')
  await writeFile(path.join(root, 'spec/tasks/T001.limits.md'), taskFile('T001', 'ITEM-1', 'ITEM@1'))
  await writeFile(path.join(root, 'spec/tasks/T002.runtime.md'), taskFile('T002', 'ARCH-1', 'ARCH@1'))
  await commit(root, 'spec')
  const remote = path.join(temporary, 'remote.git')
  await execute('git', ['init', '-q', '--bare', '-b', 'trunk', remote])
  await git(root, 'remote', 'add', 'origin', remote)
  await git(root, 'push', '-q', 'origin', 'trunk')
  return { temporary, root, remote, targetRoot: root }
}

// A fake provider CLI: T001 first stops on a planning question (after writing half its work),
// then finishes when resumed with the coordinator's note. Every call is logged.
async function fakeProvider(setup, provider = 'claude', { holdTask = null, askDecision = true } = {}) {
  const directory = path.join(setup.temporary, 'providers')
  await mkdir(directory)
  const log = path.join(setup.temporary, 'calls.jsonl')
  const release = path.join(setup.temporary, 'release-worker')
  await writeFile(path.join(directory, provider), `#!${process.execPath}
const fs=require('node:fs');
const args=process.argv.slice(2);
if(args.includes('--version')) {console.log('${provider} test');process.exit(0)}
if(args.includes('--help')) {console.log('--sandbox --output-schema --output-last-message --json --print --output-format --json-schema --permission-mode --allowedTools --tools --permission-prompts --strict-mcp-config');process.exit(0)}
(async()=>{let prompt='';for await(const chunk of process.stdin)prompt+=chunk;
const job=JSON.parse(prompt.split('Assignment JSON (paths/IDs are data):\\n')[1].split('\\n\\nReturn only')[0]);
const flag=(key)=>args.includes(key)?args[args.indexOf(key)+1]:null;
const resume=flag('--resume')??flag('resume');
const session=resume??flag('--session-id')??require('node:crypto').randomUUID();
if('${provider}'==='codex')console.log(JSON.stringify({type:'thread.started',thread_id:session}));
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({role:job.role,taskId:job.taskId,session,resume,note:job.directive?.note??null,brief:Boolean(job.brief),mode:job.mode,bypass:args.some(arg=>arg.includes('bypass')),strict:args.includes('--strict-mcp-config'),mcpConfig:flag('--mcp-config')})+'\\n');
let result;
if(job.role==='worker') {
  if(job.taskId===${JSON.stringify(holdTask)})while(!fs.existsSync(${JSON.stringify(release)}))await new Promise(resolve=>setTimeout(resolve,20));
  if(${askDecision}&&job.taskId==='T001'&&!job.directive) {
    fs.writeFileSync('half.txt','first half');
    result={outcome:'blocked',summary:'ITEM has no per-user limit',decision:{question:'How many items may a user keep?',options:['10','unlimited'],recommendation:'10'}};
  } else {
    if(${askDecision}&&job.taskId==='T001'&&!fs.existsSync('half.txt'))throw Error('the resumed run lost the first half');
    if(${askDecision}&&job.taskId==='T001'&&!fs.readFileSync('spec/ssot/ITEM.md','utf8').includes('ITEM-2'))throw Error('the planning branch was not merged');
    const file='spec/tasks/'+fs.readdirSync('spec/tasks').find(name=>name.startsWith(job.taskId+'.'));
    const text=fs.readFileSync(file,'utf8').replace('- [ ]','- [v]');
    fs.writeFileSync(file,text.split('## result')[0]+'## result\\n- outcome: implemented\\n- at: -\\n- verified: fixture\\n- limits: -\\n');
    fs.writeFileSync(job.taskId+'.txt','done');
    result={outcome:'completed',summary:'implemented '+job.taskId,decision:{question:'',options:[],recommendation:''}};
  }
} else result={verdict:'approved',summary:'reviewed',findings:[]};
if('${provider}'==='codex')fs.writeFileSync(flag('--output-last-message'),JSON.stringify(result));
else console.log(JSON.stringify({type:'result',is_error:false,structured_output:result}));
})().catch(error=>{console.error(error);process.exit(1)});
`, { mode: 0o755 })
  return { env: { ...process.env, PATH: `${directory}${path.delimiter}${process.env.PATH}`, HAERAM_NO_AWAKE: '1' }, log, release }
}

// What a coordinator does with a filed decision: provisional update-ssot in the planning
// checkout (rev+1, chg, refreshed task base, inbox line), then resume with a note.
async function answer(setup, group, decided) {
  const plan = group.path
  const edit = async (file, from, to) => {
    const target = path.join(plan, file)
    await writeFile(target, (await readFile(target, 'utf8')).replace(from, to))
  }
  await edit('spec/ssot/ITEM.md', '> r1 |', '> r2 |')
  await edit('spec/ssot/ITEM.md', '- ITEM-1 [o] a user keeps items\n', '- ITEM-1 [o] a user keeps items\n- ITEM-2 [o] a user keeps at most 10 items\n')
  await edit('spec/ssot/ITEM.md', '## chg\n', '## chg\n- r2 261013 ITEM-2+\n')
  await edit('spec/tasks/T001.limits.md', 'ssot:ITEM-1 | base:ITEM@1', 'ssot:ITEM-1 ITEM-2 | base:ITEM@2')
  await edit('spec/STATE.md', '| ITEM | 1 | 1 | - | 0 |', '| ITEM | 2 | 2 | - | 0 |')
  await edit('spec/STATE.md', '## ssot\n', `## inbox\n- 261013 decided ITEM-2 T001: ${decided.attempt.decision.question} → 10 (alt: unlimited)\n\n## ssot\n`)
  assert.deepEqual((await lintSpec({ targetRoot: plan })).errors, [])
  await commit(plan, 'update-ssot ITEM r2 (provisional)')
  return updateWork({ ...setup, attempt: decided.attempt.id, status: 'doing', note: 'ITEM-2 r2: a user keeps at most 10 items' })
}

for (const provider of ['claude', 'codex']) test(`맡김 ${provider}: 기획 공백이 생긴 워커는 결정을 요청하고 다른 일이 계속되며, 조정자가 잠정 결정하면 같은 세션이 이어서 끝낸다 (시나리오 b)`, async (t) => {
  const setup = await fixture(t)
  const { env, log } = await fakeProvider(setup, provider)
  const group = await startWork({ ...setup, name: 'auto', verify: ['node -e "0"'], push: 'trunk', allowTool: ['Bash(npm test *)'] })
  const running = runWork({ ...setup, work: group.id, provider, env, autopilot: true, pollMs: 50, decisionWaitMs: 60000 })
  // The coordinator loop: answer the filed decision, never wait for a person.
  let decided = null
  for (let round = 0; round < 1200 && !decided; round += 1) {
    const next = await nextWork({ ...setup, work: group.id, owner: 'coord', coordinator: true, autopilot: true })
    assert.ok(['wait', 'decide'].includes(next.action), JSON.stringify(next))
    if (next.action === 'decide') decided = next
    else await sleep(50)
  }
  assert.ok(decided, 'no decision was filed')
  assert.equal(decided.attempt.taskId, 'T001')
  assert.equal(decided.attempt.decision.recommendation, '10')
  assert.match(decided.instruction, /recommendation으로 update-ssot/)
  await answer(setup, group, decided)
  const result = await running
  assert.equal(result.outcome, 'completed', JSON.stringify(result))
  assert.deepEqual(result.failures, [])
  assert.deepEqual(result.decisions.map((entry) => entry.taskId), ['T001'])
  // The resumed run carried the session the first run created, plus the coordinator's note.
  const calls = (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line)).filter((call) => call.role === 'worker' && call.taskId === 'T001')
  assert.equal(calls.length, 2)
  assert.ok(calls[0].session)
  assert.equal(calls[1].resume, calls[0].session)
  assert.equal(calls[1].note, 'ITEM-2 r2: a user keeps at most 10 items')
  assert.ok(calls.every((call) => call.brief && call.mode === 'autopilot'))
  // Headless workers run with SETTINGS permission-mode (default bypass); reviewers stay read-only.
  const all = (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
  assert.ok(all.filter((call) => call.role === 'worker').every((call) => call.bypass))
  assert.ok(all.some((call) => call.role === 'reviewer') && all.filter((call) => call.role === 'reviewer').every((call) => !call.bypass))
  // SETTINGS headless-mcp (default isolate): Claude workers and reviewers load no MCP server and get
  // no --mcp-config; Codex has no such flag.
  assert.ok(all.every((call) => call.strict === (provider === 'claude') && call.mcpConfig === null))
  // Every landed unit is on the remote push branch, inbox line included; T001 was reviewed
  // (an autopilot decision makes it risky), and the half done before the question survived.
  const trunk = (await execute('git', ['--git-dir', setup.remote, 'show', 'trunk:spec/STATE.md'], { encoding: 'utf8' })).stdout
  assert.match(trunk, /- 261013 decided ITEM-2 T001/)
  assert.doesNotMatch(trunk, /\| T00[12] \|/)
  assert.equal((await execute('git', ['--git-dir', setup.remote, 'show', 'trunk:half.txt'], { encoding: 'utf8' })).stdout, 'first half')
  const board = await workBoard({ ...setup, work: group.id })
  const t001 = board.attempts.find((entry) => entry.taskId === 'T001')
  assert.equal(t001.review.owner.endsWith('/reviewer-1'), true)
  assert.ok(t001.risk.reasons.includes('autopilot decisions awaiting the owner'))
  const history = (await execute('git', ['--git-dir', setup.remote, 'log', '--format=%s', 'trunk'], { encoding: 'utf8' })).stdout
  assert.match(history, /WIP T001: waiting for a planning decision/)
})

test('맡김: 결정이 오지 않으면 실행기는 정해진 시간만 기다리고 decision-wait로 끝난다', async (t) => {
  const setup = await fixture(t)
  const { env } = await fakeProvider(setup)
  const group = await startWork({ ...setup, name: 'auto', verify: ['node -e "0"'] })
  const { stdout, stderr } = await execute(process.execPath, [cli, 'work', 'run', '--target', setup.root, '--work', group.id, '--provider', 'claude', '--autopilot', '--decision-wait-ms', '300', '--json'], { env, timeout: 60000 })
  const result = JSON.parse(stdout)
  assert.equal(result.outcome, 'decision-wait')
  assert.deepEqual(result.decisions.map((entry) => entry.taskId), ['T001'])
  const state = await readRuntime(runtimeRoot(await inspectWorkspace(setup)))
  const lastRun = state.groups[group.id].lastRun
  assert.equal(lastRun.decisionWaitMs, 300)
  const waiting = lastRun.decisionWait
  assert.deepEqual(waiting.attempts.map(({ attempt, taskId, question }) => ({ attempt, taskId, question })), [
    { attempt: result.decisions[0].attempt, taskId: 'T001', question: 'How many items may a user keep?' },
  ])
  assert.ok(waiting.startedAt && waiting.deadlineAt && waiting.attempts[0].requestedAt)
  assert.equal(stderr.trim(), `[work run] decision-wait ${JSON.stringify(waiting)}`)
  assert.equal(state.history.filter((event) => event.changes.runner?.decisionWait).length, 1, 'unchanged waits must not flood history')
  const snapshot = JSON.parse(await readFile(path.join(group.path, 'spec/work/auto.json'), 'utf8'))
  assert.deepEqual(snapshot.group.lastRun.decisionWait, waiting)
  const next = await nextWork({ ...setup, work: group.id, owner: 'coord', coordinator: true, autopilot: true })
  assert.equal(next.action, 'decide')
})

test('맡김 CLI: 기본 결정 대기는 15분이고 명시적인 값이 우선하며 함께 모드는 기존 설정을 유지한다 (Codex)', async (t) => {
  const setup = await fixture(t)
  const { env } = await fakeProvider(setup, 'codex')
  const group = await startWork({ ...setup, name: 'defaults', verify: ['node -e "0"'] })
  const args = [cli, 'work', 'run', '--target', setup.root, '--work', group.id, '--provider', 'codex', '--dry-run', '--json']
  for (const [flags, autopilot, expected] of [
    [['--autopilot'], true, 900000],
    [['--autopilot', '--decision-wait-ms', '1234'], true, 1234],
    [[], false, 7200000],
    [['--decision-wait-ms', '4321'], false, 4321],
  ]) {
    const preview = JSON.parse((await execute(process.execPath, [...args, ...flags], { env })).stdout)
    assert.equal(preview.autopilot, autopilot)
    assert.equal(preview.decisionWaitMs, expected)
    assert.equal(preview.permissionMode, 'bypass')
    assert.equal(preview.headlessMcp, 'isolate')
    assert.equal(preview.modelRequests, 0)
  }
})

async function unitCheck(setup) {
  const script = path.join(setup.temporary, 'unit-check.cjs')
  const log = path.join(setup.temporary, 'unit-checks.jsonl')
  await writeFile(script, `const fs=require('node:fs');
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({tasks:process.env.HAERAM_TASKS})+'\\n');
if(process.env.HAERAM_TASKS==='T002'&&fs.readFileSync('T002.txt','utf8')!=='fixed')throw Error('non-transient unit check failure');
`)
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`
  return { verify: [`${quote(process.execPath)} ${quote(script)}`], log }
}

async function waitForAttempt(runtime, predicate) {
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    const state = await readRuntime(runtime)
    const attempt = Object.values(state.attempts).find(predicate)
    if (attempt) return attempt
    await sleep(20)
  }
  assert.fail('the expected attempt transition did not occur')
}

for (const [provider, repaired] of [['claude', true], ['codex', true], ['codex', false]]) {
  test(`맡김 ${provider}: 통합 실패한 attempt를 재제출·재승인하면 같은 run에서 ${repaired ? '통합을 끝낸다' : '새 제출물도 한 번만 실패하고 재시도하지 않는다'}`, async (t) => {
    const setup = await fixture(t)
    // Keep another worker alive while the coordinator repairs and resubmits T002.
    const { env, release } = await fakeProvider(setup, provider, { holdTask: 'T001', askDecision: false })
    const { verify, log } = await unitCheck(setup)
    const group = await startWork({ ...setup, name: 'resubmit', verify, review: 'all' })
    const runtime = runtimeRoot(await inspectWorkspace(setup))
    const running = runWork({ ...setup, work: group.id, provider, env, autopilot: true, pollMs: 20 })
    // Handle early runner errors while inspecting the concurrent state; finally always drains it.
    running.catch(() => {})
    let failed, submitted
    try {
      failed = await waitForAttempt(runtime, (entry) => entry.taskId === 'T002' && entry.status === 'approved' && entry.reason)
      await writeFile(path.join(failed.workspace, 'T002.txt'), repaired ? 'fixed' : 'still failing')
      const fixedCommit = await commit(failed.workspace, 'Repair unit verification')
      submitted = await submitWork({ ...setup, attempt: failed.id })
      assert.equal(submitted.id, failed.id)
      assert.notEqual(submitted.submissionId, failed.submissionId)
      assert.notEqual(fixedCommit, failed.verifiedCommit)
    } finally {
      await writeFile(release, 'continue')
      await running
    }
    const result = await running
    assert.equal(result.outcome, repaired ? 'completed' : 'needs-attention', JSON.stringify(result))
    const failures = result.failures.filter((entry) => entry.role === 'integration')
    assert.deepEqual(failures.map((entry) => entry.submissionId), repaired ? [failed.submissionId] : [failed.submissionId, submitted.submissionId])
    assert.equal(failures[0].commit, failed.verifiedCommit)
    const state = await readRuntime(runtime)
    assert.equal(state.groups[group.id].lastRun.decisionWaitMs, 900000)
    assert.ok(state.history.some((event) => event.attemptId === failed.id && event.changes.review?.submissionId === submitted.submissionId && event.changes.review.status === 'approved'))
    const checks = (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    assert.equal(checks.filter((entry) => entry.tasks === 'T002').length, 2)
    if (!repaired) assert.ok(result.remaining.some((entry) => entry.attempt === failed.id && entry.runtimeStatus === 'approved'))
  })
}

test('맡김: 실패한 승인 제출물과 미응답 결정이 남으면 재시도·결정 대기 없이 needs-attention으로 끝난다', async (t) => {
  const setup = await fixture(t)
  const { env } = await fakeProvider(setup, 'codex')
  const { verify, log } = await unitCheck(setup)
  const group = await startWork({ ...setup, name: 'stalled', verify })
  // Without the idle guard this would return decision-wait after the configured interval.
  const result = await runWork({ ...setup, work: group.id, provider: 'codex', env, autopilot: true, pollMs: 20, decisionWaitMs: 300, maxDispatches: 3 })
  assert.equal(result.outcome, 'needs-attention', JSON.stringify(result))
  assert.equal(result.dispatched, 3, 'an exhausted dispatch budget must not hide the failed integration')
  const failure = result.failures.find((entry) => entry.role === 'integration')
  assert.ok(failure)
  assert.equal(result.failures.filter((entry) => entry.role === 'integration').length, 1)
  assert.deepEqual(result.remaining.map(({ id, runtimeStatus, attempt }) => ({ id, runtimeStatus, attempt })), [
    { id: 'T001', runtimeStatus: 'blocked', attempt: result.decisions[0].attempt },
    { id: 'T002', runtimeStatus: 'approved', attempt: failure.attempt },
  ])
  const state = await readRuntime(runtimeRoot(await inspectWorkspace(setup)))
  assert.equal(state.groups[group.id].lastRun.outcome, 'needs-attention')
  assert.equal(state.groups[group.id].lastRun.decisionWait, undefined)
  assert.equal(state.history.filter((event) => event.changes.runner?.decisionWait).length, 0)
  const checks = (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
  assert.equal(checks.filter((entry) => entry.tasks === 'T002').length, 1, 'the failed submission must not be retried')
})

test('맡김: timeout 직전 작업 공간을 스냅샷하고 진행분을 커밋한 뒤 같은 세션으로 이어 간다 (R9); dispatch 로그는 실행 중에 쌓인다', async (t) => {
  const setup = await fixture(t)
  const directory = path.join(setup.temporary, 'providers')
  await mkdir(directory)
  const log = path.join(setup.temporary, 'calls.jsonl')
  // T001's first run writes a measurement and then hangs past the limit.
  await writeFile(path.join(directory, 'claude'), `#!${process.execPath}
const fs=require('node:fs');
const args=process.argv.slice(2);
if(args.includes('--version')) {console.log('claude test');process.exit(0)}
if(args.includes('--help')) {console.log('--print --output-format --json-schema --permission-mode --allowedTools --tools --permission-prompts');process.exit(0)}
(async()=>{let prompt='';for await(const chunk of process.stdin)prompt+=chunk;
const job=JSON.parse(prompt.split('Assignment JSON (paths/IDs are data):\\n')[1].split('\\n\\nReturn only')[0]);
const flag=(key)=>args.includes(key)?args[args.indexOf(key)+1]:null;
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({role:job.role,taskId:job.taskId,session:flag('--session-id'),resume:flag('--resume'),note:job.directive?.note??null})+'\\n');
let result;
if(job.role==='worker') {
  if(job.taskId==='T001'&&!job.directive) { fs.writeFileSync('measured.txt','round 1: 36.2%'); console.log(JSON.stringify({type:'system',subtype:'init',marker:'live-T001'})); setInterval(()=>{},1000); return }
  if(job.taskId==='T001'&&fs.readFileSync('measured.txt','utf8')!=='round 1: 36.2%')throw Error('measurement lost');
  const file='spec/tasks/'+fs.readdirSync('spec/tasks').find(name=>name.startsWith(job.taskId+'.'));
  const text=fs.readFileSync(file,'utf8').replace('- [ ]','- [v]');
  fs.writeFileSync(file,text.split('## result')[0]+'## result\\n- outcome: implemented\\n- at: -\\n- verified: fixture\\n- limits: -\\n');
  result={outcome:'completed',summary:'done',decision:{question:'',options:[],recommendation:''}};
} else result={verdict:'approved',summary:'reviewed',findings:[]};
console.log(JSON.stringify({type:'result',is_error:false,structured_output:result}));
})().catch(error=>{console.error(error);process.exit(1)});
`, { mode: 0o755 })
  const env = { ...process.env, PATH: `${directory}${path.delimiter}${process.env.PATH}`, HAERAM_NO_AWAKE: '1' }
  const group = await startWork({ ...setup, name: 'auto', verify: ['node -e "0"'] })
  const runtime = runtimeRoot(await inspectWorkspace(setup))
  const running = runWork({ ...setup, work: group.id, provider: 'claude', env, autopilot: true, pollMs: 20, timeoutMs: 3000 })
  running.catch(() => {})
  // While the hung provider still runs, its dispatch record already names a log holding its output.
  let live = null
  try {
    for (let i = 0; i < 250 && !live; i++) {
      const entry = Object.values((await readRuntime(runtime)).attempts).find((value) => value.taskId === 'T001' && value.dispatch?.status === 'running')
      if (entry && (await readFile(entry.dispatch.log, 'utf8').catch(() => '')).includes('live-T001')) live = entry.dispatch
      else await sleep(20)
    }
  } finally { await running.catch(() => {}) }
  const result = await running
  assert.ok(live, 'the dispatch log shows provider output before the provider exits')
  assert.ok(!JSON.stringify((await readRuntime(runtime)).history).includes(live.log), 'local log paths stay out of history')
  assert.equal(result.outcome, 'completed', JSON.stringify(result))
  const calls = (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line)).filter((call) => call.role === 'worker' && call.taskId === 'T001')
  assert.equal(calls.length, 2)
  assert.equal(calls[1].resume, calls[0].session)
  assert.match(calls[1].note, /time limit/)
  const board = await workBoard({ ...setup, work: group.id })
  const attempt = board.attempts.find((entry) => entry.taskId === 'T001')
  // The board names the log; the merged unit's logs went with its prune.
  assert.ok(result.pruned.pruned.includes(path.dirname(attempt.dispatch.log)), JSON.stringify(result.pruned))
  await assert.rejects(readFile(attempt.dispatch.log, 'utf8'), { code: 'ENOENT' })
  assert.equal((await readRuntime(runtime)).attempts[attempt.id].dispatch.stderr, undefined, 'the record keeps no log content')
  // The snapshot ref lived until the run pruned the integrated unit (prune-branches default);
  // the measurement it protected is on the group branch.
  assert.ok(result.pruned.pruned.includes(`refs/haeram/checkpoints/${attempt.id}`), JSON.stringify(result.pruned))
  assert.ok(result.pruned.cleaned.includes(attempt.id))
  assert.equal((await git(setup.root, 'show', `${group.branch}:measured.txt`)).stdout, 'round 1: 36.2%')
  assert.match((await git(setup.root, 'log', '--format=%s', group.branch)).stdout, /WIP T001: checkpoint after the time limit/)
})
