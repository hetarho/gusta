import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { startWork, claimWork, inspectWork, updateWork, releaseWork, submitWork, integrateWork, cleanupWork, recoverWork, workBoard, workHistory, syncWork, runCheckCommand } from '../src/work-groups.mjs'
import { inspectWorkspace } from '../src/workspace.mjs'
import { pruneWork } from '../src/prune.mjs'
import { runtimeRoot, transaction, readRuntime, unlockRuntime } from '../src/work-runtime.mjs'
import { execute, cli, git, commit, checkFile, checks, fixture, implement, approve, ready } from './helpers/work-fixture.mjs'

test('Orca 없이 start→claim→submit→integrate→cleanup하고 dep은 통합 이후에만 열린다', async (t) => {
  const setup = await ready(t)
  const { group, attempt, root } = setup
  assert.equal(group.branch, 'work/feature')
  assert.equal(attempt.managed, true)
  assert.equal((await inspectWork({ targetRoot: root })).mode, 'single')
  assert.equal((await inspectWork({ targetRoot: group.path })).mode, 'group')
  assert.equal((await inspectWork({ targetRoot: attempt.workspace })).mode, 'worker')
  let board = await workBoard({ targetRoot: attempt.workspace, work: group.id })
  assert.equal(board.scope, 'work')
  assert.equal(board.tasks.find((entry) => entry.id === 'T001').runtimeStatus, 'approved')
  assert.equal(board.tasks.find((entry) => entry.id === 'T003').claimable, false)
  await assert.rejects(claimWork({ targetRoot: root, work: group.id, task: 'T003' }), /dep/)
  const integrated = await integrateWork({ targetRoot: root, attempt: attempt.id, verify: [...checks, checkFile('spec/tasks/done/T001.first.md')] })
  assert.equal(integrated.status, 'integrated')
  assert.equal((await git(group.path, 'rev-parse', 'HEAD')).stdout.trim(), integrated.integratedCommit)
  assert.equal((await git(root, 'rev-parse', 'HEAD')).stdout.trim(), setup.initial)
  assert.match(await readFile(path.join(group.path, 'spec/tasks/done/T001.first.md'), 'utf8'), new RegExp(`at: ${setup.sha}`))
  const progress = JSON.parse(await readFile(path.join(group.path, 'spec/work/feature.json'), 'utf8'))
  assert.equal(progress.summary.completed, 1)
  assert.equal(progress.summary.remaining, 2)
  assert.equal(progress.attempts[0].verifiedCommit, setup.sha)
  assert.match(await readFile(path.join(group.path, 'spec/STATE.md'), 'utf8'), /\[history\]\(work\/feature.json\)/)
  board = await workBoard({ targetRoot: root, work: group.id })
  assert.equal(board.tasks.find((entry) => entry.id === 'T003').claimable, true)
  const next = await claimWork({ targetRoot: root, work: group.id, task: 'T003' })
  await access(path.join(next.workspace, 'one.txt'))
  await releaseWork({ targetRoot: root, attempt: next.id })
  await cleanupWork({ targetRoot: root, attempt: next.id })
  const cleaned = await cleanupWork({ targetRoot: root, attempt: attempt.id })
  assert.ok(cleaned.cleanedAt)
  assert.deepEqual(cleaned.preservedCandidates, [])
  await assert.rejects(access(attempt.workspace), { code: 'ENOENT' })
  await access(group.path)
})

test('auto는 외부 linked worktree를 연결하고 current/new는 선택을 따른다', async (t) => {
  const setup = await fixture(t)
  const { root, temporary } = setup
  const group = await startWork({ ...setup, name: 'external' })
  const external = path.join(temporary, 'orca-or-any-tool')
  await git(root, 'worktree', 'add', '-b', 'arbitrary/provider-name', external, group.branch)
  const attempt = await claimWork({ targetRoot: external, work: group.id, task: 'T001' })
  assert.equal(attempt.managed, false)
  assert.equal(attempt.workspace, external)
  const other = await claimWork({ targetRoot: external, work: group.id, task: 'T002', workspace: 'new' })
  assert.equal(other.managed, true)
  assert.notEqual(other.workspace, external)
  await releaseWork({ targetRoot: root, attempt: attempt.id })
  assert.equal((await cleanupWork({ targetRoot: root, attempt: attempt.id })).workspaceRetained, true)
  await access(external)
  await assert.rejects(claimWork({ targetRoot: group.path, work: group.id, task: 'T001', workspace: 'current' }), /기획/)
})

test('start auto는 외부 linked branch를 그대로 기획 공간으로 수용한다', async (t) => {
  const setup = await fixture(t)
  const external = path.join(setup.temporary, 'external-plan')
  await git(setup.root, 'worktree', 'add', '-b', 'feature/from-tool', external)
  const group = await startWork({ targetRoot: external, name: 'adopted' })
  assert.equal(group.managed, false)
  assert.equal(group.branch, 'feature/from-tool')
  assert.equal(group.path, external)
})

test('detached 외부 공간은 보존하고 자동 배정은 별도 하위 브랜치를 만든다', async (t) => {
  const setup = await fixture(t)
  const group = await startWork({ ...setup, name: 'detached' })
  const external = path.join(setup.temporary, 'detached')
  await git(setup.root, 'worktree', 'add', '--detach', external, group.branch)
  const original = (await git(external, 'rev-parse', 'HEAD')).stdout.trim()
  await assert.rejects(claimWork({ targetRoot: external, work: group.id, task: 'T001', workspace: 'current' }), /하위 작업 브랜치/)
  const attempt = await claimWork({ targetRoot: external, work: group.id, task: 'T001' })
  assert.ok(attempt.branch); assert.equal(attempt.managed, true)
  assert.notEqual(attempt.workspace, external)
  await implement(attempt)
  const submitted = await submitWork({ ...setup, attempt: attempt.id, verify: checks })
  assert.equal(submitted.status, 'ready')
  assert.equal((await git(external, 'rev-parse', 'HEAD')).stdout.trim(), original)
  assert.equal((await git(external, 'status', '--porcelain')).stdout.trim(), '')
  await assert.rejects(git(external, 'symbolic-ref', '--quiet', 'HEAD'))
})

test('독립 프로세스의 동일 태스크 선점은 정확히 하나만 성공한다', async (t) => {
  const setup = await fixture(t)
  await startWork({ ...setup, name: 'race' })
  const call = () => execute(process.execPath, [cli, 'work', 'claim', 'T001', '--work', 'race', '--target', setup.root, '--json'], { encoding: 'utf8' })
  const outcomes = await Promise.allSettled([call(), call()])
  assert.equal(outcomes.filter((entry) => entry.status === 'fulfilled').length, 1)
  const loser = outcomes.find((entry) => entry.status === 'rejected')
  assert.match(JSON.parse(loser.reason.stdout).error, /선점/)
  assert.equal((await inspectWork(setup)).attempts.length, 1)
})

test('해제한 이전 attempt는 새 선점을 갱신하거나 해제할 수 없다', async (t) => {
  const setup = await fixture(t)
  await startWork({ ...setup, name: 'retry' })
  const first = await claimWork({ ...setup, work: 'retry', task: 'T001' })
  await releaseWork({ ...setup, attempt: first.id })
  const releasedHistory = await workHistory({ ...setup, work: 'retry' })
  await assert.rejects(updateWork({ ...setup, attempt: first.id, status: 'doing' }), /갱신/)
  assert.deepEqual(await workHistory({ ...setup, work: 'retry' }), releasedHistory)
  const second = await claimWork({ ...setup, work: 'retry', task: 'T001' })
  assert.notEqual(first.id, second.id)
  await assert.rejects(updateWork({ ...setup, attempt: first.id, status: 'doing' }), /갱신/)
  await assert.rejects(releaseWork({ ...setup, attempt: first.id }), /해제/)
  assert.equal((await inspectWork(setup)).attempts.find((entry) => entry.id === second.id).status, 'doing')
})

test('미커밋 작업과 미완료 acceptance는 ready로 제출되지 않는다', async (t) => {
  const setup = await fixture(t)
  await startWork({ ...setup, name: 'incomplete' })
  const attempt = await claimWork({ ...setup, work: 'incomplete', task: 'T001' })
  await assert.rejects(submitWork({ ...setup, attempt: attempt.id, verify: ['node -e "process.exit(0)"'] }), /acceptance/)
  await implement(attempt)
  await writeFile(path.join(attempt.workspace, 'uncommitted'), 'keep')
  await assert.rejects(submitWork({ ...setup, attempt: attempt.id, verify: checks }), /미커밋/)
})

test('워커의 STATE/SSOT 변경은 중앙 기획 문서로 조용히 통합되지 않는다', async (t) => {
  const setup = await fixture(t)
  await startWork({ ...setup, name: 'planning' })
  const attempt = await claimWork({ ...setup, work: 'planning', task: 'T001' })
  await implement(attempt, 'one.txt', { 'spec/STATE.md': '# changed\n' })
  await assert.rejects(submitWork({ ...setup, attempt: attempt.id, verify: checks }), /자신의 태스크 외/)
})

test('상위 SSOT 변경 후 낡은 워커는 다시 동기화해야 한다', async (t) => {
  const setup = await ready(t)
  const arch = path.join(setup.group.path, 'spec/ssot/ARCH.md')
  await writeFile(arch, (await readFile(arch, 'utf8')).replace('runtime: node', 'runtime: node 22'))
  await commit(setup.group.path)
  await assert.rejects(submitWork({ ...setup, attempt: setup.attempt.id, verify: checks }), /SSOT/)
})

test('검증 실패는 상위 브랜치를 변경하지 않고 후보를 보존한다', async (t) => {
  const setup = await ready(t)
  const before = (await git(setup.group.path, 'rev-parse', 'HEAD')).stdout
  await assert.rejects(integrateWork({ ...setup, attempt: setup.attempt.id, verify: ['node -e "process.exit(7)"'] }), /통합을 완료하지/)
  assert.equal((await git(setup.group.path, 'rev-parse', 'HEAD')).stdout, before)
  const attempt = (await inspectWork(setup)).attempts[0]
  assert.equal(attempt.status, 'approved')
  assert.equal(attempt.integrationVerification, null)
  await access(attempt.candidate)
  const retry = await integrateWork({ ...setup, attempt: setup.attempt.id, verify: checks })
  assert.equal(retry.status, 'integrated')
})

test('merge 충돌은 후보에만 남고 워커와 상위 checkout은 보존된다', async (t) => {
  const setup = await fixture(t)
  const group = await startWork({ ...setup, name: 'conflict' })
  const attempt = await claimWork({ ...setup, work: group.id, task: 'T001' })
  await implement(attempt, 'one.txt', { 'shared.txt': 'worker\n' })
  await submitWork({ ...setup, attempt: attempt.id, verify: checks })
  await writeFile(path.join(group.path, 'shared.txt'), 'parent\n')
  const before = await commit(group.path)
  await approve(setup, attempt)
  await assert.rejects(integrateWork({ ...setup, attempt: attempt.id, verify: checks }), /통합을 완료하지/)
  assert.equal((await git(group.path, 'rev-parse', 'HEAD')).stdout.trim(), before)
  assert.equal(await readFile(path.join(attempt.workspace, 'shared.txt'), 'utf8'), 'worker\n')
  assert.equal((await git(group.path, 'status', '--porcelain')).stdout, '')
})

test('검증 중 상위 브랜치가 이동하면 결과를 적용하지 않는다', async (t) => {
  const setup = await ready(t)
  const script = path.join(setup.temporary, 'move-parent.cjs')
  await writeFile(script, `const {execFileSync}=require('node:child_process');execFileSync('git',['-C',${JSON.stringify(setup.group.path)},'commit','--allow-empty','-m','parent moved'])`)
  await assert.rejects(integrateWork({ ...setup, attempt: setup.attempt.id, verify: [`node '${script.replaceAll("'", "'\\''")}'`] }), /통합을 완료하지/)
  assert.equal((await git(setup.group.path, 'log', '-1', '--format=%s')).stdout.trim(), 'parent moved')
  await access(path.join(setup.group.path, 'spec/tasks/T001.first.md'))
})

test('통합 후 정리는 미추적/ignored 파일과 추가 커밋을 보존한다', async (t) => {
  const setup = await ready(t)
  await integrateWork({ ...setup, attempt: setup.attempt.id, verify: checks })
  await writeFile(path.join(setup.attempt.workspace, 'keep.txt'), 'important')
  await assert.rejects(cleanupWork({ ...setup, attempt: setup.attempt.id }), /미커밋/)
  await access(path.join(setup.attempt.workspace, 'keep.txt'))
  await commit(setup.attempt.workspace)
  await assert.rejects(cleanupWork({ ...setup, attempt: setup.attempt.id }), /포함되지 않은/)
})

test('검증 명령이 코드를 바꾸면 ready로 기록하지 않는다', async (t) => {
  const setup = await ready(t)
  await assert.rejects(submitWork({ ...setup, attempt: setup.attempt.id, verify: ['node -e "require(\'fs\').writeFileSync(\'one.txt\',\'changed\')"'] }), /미커밋/)
  assert.equal((await inspectWork(setup)).attempts[0].status, 'blocked')
})

test('생성 실패가 기존 경로를 지우거나 현재 checkout을 전환하지 않는다', async (t) => {
  const setup = await fixture(t)
  const occupied = path.join(setup.temporary, 'occupied')
  await mkdir(occupied)
  await writeFile(path.join(occupied, 'keep'), 'data')
  await assert.rejects(startWork({ ...setup, name: 'failure', path: occupied }), /준비에 실패/)
  assert.equal(await readFile(path.join(occupied, 'keep'), 'utf8'), 'data')
  assert.equal((await git(setup.root, 'branch', '--show-current')).stdout.trim(), 'trunk')
})

test('손상된 runtime은 덮어쓰지 않고 살아있는 lock은 회수하지 않는다', async (t) => {
  const setup = await fixture(t)
  const runtime = runtimeRoot(await inspectWorkspace(setup))
  await mkdir(runtime, { recursive: true })
  await writeFile(path.join(runtime, 'state.json'), '{broken')
  await assert.rejects(startWork({ ...setup, name: 'broken' }), /손상/)
  assert.equal(await readFile(path.join(runtime, 'state.json'), 'utf8'), '{broken')
  await mkdir(path.join(runtime, 'lock'))
  await writeFile(path.join(runtime, 'lock/owner.json'), JSON.stringify({ id: 'live', pid: process.pid, host: os.hostname() }))
  await assert.rejects(unlockRuntime(runtime, 'wrong'), /일치하지/)
  await assert.rejects(unlockRuntime(runtime, 'live'), /실행 중/)
})

test('프로세스 중단 후 검증된 후보가 이미 반영됐다면 recover가 완료 기록을 복원한다', async (t) => {
  const setup = await ready(t)
  const result = await integrateWork({ ...setup, attempt: setup.attempt.id, verify: checks })
  const runtime = runtimeRoot(await inspectWorkspace(setup))
  await transaction(runtime, (state) => {
    const entry = state.attempts[setup.attempt.id]
    entry.status = 'integrating'
    entry.operation = { token: 'interrupted', attempt: entry.id, kind: 'integrating', pid: 2147483647, host: os.hostname() }
    delete entry.integratedCommit
    state.groups.feature.operation = entry.operation
  })
  const recovered = await recoverWork({ ...setup, attempt: setup.attempt.id })
  assert.equal(recovered.status, 'integrated')
  assert.equal(recovered.integratedCommit, result.integratedCommit)
  assert.equal((await readRuntime(runtime)).groups.feature.operation, undefined)
})

test('Git 없는 프로젝트는 single로 감지하고 work 생성은 기존 흐름을 안내한다', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gusta-single-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  assert.equal((await inspectWork({ targetRoot: root })).mode, 'single')
  await assert.rejects(startWork({ targetRoot: root, name: 'new' }), /단독 구현/)
})

test('같은 외부 checkout에 서로 다른 태스크를 동시에 배정할 수 없다', async (t) => {
  const setup = await fixture(t)
  const group = await startWork({ ...setup, name: 'workspace-race' })
  const external = path.join(setup.temporary, 'shared-worker')
  await git(setup.root, 'worktree', 'add', '-b', 'external-worker', external, group.branch)
  const call = (taskId) => execute(process.execPath, [cli, 'work', 'claim', taskId, '--work', group.id, '--workspace', 'current', '--target', external, '--json'])
  const outcomes = await Promise.allSettled([call('T001'), call('T002')])
  assert.equal(outcomes.filter((entry) => entry.status === 'fulfilled').length, 1)
  assert.equal((await inspectWork(setup)).attempts.length, 1)
})

test('독립 워커 두 개를 순서대로 통합해도 STATE 충돌 없이 결과를 모은다', async (t) => {
  const setup = await fixture(t)
  const group = await startWork({ ...setup, name: 'parallel' })
  const first = await claimWork({ ...setup, work: group.id, task: 'T001' })
  const second = await claimWork({ ...setup, work: group.id, task: 'T002' })
  await implement(first)
  await implement(second, 'two.txt')
  await Promise.all([
    submitWork({ ...setup, attempt: first.id, verify: checks }),
    submitWork({ ...setup, attempt: second.id, verify: [checkFile('two.txt')] }),
  ])
  await approve(setup, first)
  await integrateWork({ ...setup, attempt: first.id, verify: checks })
  await approve(setup, second)
  await integrateWork({ ...setup, attempt: second.id, verify: [...checks, checkFile('two.txt')] })
  const board = await workBoard({ ...setup, work: group.id })
  assert.deepEqual(board.doneIds, ['T001', 'T002'])
  assert.equal(board.tasks[0].id, 'T003')
  assert.equal(board.tasks[0].claimable, true)
})

test('stale SSOT base와 워커 계약 변조는 배정/제출 시 거부한다', async (t) => {
  const setup = await fixture(t)
  const group = await startWork({ ...setup, name: 'contract' })
  const attempt = await claimWork({ ...setup, work: group.id, task: 'T001' })
  await implement(attempt)
  const file = path.join(attempt.workspace, 'spec/tasks/T001.first.md')
  await writeFile(file, (await readFile(file, 'utf8')).replace('implement T001', 'different goal'))
  await commit(attempt.workspace)
  await assert.rejects(submitWork({ ...setup, attempt: attempt.id, verify: checks }), /계약/)
  const arch = path.join(group.path, 'spec/ssot/ARCH.md')
  await writeFile(arch, (await readFile(arch, 'utf8')).replace('> r1', '> r2'))
  await commit(group.path)
  await assert.rejects(claimWork({ ...setup, work: group.id, task: 'T002' }), /신선도/)
})

test('prune-branches: false면 ignored 로컬 파일도 worktree cleanup이 보존한다', async (t) => {
  const setup = await ready(t)
  await writeFile(path.join(setup.root, 'spec/SETTINGS.md'), '# SETTINGS\n- prune-branches: false\n')
  await integrateWork({ ...setup, attempt: setup.attempt.id, verify: checks })
  const exclude = (await git(setup.root, 'rev-parse', '--git-path', 'info/exclude')).stdout.trim()
  const file = path.resolve(setup.root, exclude)
  await writeFile(file, (await readFile(file, 'utf8')) + '\nlocal.cache\n')
  await writeFile(path.join(setup.attempt.workspace, 'local.cache'), 'keep')
  await assert.rejects(cleanupWork({ ...setup, attempt: setup.attempt.id }), /ignored/)
  assert.equal(await readFile(path.join(setup.attempt.workspace, 'local.cache'), 'utf8'), 'keep')
})

test('prune-branches 기본값: cleanup이 ignored 산출물째 공간을 지우고 합쳐진 단위 브랜치·체크포인트 ref도 지운다', async (t) => {
  const setup = await ready(t)
  const { root, attempt } = setup
  await integrateWork({ ...setup, attempt: attempt.id, verify: checks })
  const exclude = path.resolve(root, (await git(root, 'rev-parse', '--git-path', 'info/exclude')).stdout.trim())
  await writeFile(exclude, (await readFile(exclude, 'utf8')) + '\nnode_modules/\n')
  await mkdir(path.join(attempt.workspace, 'node_modules'))
  await writeFile(path.join(attempt.workspace, 'node_modules/dep.js'), 'installed')
  await git(root, 'update-ref', `refs/gusta/checkpoints/${attempt.id}`, setup.sha)
  const cleaned = await cleanupWork({ ...setup, attempt: attempt.id })
  assert.deepEqual(cleaned.prunedRefs, [attempt.branch, `refs/gusta/checkpoints/${attempt.id}`])
  assert.equal(cleaned.branchKept, null)
  await assert.rejects(access(attempt.workspace), { code: 'ENOENT' })
  assert.equal((await git(root, 'branch', '--list', 'task/*')).stdout, '')
})

test('pruneWork: 이전 cleanup이 남긴 단위 브랜치를 지우고, 묶음은 기준 브랜치에 합쳐진 뒤에만 닫는다', async (t) => {
  const setup = await fixture(t)
  const { root } = setup
  const group = await startWork({ ...setup, name: 'scoped', tasks: 'T001' })
  const attempt = await claimWork({ ...setup, work: group.id, task: 'T001' })
  await implement(attempt)
  await submitWork({ ...setup, attempt: attempt.id, verify: checks })
  await approve(setup, attempt)
  await integrateWork({ ...setup, attempt: attempt.id, verify: checks })
  // An older cleanup (setting off) left the branch behind.
  await writeFile(path.join(root, 'spec/SETTINGS.md'), '# SETTINGS\n- prune-branches: false\n')
  await cleanupWork({ ...setup, attempt: attempt.id })
  assert.match((await git(root, 'branch', '--list', 'task/*')).stdout, /task\/scoped\/T001/)
  assert.deepEqual(await pruneWork({ targetRoot: root, groups: true }), { skipped: 'prune-branches: false' })
  await rm(path.join(root, 'spec/SETTINGS.md'))
  let result = await pruneWork({ targetRoot: root, groups: true })
  assert.deepEqual(result.pruned, [attempt.branch])
  assert.match(result.kept.find((entry) => entry.work === group.id).reason, /합쳐지지 않았습니다/)
  await access(group.path)
  await git(root, 'merge', '-q', '--ff-only', group.branch)
  result = await pruneWork({ targetRoot: root, groups: true })
  assert.deepEqual(result.pruned, [group.path, group.branch])
  await assert.rejects(access(group.path), { code: 'ENOENT' })
  assert.equal((await git(root, 'branch', '--list', 'work/*')).stdout, '')
  assert.equal((await readRuntime(runtimeRoot(await inspectWorkspace({ targetRoot: root })))).groups.scoped.status, 'pruned')
  assert.deepEqual(await pruneWork({ targetRoot: root, groups: true }), { cleaned: [], pruned: [], kept: [] })
})

test('생성 중인 실행은 live creator가 있으면 release할 수 없다', async (t) => {
  const setup = await fixture(t)
  await startWork({ ...setup, name: 'preparing' })
  const attempt = await claimWork({ ...setup, work: 'preparing', task: 'T001' })
  const runtime = runtimeRoot(await inspectWorkspace(setup))
  await transaction(runtime, (state) => { state.attempts[attempt.id].status = 'preparing' })
  await assert.rejects(releaseWork({ ...setup, attempt: attempt.id }), /실행 중/)
})

test('live 생성기가 없는 기획 공간의 완료된 생성은 recover로 연결한다', async (t) => {
  const setup = await fixture(t)
  const group = await startWork({ ...setup, name: 'recover-plan' })
  const runtime = runtimeRoot(await inspectWorkspace(setup))
  await transaction(runtime, (state) => {
    state.groups[group.id].status = 'preparing'
    state.groups[group.id].creator.pid = 2147483647
    delete state.groups[group.id].gitDir
  })
  const result = await recoverWork({ ...setup, work: group.id })
  assert.equal(result.status, 'active')
  assert.equal(result.managed, false)
})

test('이력은 재배정/blocked를 보존하고 heartbeat는 중복 이벤트를 만들지 않는다', async (t) => {
  const setup = await fixture(t)
  const group = await startWork({ ...setup, name: 'history' })
  const first = await claimWork({ ...setup, work: group.id, task: 'T001', owner: 'claude-a' })
  await updateWork({ ...setup, attempt: first.id, status: 'blocked', reason: 'missing configuration' })
  const before = await workHistory({ ...setup, work: group.id })
  await updateWork({ ...setup, attempt: first.id })
  assert.deepEqual(await workHistory({ ...setup, work: group.id }), before)
  await releaseWork({ ...setup, attempt: first.id })
  const second = await claimWork({ ...setup, work: group.id, task: 'T001', owner: 'codex-b' })
  const saved = await syncWork({ ...setup, work: group.id })
  assert.equal(saved.candidate, null)
  assert.ok(!(await git(setup.root, 'worktree', 'list')).stdout.includes('-sync-'))
  const snapshot = JSON.parse(await readFile(path.join(group.path, saved.file), 'utf8'))
  assert.equal(snapshot.summary.running, 1)
  assert.equal(snapshot.attempts.length, 2)
  assert.deepEqual(snapshot.attempts.map((entry) => entry.owner), ['claude-a', 'codex-b'])
  const filtered = await workHistory({ ...setup, work: group.id, task: 'T001' })
  assert.ok(filtered.history.every((entry) => entry.taskId === 'T001'))
  assert.ok(filtered.history.some((entry) => entry.status === 'blocked' && entry.changes.reason === 'missing configuration'))
  assert.ok(filtered.history.some((entry) => entry.attemptId === second.id))
  const dirty = path.join(group.path, 'keep.txt')
  await writeFile(dirty, 'user draft')
  const previousHead = (await git(group.path, 'rev-parse', 'HEAD')).stdout
  await assert.rejects(syncWork({ ...setup, work: group.id }), /진행 기록을 저장하지/)
  assert.equal(await readFile(dirty, 'utf8'), 'user draft')
  assert.equal((await git(group.path, 'rev-parse', 'HEAD')).stdout, previousHead)
  assert.equal((await inspectWork(setup)).groups[0].operation, undefined)
  const runtime = runtimeRoot(await inspectWorkspace(setup))
  await transaction(runtime, (state) => { state.groups[group.id].operation = { kind: 'sync', token: 'stopped-sync', pid: process.pid, host: os.hostname(), candidate: 'preserved' } })
  await assert.rejects(recoverWork({ ...setup, work: group.id }), /실행 중/)
  await transaction(runtime, (state) => { state.groups[group.id].operation.pid = 2147483647 })
  const recovered = await recoverWork({ ...setup, work: group.id })
  assert.equal(recovered.operation, undefined)
  assert.equal(recovered.recoveredSync.candidate, 'preserved')
})

test('새 clone에서도 저장된 묶음 이름과 다른 묶음의 STATE 기록을 보존한다', async (t) => {
  const setup = await fixture(t)
  const group = await startWork({ ...setup, name: 'kept' })
  await syncWork({ ...setup, work: group.id })
  const clone = path.join(setup.temporary, 'clone-with-history')
  await git(setup.root, 'clone', '--branch', group.branch, setup.root, clone)
  for (const [key, value] of [['user.name', 'Test'], ['user.email', 'test@example.com'], ['commit.gpgsign', 'false'], ['core.hooksPath', path.join(setup.temporary, 'no-hooks')]]) await git(clone, 'config', key, value)
  const old = await readFile(path.join(clone, 'spec/work/kept.json'), 'utf8')
  await assert.rejects(startWork({ targetRoot: clone, name: 'kept' }), /이력이 이미 저장/)
  assert.equal((await inspectWork({ targetRoot: clone })).groups.length, 0)
  const next = await startWork({ targetRoot: clone, name: 'next-group' })
  await syncWork({ targetRoot: clone, work: next.id })
  assert.equal(await readFile(path.join(next.path, 'spec/work/kept.json'), 'utf8'), old)
  const state = await readFile(path.join(next.path, 'spec/STATE.md'), 'utf8')
  assert.equal(state.match(/^## work$/gm).length, 1)
  assert.equal(state.match(/^\| kept \|/gm).length, 1)
  assert.equal(state.match(/^\| next-group \|/gm).length, 1)
})

test('검사 명령의 중단·시간 초과는 셸이 fork한 명령까지 프로세스 그룹째 멈추고, 결과는 출력 꼬리만 남긴다', { skip: process.platform === 'win32' }, async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gusta-check-kill-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const beat = path.join(dir, 'beat')
  const read = () => readFile(beat, 'utf8').catch(() => '')
  const beating = async () => { const before = await read(); await pause(250); return (await read()) !== before }
  // `; true` makes every shell fork node instead of exec'ing it — the child that signalling only /bin/sh missed.
  const command = `node -e "setInterval(()=>require('fs').writeFileSync('${beat}', String(Date.now())), 20)"; true`

  const abort = new AbortController()
  const running = runCheckCommand(command, { cwd: dir, signal: abort.signal })
  for (const deadline = Date.now() + 60000; !(await read()) && Date.now() < deadline;) await pause(20)
  assert.ok(await read(), 'the command started')
  abort.abort()
  await assert.rejects(running, /aborted/)
  assert.equal(await beating(), false, 'abort left the forked command running')

  await rm(beat, { force: true })
  await assert.rejects(runCheckCommand(command, { cwd: dir, timeout: 1500 }), /timed out/)
  assert.equal(await beating(), false, 'timeout left the forked command running')

  assert.deepEqual(await runCheckCommand('echo out; echo err >&2', { cwd: dir }), { stdout: 'out\n', stderr: 'err\n' })
  await assert.rejects(runCheckCommand('echo bad >&2; exit 3', { cwd: dir }), (error) => /exit 3/.test(error.message) && error.stderr === 'bad\n')
})
