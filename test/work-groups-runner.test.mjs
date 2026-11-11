import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { startWork, claimNextWork, inspectWork, updateWork, commitWorkerWork, submitWork, workBoard } from '../src/work-groups.mjs'
import { claimReview, finishReview } from '../src/work-review.mjs'
import { runWork, recoverRunner } from '../src/work-runner.mjs'
import { inspectWorkspace } from '../src/workspace.mjs'
import { runtimeRoot, transaction, readRuntime } from '../src/work-runtime.mjs'
import { execute, cli, git, checkFile, checks, fixture, implement, expandTasks, providerStubs } from './helpers/work-fixture.mjs'

test('실행기가 워커를 보충하고 수정→재리뷰→통합을 완료한다 (Orca 불필요)', async (t) => {
  const setup = await fixture(t)
  await expandTasks(setup, 6)
  const group = await startWork({ ...setup, name: 'runner' })
  const adapter = path.join(setup.temporary, 'adapter.mjs')
  await writeFile(adapter, `import fs from 'node:fs'; import {execFileSync} from 'node:child_process';
let input=''; for await(const chunk of process.stdin) input+=chunk;
const job=JSON.parse(input);
if(job.role==='worker') {
 const file='spec/tasks/'+fs.readdirSync('spec/tasks').find(name=>name.startsWith(job.taskId+'.'));
 let text=fs.readFileSync(file,'utf8').replace('- [ ]','- [v]');
 text=text.split('## result')[0]+'## result\\n- outcome: implemented\\n- at: -\\n- verified: pending\\n- limits: -\\n';
 fs.writeFileSync(file,text); fs.writeFileSync(job.taskId+'.txt',job.correction?'corrected':'implemented');
 execFileSync('git',['add','.']);execFileSync('git',['commit','-m','implement '+job.taskId]);
 process.stdout.write(JSON.stringify({outcome:'completed'}));
} else {
 const fix=job.taskId==='T001'&&fs.readFileSync('T001.txt','utf8')!=='corrected';
 process.stdout.write(JSON.stringify({verdict:fix?'changes_requested':'approved',summary:fix?'fix edge case':'reviewed',findings:fix?[{priority:'P2',where:'T001.txt:1',message:'handle edge case'}]:[]}));
}`)
  const config = path.join(setup.temporary, 'adapter.json')
  await writeFile(config, JSON.stringify({ command: process.execPath, args: [adapter], maxTaskRuns: 12 }))
  const result = await runWork({ ...setup, work: group.id, adapter: config, verify: [checkFile('spec/ssot/ARCH.md')] })
  assert.deepEqual(result.failures, [])
  assert.equal(result.attempts.length, 6)
  assert.ok(result.attempts.every((entry) => entry.status === 'integrated'), JSON.stringify(result))
  assert.ok(result.dispatched >= 14)
  const board = await workBoard({ ...setup, work: group.id })
  assert.equal(board.doneIds.length, 6)
  assert.equal(board.tasks.length, 0)
  assert.equal(board.group.runner, undefined)
  assert.equal(await readFile(path.join(group.path, 'T001.txt'), 'utf8'), 'corrected')
})

test('어댑터 실패는 작업을 보존하고 runner 중복 실행과 live 복구를 거부한다', async (t) => {
  const setup = await fixture(t)
  const group = await startWork({ ...setup, name: 'failed-runner' })
  const config = path.join(setup.temporary, 'adapter.json')
  await writeFile(config, JSON.stringify({ command: process.execPath, args: ['-e', 'process.exit(3)'] }))
  const result = await runWork({ ...setup, work: group.id, adapter: config, verify: checks })
  assert.ok(result.failures.length)
  assert.ok(result.attempts.every((entry) => entry.status === 'blocked'))
  const runtime = runtimeRoot(await inspectWorkspace(setup))
  await transaction(runtime, (state) => { state.groups[group.id].runner = { id: 'live', pid: process.pid, host: os.hostname() } })
  await assert.rejects(runWork({ ...setup, work: group.id, adapter: config, verify: checks }), /이미/)
  await assert.rejects(recoverRunner({ ...setup, work: group.id }), /실행 중/)
})

test('runner는 긴 워커의 heartbeat를 갱신하고 timeout 뒤 프로세스와 선점을 정리한다', async (t) => {
  const setup = await fixture(t)
  const group = await startWork({ ...setup, name: 'heartbeat', workers: 1 })
  const config = path.join(setup.temporary, 'timeout.json')
  await writeFile(config, JSON.stringify({ command: process.execPath, args: ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], timeoutMs: 11000, maxDispatches: 1 }))
  const result = await runWork({ ...setup, work: group.id, adapter: config, verify: checks })
  assert.equal(result.heartbeatError, null)
  assert.equal(result.outcome, 'dispatch-limit')
  const state = await inspectWork(setup)
  assert.equal(state.groups[0].runner, undefined)
  assert.equal(state.attempts[0].status, 'blocked')
  assert.match(state.attempts[0].reason, /timeout/)
  assert.ok(Date.parse(state.attempts[0].heartbeatAt) - Date.parse(state.attempts[0].createdAt) > 5000)
  assert.throws(() => process.kill(state.attempts[0].dispatch.pid, 0), { code: 'ESRCH' })
})

test('존재하지 않는 어댑터 명령은 가짜 완료를 만들지 않는다', async (t) => {
  const setup = await fixture(t)
  const group = await startWork({ ...setup, name: 'missing-adapter' })
  const config = path.join(setup.temporary, 'missing.json')
  await writeFile(config, JSON.stringify({ command: path.join(setup.temporary, 'does-not-exist'), args: [] }))
  const result = await runWork({ ...setup, work: group.id, adapter: config, verify: checks })
  assert.equal(result.outcome, 'needs-attention')
  assert.ok(result.failures.length)
  assert.ok(result.attempts.every((entry) => entry.status === 'blocked'))
})

test('CLI runner 종료 신호는 실행한 워커를 멈추고 미완료 작업을 보존한다', async (t) => {
  const setup = await fixture(t)
  await startWork({ ...setup, name: 'stop-runner', workers: 1 })
  const config = path.join(setup.temporary, 'stop.json')
  await writeFile(config, JSON.stringify({ command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] }))
  let child
  const completion = new Promise((resolve, reject) => {
    child = execFile(process.execPath, [cli, 'work', 'run', '--work', 'stop-runner', '--target', setup.root, '--adapter', config, '--verify', checks[0], '--json'], { encoding: 'utf8' }, (error, stdout) => error ? reject(error) : resolve(JSON.parse(stdout)))
  })
  t.after(() => { if (child.exitCode === null) child.kill('SIGTERM') })
  const runtime = runtimeRoot(await inspectWorkspace(setup))
  let dispatch
  for (let i = 0; i < 500 && !dispatch?.pid; i += 1) {
    dispatch = Object.values((await readRuntime(runtime)).attempts)[0]?.dispatch
    if (!dispatch?.pid) await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.ok(dispatch?.pid)
  child.kill('SIGTERM')
  const result = await completion
  assert.equal(result.outcome, 'interrupted')
  assert.equal(result.attempts[0].status, 'blocked')
  assert.throws(() => process.kill(dispatch.pid, 0), { code: 'ESRCH' })
  assert.equal((await readRuntime(runtime)).groups['stop-runner'].runner, undefined)
})

test('기본 실행기는 미커밋 Codex 결과를 호스트에서 커밋하고 Claude 리뷰 뒤 통합한다', async (t) => {
  const setup = await fixture(t)
  const group = await startWork({ ...setup, name: 'builtin', workers: 2 })
  const env = await providerStubs(setup, `
if(!Array.isArray(job.cliCommand)||!fs.existsSync(job.cliCommand[1]))throw Error('missing CLI command');
if(job.role==='worker') {
 const file='spec/tasks/'+fs.readdirSync('spec/tasks').find(name=>name.startsWith(job.taskId+'.'));
 let text=fs.readFileSync(file,'utf8').replace('- [ ]','- [v]');
 text=text.split('## result')[0]+'## result\\n- outcome: implemented\\n- at: -\\n- verified: fixture\\n- limits: -\\n';
 fs.writeFileSync(file,text);fs.writeFileSync(job.taskId+'.txt',job.correction?'corrected':'implemented');
 fs.writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify({outcome:'completed',summary:'edits ready'}));
 console.log(JSON.stringify({type:'thread.started'}));
} else {
 if(!fs.existsSync(job.taskId+'.txt'))throw Error('worker edits were not committed');
 const fix=job.taskId==='T001'&&fs.readFileSync('T001.txt','utf8')!=='corrected';
 console.log(JSON.stringify({type:'result',is_error:false,structured_output:{verdict:fix?'changes_requested':'approved',summary:fix?'fix edge case':'reviewed',findings:fix?[{priority:'P2',where:'T001.txt:1',message:'handle edge case'}]:[]}}));
}`)
  const args = [cli, 'work', 'run', '--target', setup.root, '--work', group.id, '--provider', 'codex', '--reviewer-provider', 'claude', '--model', 'worker model', '--reviewer-model', 'reviewer model', '--max-task-runs', '12', '--verify', checkFile('spec/ssot/ARCH.md'), '--json']
  const runtime = runtimeRoot(await inspectWorkspace(setup))
  const before = await readRuntime(runtime)
  const treesBefore = (await git(setup.root, 'worktree', 'list', '--porcelain')).stdout
  const preview = JSON.parse((await execute(process.execPath, [...args, '--dry-run'], { env })).stdout)
  assert.equal(preview.modelRequests, 0)
  assert.equal(preview.adapter.roles.worker.model, 'worker model')
  assert.equal(preview.adapter.roles.reviewer.provider, 'claude')
  assert.equal(preview.adapter.roles.reviewer.model, 'reviewer model')
  assert.deepEqual(await readRuntime(runtime), before)
  assert.equal((await git(setup.root, 'worktree', 'list', '--porcelain')).stdout, treesBefore)
  const result = JSON.parse((await execute(process.execPath, args, { env, timeout: 60000 })).stdout)
  assert.equal(result.outcome, 'completed', JSON.stringify(result))
  assert.deepEqual(result.failures, [])
  assert.equal(result.attempts.length, 3)
  assert.ok(result.attempts.every((entry) => entry.status === 'integrated'))
  assert.equal(await readFile(path.join(group.path, 'T001.txt'), 'utf8'), 'corrected')
  const state = await readRuntime(runtime)
  assert.equal(state.groups[group.id].lastRun.providers.worker.provider, 'codex')
  assert.equal(state.groups[group.id].lastRun.providers.reviewer.provider, 'claude')
  const log = (await git(group.path, 'log', '--format=%s')).stdout
  assert.match(log, /Implement T001/)
  assert.match(log, /Integrate T003/)
  assert.equal((await git(setup.root, 'rev-parse', 'HEAD')).stdout.trim(), setup.initial)
})

test('호스트 자동 커밋은 범위 밖 spec·미완료 acceptance·예상 밖 HEAD를 보존하고 차단한다', async (t) => {
  const setup = await fixture(t)
  const group = await startWork({ ...setup, name: 'host-commit' })
  const attempt = await claimNextWork({ ...setup, work: group.id, owner: 'worker' })
  const options = { ...setup, attempt: attempt.id, expectedHead: setup.initial }
  const file = path.join(attempt.workspace, 'spec/tasks/T001.first.md')
  const completed = (await readFile(file, 'utf8')).replace('- [ ]', '- [v]') + '- outcome: edited\n- at: -\n- verified: fixture\n- limits: -\n'
  const outside = path.join(attempt.workspace, 'spec/extra.md')
  await writeFile(file, completed)
  await writeFile(outside, 'preserve untracked planning')
  await assert.rejects(commitWorkerWork(options), /자신의 태스크 외/)
  assert.equal(await readFile(outside, 'utf8'), 'preserve untracked planning')
  assert.equal((await git(attempt.workspace, 'diff', '--cached', '--name-only')).stdout, '')
  await rm(outside)
  await updateWork({ ...setup, attempt: attempt.id, status: 'doing' })
  await writeFile(file, completed.replace('- [v]', '- [ ]'))
  await assert.rejects(commitWorkerWork(options), /acceptance/)
  assert.equal((await git(attempt.workspace, 'rev-parse', 'HEAD')).stdout.trim(), setup.initial)
  await writeFile(file, completed)
  await git(attempt.workspace, 'commit', '--allow-empty', '-m', 'unexpected agent commit')
  const moved = (await git(attempt.workspace, 'rev-parse', 'HEAD')).stdout.trim()
  await updateWork({ ...setup, attempt: attempt.id, status: 'doing' })
  await assert.rejects(commitWorkerWork(options), /HEAD가 변경/)
  assert.equal((await git(attempt.workspace, 'rev-parse', 'HEAD')).stdout.trim(), moved)
  assert.equal(await readFile(file, 'utf8'), completed)
  assert.equal((await inspectWork(setup)).attempts[0].status, 'blocked')
})

test('기본 실행기 timeout은 래퍼와 실제 provider 자식을 모두 종료한다', async (t) => {
  const setup = await fixture(t)
  const group = await startWork({ ...setup, name: 'provider-timeout', workers: 1 })
  const env = await providerStubs(setup, `fs.writeFileSync('provider.pid',String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`)
  const result = JSON.parse((await execute(process.execPath, [cli, 'work', 'run', '--target', setup.root, '--work', group.id, '--provider', 'codex', '--timeout-ms', '1000', '--max-dispatches', '1', '--verify', checks[0], '--json'], { env, timeout: 15000 })).stdout)
  assert.equal(result.outcome, 'dispatch-limit')
  assert.equal(result.attempts[0].status, 'blocked')
  assert.match(result.attempts[0].reason, /timeout/)
  const attempt = (await inspectWork(setup)).attempts[0]
  const pid = Number(await readFile(path.join(attempt.workspace, 'provider.pid'), 'utf8'))
  for (let index = 0; index < 100; index += 1) {
    try { process.kill(pid, 0) } catch (error) { if (error.code === 'ESRCH') break; throw error }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
  assert.throws(() => process.kill(attempt.dispatch.pid, 0), { code: 'ESRCH' })
  assert.equal((await git(attempt.workspace, 'rev-parse', 'HEAD')).stdout.trim(), setup.initial)
})

test('기본 실행기는 미완료 변경이 남은 수정 공간에 새 모델을 시작하지 않는다', async (t) => {
  const setup = await fixture(t)
  const group = await startWork({ ...setup, name: 'dirty-correction', workers: 1 })
  const attempt = await claimNextWork({ ...setup, work: group.id, owner: 'worker' })
  await implement(attempt)
  await submitWork({ ...setup, attempt: attempt.id, verify: checks })
  const review = await claimReview({ ...setup, work: group.id, owner: 'reviewer' })
  await finishReview({ ...setup, review: review.id, result: { verdict: 'changes_requested', summary: 'fix it', findings: [{ priority: 'P2', where: 'one.txt:1', message: 'handle edge case' }] } })
  await writeFile(path.join(attempt.workspace, 'preserve.txt'), 'user draft')
  const env = await providerStubs(setup, `throw Error('must not start a model');`)
  const result = JSON.parse((await execute(process.execPath, [cli, 'work', 'run', '--target', setup.root, '--work', group.id, '--provider', 'codex', '--verify', checks[0], '--json'], { env, timeout: 15000 })).stdout)
  assert.equal(result.dispatched, 0)
  assert.equal(result.outcome, 'needs-attention')
  assert.equal(result.attempts[0].status, 'blocked')
  assert.match(result.attempts[0].reason, /미커밋/)
  assert.equal(await readFile(path.join(attempt.workspace, 'preserve.txt'), 'utf8'), 'user draft')
})
