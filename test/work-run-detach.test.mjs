import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath, access } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { startWork, releaseWork } from '../src/work-groups.mjs'
import { runWork, detachWork, workRunStatus, stopWorkRun, recoverRunner, workRunHost, workRun } from '../src/work-runner.mjs'
import { pruneWork, dispatchLogDir } from '../src/prune.mjs'
import { inspectWorkspace } from '../src/workspace.mjs'
import { runtimeRoot, readRuntime, transaction } from '../src/work-runtime.mjs'

const execute = promisify(execFile)
const cli = fileURLToPath(new URL('../bin/gusta.mjs', import.meta.url))
const git = (cwd, ...args) => execute('git', ['-C', cwd, ...args], { encoding: 'utf8' })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const exists = (file) => access(file).then(() => true, () => false)
const alive = (pid) => { try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' } }
const task = (id) => `# ${id} example\n> st:todo | ssot:ARCH-1 | base:ARCH@1 | dep:-\n\n## goal\nimplement ${id}\n\n## acceptance\n- [ ] result exists\n\n## impl notes\n- -\n\n## result\n`
const checks = ['node -e "0"']
// A deadline, not an iteration count: under the full parallel suite a runner can take far longer to reach a step.
const until = async (read, done, label, ms = 60000) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const value = await read()
    if (done(value)) return value
    await sleep(25)
  }
  assert.fail(`timed out waiting: ${label}`)
}

async function fixture(t) {
  const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), 'gusta-work-detach-')))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const root = path.join(temporary, 'repo')
  await mkdir(path.join(root, 'spec/tasks'), { recursive: true })
  await mkdir(path.join(root, 'spec/ssot'), { recursive: true })
  await git(temporary, 'init', '-q', '-b', 'trunk', root)
  for (const [key, value] of [['user.name', 'Test'], ['user.email', 'test@example.com'], ['commit.gpgsign', 'false'], ['core.hooksPath', path.join(temporary, 'no-hooks')]]) await git(root, 'config', key, value)
  await writeFile(path.join(root, 'spec/FORMAT.md'), '# FORMAT\n')
  await writeFile(path.join(root, 'spec/STATE.md'), '# STATE\n\n## cfg\n- level: expert\n- lang: ko\n- docs: en\n\n## ssot\n| id | rev | tasked | pending | [?] |\n|---|---|---|---|---|\n| ARCH | 1 | 1 | - | 0 |\n\n## tasks\n| id | title | ssot | dep | st |\n|---|---|---|---|---|\n| T001 | first | ARCH | - | todo |\n| T002 | second | ARCH | - | todo |\n\n## next\n- gusta-implement-task T001\n\n## log\n')
  await writeFile(path.join(root, 'spec/ssot/ARCH.md'), '# ARCH architecture\n> r1 | architecture\n\n## decisions\n- ARCH-1 [o] runtime: node\n\n## chg\n- r1 260924 initial\n')
  await writeFile(path.join(root, 'spec/tasks/T001.first.md'), task('T001'))
  await writeFile(path.join(root, 'spec/tasks/T002.second.md'), task('T002'))
  await git(root, 'add', '-A')
  await git(root, 'commit', '-q', '-m', 'spec')
  // A command adapter: completes the task, or (GUSTA_TEST_HOLD) prints a line and hangs until killed.
  const adapter = path.join(temporary, 'adapter.mjs')
  await writeFile(adapter, `import fs from 'node:fs'; import {execFileSync} from 'node:child_process';
let input=''; for await(const chunk of process.stdin) input+=chunk;
const job=JSON.parse(input);
if(process.env.GUSTA_TEST_HOLD){console.log('live '+job.taskId);setInterval(()=>{},1000)}
else if(process.env.GUSTA_TEST_FAIL){process.stderr.write(JSON.stringify({type:'assistant',text:'TRANSCRIPT '+'x'.repeat(20000)})+'\\n'+'broken '+job.taskId+'\\n'+JSON.stringify({type:'user',text:'TRANSCRIPT tail'})+'\\n');process.exit(3)}
else if(job.role==='worker'){
 const file='spec/tasks/'+fs.readdirSync('spec/tasks').find(name=>name.startsWith(job.taskId+'.'));
 const text=fs.readFileSync(file,'utf8').replace('- [ ]','- [v]');
 fs.writeFileSync(file,text.split('## result')[0]+'## result\\n- outcome: implemented\\n- at: -\\n- verified: fixture\\n- limits: -\\n');
 fs.writeFileSync(job.taskId+'.txt','done');
 execFileSync('git',['add','.']);execFileSync('git',['commit','-q','-m','implement '+job.taskId]);
 console.log(JSON.stringify({outcome:'completed',summary:'done'}));
} else console.log(JSON.stringify({verdict:'approved',summary:'reviewed',findings:[]}));`)
  const config = path.join(temporary, 'adapter.json')
  await writeFile(config, JSON.stringify({ command: process.execPath, args: [adapter] }))
  const runtime = runtimeRoot(await inspectWorkspace({ targetRoot: root }))
  return { temporary, root, targetRoot: root, adapter: config, runtime }
}
const env = (extra = {}) => ({ ...process.env, GUSTA_NO_AWAKE: '1', ...extra })
const killGroup = (pid) => { try { process.kill(-pid, 'SIGKILL') } catch {} }

test('work run --detach: 준비 확인 뒤 반환하고, --status는 파일만 읽고, --stop은 정상 종료 경로로 멈추며 결과가 남는다; 중복 시작은 거부', async (t) => {
  const setup = await fixture(t)
  await startWork({ ...setup, name: 'night', workers: 1 })
  const run = (...args) => execute(process.execPath, [cli, 'work', 'run', '--work', 'night', '--target', setup.root, '--json', ...args], { encoding: 'utf8', env: env({ GUSTA_TEST_HOLD: '1' }) })
  const started = JSON.parse((await run('--detach', '--adapter', setup.adapter, '--verify', checks[0])).stdout)
  t.after(() => { try { process.kill(started.pid, 'SIGKILL') } catch {} })
  assert.equal(started.ok, true)
  assert.ok(started.runId && started.pid && started.log.startsWith(path.join(setup.runtime, 'logs')), JSON.stringify(started))
  // Ownership is acknowledged before the CLI returns: the runner record is already the host's.
  const runner = (await readRuntime(setup.runtime)).groups.night.runner
  assert.equal(runner.id, started.runId)
  assert.equal(runner.pid, started.pid)

  const status = await until(() => workRunStatus({ ...setup, work: 'night' }), (value) => value.dispatches[0]?.status === 'running', 'running dispatch')
  assert.equal(status.state, 'running')
  assert.equal(status.running, true)
  assert.equal(status.log, started.log)
  const [dispatch] = status.dispatches
  assert.equal(dispatch.taskId, 'T001')
  assert.equal(path.dirname(dispatch.log), dispatchLogDir(setup.runtime, dispatch.attempt))
  await until(() => readFile(dispatch.log, 'utf8').catch(() => ''), (text) => text.includes('live T001'), 'live dispatch log')
  assert.ok(!JSON.stringify(await workRunStatus({ ...setup, work: 'night' })).includes('live T001'), 'status names logs, never their content')

  // One runner per group: a second start is refused before any host is spawned.
  await assert.rejects(detachWork({ ...setup, work: 'night', adapter: setup.adapter, verify: checks, env: env() }), /이미/)

  const stopped = JSON.parse((await run('--stop')).stdout)
  assert.deepEqual([stopped.ok, stopped.signal, stopped.pid], [true, 'SIGTERM', started.pid])
  const after = await until(() => workRunStatus({ ...setup, work: 'night' }), (value) => value.state === 'stopped' && value.result, 'final result')
  assert.equal(after.running, false)
  assert.equal(after.outcome, 'interrupted')
  assert.equal(after.result.outcome, 'interrupted')
  assert.equal(after.log, started.log)
  assert.deepEqual(after.dispatches, [])
  const state = await readRuntime(setup.runtime)
  assert.equal(state.groups.night.runner, undefined)
  const attempt = Object.values(state.attempts)[0]
  assert.equal(attempt.status, 'blocked')
  assert.equal(attempt.dispatch.status, 'finished')
  await until(() => alive(attempt.dispatch.pid) || alive(started.pid), (value) => !value, 'host and provider exited')
  // The interrupted unit is not merged: its dispatch log stays.
  assert.ok(await exists(dispatch.log))
  await assert.rejects(stopWorkRun({ ...setup, work: 'night' }), /runner가 없습니다/)
  assert.match((await readFile(started.log, 'utf8')), /interrupted/)
})

test('work run --detach: 끝난 실행의 결과를 --status로 보고, 합쳐진 단위의 dispatch 로그는 정리된다', async (t) => {
  const setup = await fixture(t)
  await startWork({ ...setup, name: 'done' })
  const started = await detachWork({ ...setup, work: 'done', adapter: setup.adapter, verify: checks, env: env() })
  t.after(() => { try { process.kill(started.pid, 'SIGKILL') } catch {} })
  const status = await until(() => workRunStatus({ ...setup, work: 'done' }), (value) => value.state === 'stopped' && value.result, 'final result')
  assert.equal(status.outcome, 'completed')
  assert.equal(status.result.outcome, 'completed', JSON.stringify(status))
  assert.equal(status.result.failures, 0)
  assert.equal(status.result.remaining, 0)
  const full = JSON.parse(await readFile(status.result.file, 'utf8'))
  const attempts = Object.values((await readRuntime(setup.runtime)).attempts)
  assert.equal(attempts.length, 2)
  for (const attempt of attempts) {
    assert.equal(attempt.status, 'integrated')
    assert.ok(full.pruned.pruned.includes(dispatchLogDir(setup.runtime, attempt.id)), JSON.stringify(full.pruned))
    assert.equal(await exists(dispatchLogDir(setup.runtime, attempt.id)), false)
  }
})

test('work run --status: 죽은 호스트의 runner 기록은 host-lost로 보고하고 신호를 보내지 않는다', async (t) => {
  const setup = await fixture(t)
  await startWork({ ...setup, name: 'lost', workers: 1 })
  const started = await detachWork({ ...setup, work: 'lost', adapter: setup.adapter, verify: checks, env: env({ GUSTA_TEST_HOLD: '1' }) })
  const running = await until(() => workRunStatus({ ...setup, work: 'lost' }), (value) => value.dispatches[0]?.status === 'running', 'running dispatch')
  const { pid: provider, log } = Object.values((await readRuntime(setup.runtime)).attempts)[0].dispatch
  t.after(() => killGroup(provider))
  // Kill the host while it idles, not inside a runtime transaction (that would leave its lock).
  await until(async () => (await readFile(log, 'utf8').catch(() => '')).includes('live T001') && !(await exists(path.join(setup.runtime, 'lock'))), Boolean, 'idle host')
  process.kill(started.pid, 'SIGKILL')
  await until(async () => alive(started.pid), (value) => !value, 'host killed')
  const lost = await workRunStatus({ ...setup, work: 'lost' })
  assert.deepEqual([lost.state, lost.running, lost.runId], ['host-lost', false, running.runId])
  assert.match(lost.next, /runner-recover/)
  await assert.rejects(stopWorkRun({ ...setup, work: 'lost' }), /이미 종료/)
  await assert.rejects(detachWork({ ...setup, work: 'lost', adapter: setup.adapter, verify: checks, env: env() }), /이미/)
  killGroup(provider)
  await until(async () => alive(provider), (value) => !value, 'provider killed')
  await recoverRunner({ ...setup, work: 'lost' })
  const recovered = await workRunStatus({ ...setup, work: 'lost' })
  assert.deepEqual([recovered.state, recovered.outcome, recovered.result], ['stopped', 'recovered', null])
})

test('work run --stop: heartbeat가 멈춘 기록이나 다른 호스트에는 신호를 보내지 않는다 (주입된 kill·시계)', async (t) => {
  const setup = await fixture(t)
  await startWork({ ...setup, name: 'manual' })
  const startedAt = new Date(Date.now() - 120000).toISOString()
  await transaction(setup.runtime, (state) => { state.groups.manual.runner = { id: 'r1', pid: process.pid, host: os.hostname(), startedAt, heartbeatAt: startedAt } })
  const sent = []
  const kill = (...args) => sent.push(args)
  assert.equal((await workRunStatus({ ...setup, work: 'manual' })).state, 'heartbeat-stale')
  await assert.rejects(stopWorkRun({ ...setup, work: 'manual' }, { kill }), /heartbeat-stale/)
  const fresh = await stopWorkRun({ ...setup, work: 'manual' }, { kill, now: () => Date.parse(startedAt) + 1000 })
  assert.equal(fresh.runId, 'r1')
  assert.deepEqual(sent, [[process.pid, 'SIGTERM']])
  await transaction(setup.runtime, (state) => { state.groups.manual.runner.host = 'elsewhere' })
  await assert.rejects(stopWorkRun({ ...setup, work: 'manual' }, { kill, now: () => Date.parse(startedAt) }), /unknown-host/)
  assert.equal(sent.length, 1)
})

test('prune: 합쳐지지 않은(차단·해제) 단위의 dispatch 로그는 보존하고 해제 단위는 한 번만 보고한다', async (t) => {
  const setup = await fixture(t)
  await startWork({ ...setup, name: 'broken', workers: 1 })
  const result = await runWork({ ...setup, work: 'broken', adapter: setup.adapter, verify: checks, env: env({ GUSTA_TEST_FAIL: '1' }) })
  assert.ok(result.failures.length)
  const attempts = Object.values((await readRuntime(setup.runtime)).attempts)
  assert.ok(attempts.length && attempts.every((attempt) => attempt.status === 'blocked'))
  const logs = attempts.map((attempt) => dispatchLogDir(setup.runtime, attempt.id))
  for (const dir of logs) assert.ok(await exists(dir))
  assert.match(await readFile(attempts[0].dispatch.log, 'utf8'), /broken/)
  // Blocked units are in progress: nothing of theirs is pruned.
  assert.ok(!result.pruned.pruned.some((entry) => logs.includes(entry)))
  for (const attempt of attempts) await releaseWork({ ...setup, attempt: attempt.id })
  const released = await pruneWork({ ...setup, work: 'broken' })
  assert.deepEqual(released.cleaned.sort(), attempts.map((attempt) => attempt.id).sort())
  assert.deepEqual(released.kept.filter((entry) => /dispatch/.test(entry.reason)).map((entry) => entry.path).sort(), [...logs].sort())
  for (const dir of logs) assert.ok(await exists(dir))
  const again = await pruneWork({ ...setup, work: 'broken' })
  assert.deepEqual(again, { cleaned: [], pruned: [], kept: [] })
})

test('호스트: 신호는 runner의 정상 종료로 넘기고(등록 전이어도) 결과 JSON을 남긴다 (주입된 runWork)', async (t) => {
  const setup = await fixture(t)
  const config = path.join(setup.temporary, 'host.json'), resultFile = path.join(setup.temporary, 'run.json')
  await writeFile(config, JSON.stringify({ result: resultFile, options: { work: 'w', runId: 'r1' } }))
  const result = await workRunHost(config, { runWork: async (options) => { process.emit('SIGTERM'); return { outcome: options.stopSignal.aborted ? 'interrupted' : 'completed' } } })
  assert.equal(result.outcome, 'interrupted')
  assert.equal(await exists(config), false, 'the 0600 config is consumed')
  assert.deepEqual((({ outcome, runId, work }) => ({ outcome, runId, work }))(JSON.parse(await readFile(resultFile, 'utf8'))), { outcome: 'interrupted', runId: 'r1', work: 'w' })
  assert.equal(process.listenerCount('SIGTERM'), 0)
  await writeFile(config, JSON.stringify({ result: resultFile, options: { work: 'w', runId: 'r2' } }))
  await workRunHost(config, { runWork: async () => { throw new Error('bad provider') } })
  assert.deepEqual((({ ok, error, runId }) => ({ ok, error, runId }))(JSON.parse(await readFile(resultFile, 'utf8'))), { ok: false, error: 'bad provider', runId: 'r2' })
  // A stop requested before the runner registered its handlers still ends the run without dispatching.
  await startWork({ ...setup, name: 'early' })
  const aborted = AbortSignal.abort()
  const early = await runWork({ ...setup, work: 'early', adapter: setup.adapter, verify: checks, env: env(), stopSignal: aborted })
  assert.deepEqual([early.outcome, early.dispatched], ['interrupted', 0])
  await assert.rejects(workRun({ ...setup, work: 'early', status: true, stop: true }), /함께 지정할 수 없습니다/)
})

test('dispatch 기록은 로그 내용을 담지 않고 실패 이유만 남긴다; 예전 기록의 stderr도 CLI 출력에 실리지 않는다', async (t) => {
  const setup = await fixture(t)
  await startWork({ ...setup, name: 'quiet', workers: 1 })
  await runWork({ ...setup, work: 'quiet', adapter: setup.adapter, verify: checks, env: env({ GUSTA_TEST_FAIL: '1' }), maxDispatches: 1 })
  const [attempt] = Object.values((await readRuntime(setup.runtime)).attempts)
  assert.equal(attempt.dispatch.stderr, undefined)
  assert.equal(attempt.dispatch.error, 'adapter exited 3: broken T001')
  assert.ok(!(await readFile(path.join(setup.runtime, 'state.json'), 'utf8')).includes('TRANSCRIPT'), 'worker output stays in the log file')
  assert.match(await readFile(attempt.dispatch.log, 'utf8'), /TRANSCRIPT tail/)
  // A record written before this change still holds a tail: no work action prints it.
  await transaction(setup.runtime, (state) => { state.attempts[attempt.id].dispatch.stderr = 'LEGACY-TRANSCRIPT' })
  const work = (...args) => execute(process.execPath, [cli, 'work', ...args, '--target', setup.root, '--json'], { encoding: 'utf8' })
  for (const args of [['status'], ['board', '--work', 'quiet'], ['release', '--attempt', attempt.id]]) {
    const { stdout } = await work(...args)
    assert.ok(stdout.includes(attempt.dispatch.log), `${args.join(' ')} names the log`)
    assert.ok(!stdout.includes('LEGACY-TRANSCRIPT'), args.join(' '))
  }
})

// A group gate that records its PID and beats `<marker>.beat`, then runs until the test drops
// `release` (or `ms` passes), so how long it runs never depends on machine load. `; true` makes
// every shell fork node instead of exec'ing it, as dash does on Linux: stopping only the shell
// would leave the gate running.
const gate = (marker, ms, release = '') => `node -e "const fs=require('fs'); fs.writeFileSync('${marker}', String(process.pid)); const end=Date.now()+${ms}; const t=setInterval(()=>{ fs.writeFileSync('${marker}.beat', String(Date.now())); if (Date.now()>end || ('${release}' && fs.existsSync('${release}'))) clearInterval(t) }, 50)"; true`
// A stopped command stops beating; a PID check would count an unreaped zombie as alive.
const stillBeating = async (marker) => {
  const before = await readFile(`${marker}.beat`, 'utf8').catch(() => '')
  await sleep(300)
  return (await readFile(`${marker}.beat`, 'utf8').catch(() => '')) !== before
}

test('묶음 최종 검증 중의 stop은 검증 명령을 멈추고 실행을 interrupted로 끝낸다', async (t) => {
  const setup = await fixture(t)
  await startWork({ ...setup, name: 'gate-stop' })
  const marker = path.join(setup.temporary, 'gate.pid')
  const stop = new AbortController()
  const running = runWork({ ...setup, work: 'gate-stop', adapter: setup.adapter, verify: checks, groupVerify: [gate(marker, 120000)], env: env(), stopSignal: stop.signal })
  running.catch(() => {})
  await until(() => readFile(`${marker}.beat`, 'utf8').catch(() => ''), Boolean, 'group gate started')
  const stopped = Date.now()
  stop.abort()
  const result = await running
  assert.equal(result.outcome, 'interrupted', JSON.stringify(result))
  assert.ok(result.finishError, 'the gate did not pass')
  assert.equal(result.finish, null)
  assert.ok(Date.now() - stopped < 60000, 'the gate command did not run to its end')
  assert.equal(await stillBeating(marker), false, 'the gate command (forked by the shell) kept running after stop')
  assert.equal((await readRuntime(setup.runtime)).groups['gate-stop'].lastRun.outcome, 'interrupted')
})

test('heartbeat는 묶음 최종 검증 동안에도 이어져 긴 관문이 stale로 보이지 않는다', async (t) => {
  const setup = await fixture(t)
  await startWork({ ...setup, name: 'gate-beat' })
  const marker = path.join(setup.temporary, 'gate.pid')
  const release = path.join(setup.temporary, 'gate.release')
  const running = runWork({ ...setup, work: 'gate-beat', adapter: setup.adapter, verify: checks, groupVerify: [gate(marker, 120000, release)], env: env(), heartbeatMs: 100 })
  running.catch(() => {})
  await until(() => readFile(marker, 'utf8').catch(() => ''), Boolean, 'group gate started')
  const gateStarted = Date.now()
  const runner = await until(async () => (await readRuntime(setup.runtime)).groups['gate-beat'].runner, (value) => !value || Date.parse(value.heartbeatAt ?? 0) > gateStarted, 'heartbeat during the gate')
  assert.ok(runner, 'the runner record was still held during the gate')
  const status = await workRunStatus({ ...setup, work: 'gate-beat' }, { now: () => gateStarted + 1000 })
  assert.equal(status.state, 'running')
  await writeFile(release, '')
  const result = await running
  assert.equal(result.outcome, 'completed', JSON.stringify(result))
  assert.equal(result.heartbeatError, null)
  assert.ok(result.finish)
})
