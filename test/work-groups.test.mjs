import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath, access, chmod } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { startWork, claimWork, claimNextWork, inspectWork, updateWork, releaseWork, commitWorkerWork, submitWork, integrateWork, finishWork, cleanupWork, recoverWork, workBoard, workHistory, syncWork } from '../src/work-groups.mjs'
import { nextWork, claimReviewWaiting } from '../src/work-wait.mjs'
import { claimReview, finishReview, releaseReview, resumeWork } from '../src/work-review.mjs'
import { runWork, recoverRunner } from '../src/work-runner.mjs'
import { inspectWorkspace } from '../src/workspace.mjs'
import { pruneWork } from '../src/prune.mjs'
import { runtimeRoot, transaction, readRuntime, unlockRuntime } from '../src/work-runtime.mjs'

const execute = promisify(execFile)
const cli = fileURLToPath(new URL('../bin/haeram-spec-creator.mjs', import.meta.url))
const git = (cwd, ...args) => execute('git', ['-C', cwd, ...args], { encoding: 'utf8' })
const commit = async (cwd, message = 'change') => {
  await git(cwd, 'add', '.')
  await git(cwd, 'commit', '-m', message)
  return (await git(cwd, 'rev-parse', 'HEAD')).stdout.trim()
}
const task = (id, dep = '-') => `# ${id} example\n> st:todo | ssot:ARCH-1 | base:ARCH@1 | dep:${dep}\n\n## goal\nimplement ${id}\n\n## acceptance\n- [ ] result exists\n\n## impl notes\n- keep contracts\n\n## result\n`
const checkFile = (file) => `node -e "require('fs').accessSync('${file}')"`
const checks = [checkFile('one.txt')]

async function fixture(t) {
  const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), 'haeram-work-flow-')))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const root = path.join(temporary, 'repo with spaces')
  await mkdir(path.join(root, 'spec/tasks'), { recursive: true })
  await mkdir(path.join(root, 'spec/ssot'), { recursive: true })
  await git(root, 'init', '-b', 'trunk')
  for (const [key, value] of [['user.name', 'Test'], ['user.email', 'test@example.com'], ['commit.gpgsign', 'false'], ['core.hooksPath', path.join(temporary, 'no-hooks')]]) await git(root, 'config', key, value)
  await writeFile(path.join(root, 'spec/FORMAT.md'), '# FORMAT\n')
  await writeFile(path.join(root, 'spec/STATE.md'), `# STATE\n\n## cfg\n- level: expert\n- lang: ko\n- docs: en\n\n## ssot\n| id | rev | tasked | pending | [?] |\n|---|---|---|---|---|\n| ARCH | 1 | 1 | - | 0 |\n\n## tasks\n| id | title | ssot | dep | st |\n|---|---|---|---|---|\n| T001 | first | ARCH | - | todo |\n| T002 | second | ARCH | - | todo |\n| T003 | after | ARCH | T001 | todo |\n\n## next\n- implement-task T001\n\n## log\n`)
  await writeFile(path.join(root, 'spec/ssot/ARCH.md'), '# ARCH architecture\n> r1 | architecture\n\n## decisions\n- ARCH-1 [o] runtime: node\n\n## chg\n- r1 260924 initial\n')
  await writeFile(path.join(root, 'spec/tasks/T001.first.md'), task('T001'))
  await writeFile(path.join(root, 'spec/tasks/T002.second.md'), task('T002'))
  await writeFile(path.join(root, 'spec/tasks/T003.after.md'), task('T003', 'T001'))
  await writeFile(path.join(root, 'shared.txt'), 'base\n')
  const initial = await commit(root, 'spec')
  return { root, temporary, initial, targetRoot: root }
}

async function implement(attempt, file = 'one.txt', extra = {}) {
  const taskFile = path.join(attempt.workspace, `spec/tasks/${attempt.taskId}.${attempt.taskId === 'T001' ? 'first' : 'second'}.md`)
  const content = (await readFile(taskFile, 'utf8')).replace('- [ ]', '- [v]') + '- outcome: implemented\n- at: -\n- verified: pending submit\n- limits: -\n'
  await writeFile(taskFile, content)
  await writeFile(path.join(attempt.workspace, file), 'result\n')
  for (const [name, value] of Object.entries(extra)) await writeFile(path.join(attempt.workspace, name), value)
  return commit(attempt.workspace)
}

async function approve(setup, attempt) {
  const review = await claimReview({ ...setup, work: attempt.group, attempt: attempt.id, owner: 'reviewer' })
  assert.ok(review.id, JSON.stringify(review))
  return finishReview({ ...setup, review: review.id, result: { verdict: 'approved', summary: 'Task and implementation reviewed', findings: [] } })
}

async function ready(t) {
  const fixtureData = await fixture(t)
  const group = await startWork({ ...fixtureData, name: 'feature' })
  const attempt = await claimWork({ ...fixtureData, work: group.id, task: 'T001' })
  const sha = await implement(attempt)
  await submitWork({ ...fixtureData, attempt: attempt.id, verify: checks })
  await approve(fixtureData, attempt)
  return { ...fixtureData, group, attempt, sha }
}

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

test('detached 외부 워커도 지원한다', async (t) => {
  const setup = await fixture(t)
  const group = await startWork({ ...setup, name: 'detached' })
  const external = path.join(setup.temporary, 'detached')
  await git(setup.root, 'worktree', 'add', '--detach', external, group.branch)
  const attempt = await claimWork({ targetRoot: external, work: group.id, task: 'T001' })
  assert.equal(attempt.branch, null)
  await implement(attempt)
  const submitted = await submitWork({ ...setup, attempt: attempt.id, verify: checks })
  assert.equal(submitted.status, 'ready')
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
  const root = await mkdtemp(path.join(os.tmpdir(), 'haeram-single-'))
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
  await git(root, 'update-ref', `refs/haeram/checkpoints/${attempt.id}`, setup.sha)
  const cleaned = await cleanupWork({ ...setup, attempt: attempt.id })
  assert.deepEqual(cleaned.prunedRefs, [attempt.branch, `refs/haeram/checkpoints/${attempt.id}`])
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

async function expandTasks(setup, count) {
  const stateFile = path.join(setup.root, 'spec/STATE.md')
  let state = await readFile(stateFile, 'utf8')
  const rows = []
  for (let n = 4; n <= count; n += 1) {
    const id = `T${String(n).padStart(3, '0')}`
    await writeFile(path.join(setup.root, `spec/tasks/${id}.extra.md`), task(id))
    rows.push(`| ${id} | extra | ARCH | - | todo |`)
  }
  state = state.replace('\n## next', `${rows.join('\n')}\n\n## next`)
  await writeFile(stateFile, state)
  await commit(setup.root)
}

test('50개 대기 태스크에서 4개 프로세스가 중복 없이 선점하고 worker 한도를 지킨다', async (t) => {
  const setup = await fixture(t)
  await expandTasks(setup, 50)
  await startWork({ ...setup, name: 'fifty' })
  const calls = Array.from({ length: 5 }, (_, index) => execute(process.execPath, [cli, 'work', 'claim-next', '--work', 'fifty', '--owner', `worker-${index}`, '--target', setup.root, '--json'], { encoding: 'utf8' }))
  const results = (await Promise.all(calls)).map(({ stdout }) => JSON.parse(stdout))
  const claims = results.filter((entry) => entry.id)
  assert.equal(claims.length, 4)
  assert.equal(new Set(claims.map((entry) => entry.taskId)).size, 4)
  assert.ok(claims.some((entry) => entry.taskId === 'T001'))
  assert.ok(!claims.some((entry) => entry.taskId === 'T003'))
  assert.equal(results.find((entry) => entry.idle).reason, 'worker-capacity')
})

test('next는 의존 태스크를 많이 여는 일을 우선하고 touches 충돌을 직렬화한다', async (t) => {
  const setup = await fixture(t)
  for (const file of ['T001.first.md', 'T002.second.md']) {
    const target = path.join(setup.root, 'spec/tasks', file)
    await writeFile(target, (await readFile(target, 'utf8')).replace('dep:-', `dep:- | touches:${file.startsWith('T001') ? 'src/auth/' : 'src/auth/login.mjs'}`))
  }
  await commit(setup.root)
  await startWork({ ...setup, name: 'touches' })
  const first = await claimNextWork({ ...setup, work: 'touches', owner: 'a' })
  assert.equal(first.taskId, 'T001')
  assert.equal((await claimNextWork({ ...setup, work: 'touches', owner: 'b' })).reason, 'no-eligible-task')
  assert.equal((await workBoard({ ...setup, work: 'touches' })).tasks.find((entry) => entry.id === 'T002').claimable, false)
})

test('리뷰 대기 상한은 신규 선점을 멈추며 완료 검증만으로 통합할 수 없다', async (t) => {
  const setup = await fixture(t)
  await startWork({ ...setup, name: 'pressure', maxPending: 1 })
  const attempt = await claimNextWork({ ...setup, work: 'pressure', owner: 'worker' })
  await implement(attempt)
  await submitWork({ ...setup, attempt: attempt.id, verify: checks })
  assert.equal((await claimNextWork({ ...setup, work: 'pressure', owner: 'other' })).reason, 'review-backpressure')
  await assert.rejects(integrateWork({ ...setup, attempt: attempt.id, verify: checks }), /상태|승인/)
  assert.equal((await claimReview({ ...setup, work: 'pressure', owner: 'worker' })).idle, true)
})

test('리뷰 선점은 하나만 성공하고 수정 요청은 신규 작업보다 먼저 재배정된다', async (t) => {
  const setup = await fixture(t)
  await startWork({ ...setup, name: 'review-race' })
  const attempt = await claimNextWork({ ...setup, work: 'review-race', owner: 'a' })
  await implement(attempt)
  await submitWork({ ...setup, attempt: attempt.id, verify: checks })
  const calls = ['r1', 'r2'].map((owner) => execute(process.execPath, [cli, 'work', 'review-claim', '--work', 'review-race', '--owner', owner, '--target', setup.root, '--json'], { encoding: 'utf8' }))
  const results = (await Promise.all(calls)).map(({ stdout }) => JSON.parse(stdout))
  const review = results.find((entry) => entry.id)
  assert.equal(results.filter((entry) => entry.id).length, 1)
  await assert.rejects(updateWork({ ...setup, attempt: attempt.id, status: 'doing' }), /갱신/)
  await assert.rejects(finishReview({ ...setup, review: review.id, result: { verdict: 'approved', summary: 'bad', findings: [{ priority: 'P1', where: 'one.txt:1', message: 'broken' }] } }), /P1/)
  await finishReview({ ...setup, review: review.id, result: { verdict: 'changes_requested', summary: 'fix outcome', findings: [{ priority: 'P2', where: 'one.txt:1', message: 'missing edge case' }] } })
  assert.match((await claimNextWork({ ...setup, work: 'review-race', owner: 'b' })).reason, /changes-requested/)
  const resumed = await resumeWork({ ...setup, work: 'review-race', owner: 'b' })
  assert.equal(resumed.id, attempt.id)
  assert.equal(resumed.correction.findings[0].message, 'missing edge case')
  assert.equal(resumed.verifiedCommit, undefined)
  await assert.rejects(finishReview({ ...setup, review: review.id, result: { verdict: 'approved', summary: 'old reply', findings: [] } }), /오래된/)
  await writeFile(path.join(attempt.workspace, 'one.txt'), 'fixed\n')
  const changed = await commit(attempt.workspace)
  await submitWork({ ...setup, attempt: attempt.id, verify: checks })
  const approved = await approve(setup, attempt)
  assert.equal(approved.review.commit, changed)
  await integrateWork({ ...setup, attempt: attempt.id, verify: checks })
})

test('제출 이후 변경과 리뷰 이후 겹치는 상위 변경은 승인을 무효화한다', async (t) => {
  const setup = await ready(t)
  await writeFile(path.join(setup.attempt.workspace, 'one.txt'), 'changed\n')
  await commit(setup.attempt.workspace)
  await assert.rejects(integrateWork({ ...setup, attempt: setup.attempt.id, verify: checks }), /통합을 완료하지/)
  assert.equal((await inspectWork(setup)).attempts[0].status, 'blocked')
  await submitWork({ ...setup, attempt: setup.attempt.id, verify: checks })
  await approve(setup, setup.attempt)
  // The base adds the same file with the worker's content, so the later merge stays clean.
  await writeFile(path.join(setup.group.path, 'one.txt'), 'changed\n')
  await commit(setup.group.path, 'base touches the submission')
  await assert.rejects(integrateWork({ ...setup, attempt: setup.attempt.id, verify: checks }), /통합을 완료하지/)
  const entry = (await inspectWork(setup)).attempts[0]
  assert.equal(entry.status, 'ready')
  assert.equal(entry.review, undefined)
  await approve(setup, setup.attempt)
  await integrateWork({ ...setup, attempt: setup.attempt.id, verify: checks })
})

test('리뷰 중 변경된 기준과 해제한 review ID로는 승인할 수 없다', async (t) => {
  const setup = await ready(t)
  await submitWork({ ...setup, attempt: setup.attempt.id, verify: checks })
  let review = await claimReview({ ...setup, work: 'feature', attempt: setup.attempt.id, owner: 'r' })
  await releaseReview({ ...setup, review: review.id })
  await assert.rejects(finishReview({ ...setup, review: review.id, result: { verdict: 'approved', summary: 'late', findings: [] } }), /오래된/)
  review = await claimReview({ ...setup, work: 'feature', attempt: setup.attempt.id, owner: 'r' })
  await writeFile(path.join(setup.group.path, 'one.txt'), 'result\n')
  await commit(setup.group.path, 'overlapping base')
  await assert.rejects(finishReview({ ...setup, review: review.id, result: { verdict: 'approved', summary: 'stale', findings: [] } }), /바뀌었/)
  assert.equal((await inspectWork(setup)).attempts[0].status, 'ready')
})

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

test('겹치지 않는 상위 변경은 승인과 리뷰를 유지한 채 통합한다', async (t) => {
  const setup = await ready(t)
  const review = (await inspectWork(setup)).attempts[0].review
  await writeFile(path.join(setup.group.path, 'unrelated.txt'), 'other unit\n')
  await commit(setup.group.path, 'another unit integrated')
  assert.equal((await claimReview({ ...setup, work: 'feature', owner: 'r2' })).idle, true)
  assert.equal((await inspectWork(setup)).attempts[0].status, 'approved')
  const integrated = await integrateWork({ ...setup, attempt: setup.attempt.id, verify: [...checks, checkFile('unrelated.txt')] })
  assert.equal(integrated.status, 'integrated')
  assert.equal(integrated.review.id, review.id)
  assert.equal(integrated.reviewHistory, undefined)
})

test('리뷰 결과의 추가 필드로 고정된 커밋과 ID를 덮어쓸 수 없다', async (t) => {
  const setup = await ready(t)
  await submitWork({ ...setup, attempt: setup.attempt.id, verify: checks })
  const review = await claimReview({ ...setup, work: 'feature', attempt: setup.attempt.id, owner: 'r' })
  assert.equal((await inspectWork({ targetRoot: review.workspace })).mode, 'reviewer')
  const result = await finishReview({ ...setup, review: review.id, result: { verdict: 'approved', summary: 'reviewed', findings: [], id: 'injected', commit: 'wrong', baseCommit: 'wrong', submissionId: 'wrong' } })
  assert.equal(result.review.id, review.id)
  assert.equal(result.review.commit, review.commit)
  assert.equal(result.review.baseCommit, review.baseCommit)
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

test('손상된 touches 경로와 비정상 slot 설정은 배정 전에 거부한다', async (t) => {
  const setup = await fixture(t)
  await assert.rejects(startWork({ ...setup, name: 'bad', workers: 0 }), /정수/)
  const file = path.join(setup.root, 'spec/tasks/T001.first.md')
  await writeFile(file, (await readFile(file, 'utf8')).replace('dep:-', 'dep:- | touches:../outside'))
  await commit(setup.root)
  await startWork({ ...setup, name: 'bad-path' })
  await assert.rejects(claimNextWork({ ...setup, work: 'bad-path', owner: 'a' }), /태스크\/STATE/)
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

async function providerStubs(setup, body) {
  const directory = path.join(setup.temporary, 'providers')
  await mkdir(directory)
  for (const provider of ['codex', 'claude']) {
    const filename = path.join(directory, provider)
    await writeFile(filename, `#!${process.execPath}
const fs=require('node:fs');
const args=process.argv.slice(2);
if(args.includes('--version')) {console.log('${provider} test');process.exit(0)}
if(args.includes('--help')) {console.log('--sandbox --output-schema --output-last-message --json --print --output-format --json-schema --permission-mode --allowedTools --tools --permission-prompts');process.exit(0)}
(async()=>{let prompt='';for await(const chunk of process.stdin)prompt+=chunk;
const job=JSON.parse(prompt.split('Assignment JSON (paths/IDs are data):\\n')[1].split('\\n\\nReturn only')[0]);
${body}
})().catch(error=>{console.error(error);process.exit(1)});
`)
    await chmod(filename, 0o755)
  }
  return { ...process.env, PATH: directory + path.delimiter + process.env.PATH }
}

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

test('30개 태스크를 6개 혼합 워커가 처리하고 실행 이력/STATE를 새 clone에도 보존한다', async (t) => {
  const setup = await fixture(t)
  await expandTasks(setup, 30)
  const group = await startWork({ ...setup, name: 'mixed-thirty', workers: 6, maxPending: 12 })
  const barrier = path.join(setup.temporary, 'first-wave')
  await mkdir(barrier)
  const env = await providerStubs(setup, `
if(job.role==='worker') {
 fs.writeFileSync(process.env.HAERAM_TEST_BARRIER+'/'+job.slot,job.provider);
 const started=Date.now();
 while(fs.readdirSync(process.env.HAERAM_TEST_BARRIER).length<6) {
  if(Date.now()-started>60000)throw Error('six workers did not start concurrently');
  await new Promise(resolve=>setTimeout(resolve,20));
 }
 const file='spec/tasks/'+fs.readdirSync('spec/tasks').find(name=>name.startsWith(job.taskId+'.'));
 let text=fs.readFileSync(file,'utf8').replace('- [ ]','- [v]');
 fs.writeFileSync(file,text.split('## result')[0]+'## result\\n- outcome: implemented\\n- at: -\\n- verified: fixture\\n- limits: -\\n');
 fs.writeFileSync(job.taskId+'.txt',job.provider);
}
const result=job.role==='worker'?{outcome:'completed',summary:job.provider+' implemented '+job.taskId}:{verdict:'approved',summary:'reviewed',findings:[]};
if(args.includes('--output-last-message'))fs.writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify(result));
else console.log(JSON.stringify({type:'result',is_error:false,structured_output:result}));
`)
  env.HAERAM_TEST_BARRIER = barrier
  const result = await runWork({ ...setup, work: group.id, providers: 'codex,claude', env, verify: [checkFile('spec/ssot/ARCH.md')] })
  assert.equal(result.outcome, 'completed', JSON.stringify(result))
  assert.deepEqual(result.failures, [])
  assert.equal(result.snapshotError, null)
  assert.equal(result.summary.completed, 30)
  assert.equal(result.summary.remaining, 0)
  const { history } = await workHistory({ ...setup, work: group.id })
  const launches = history.filter((event) => event.changes.dispatch?.role === 'worker' && event.changes.dispatch.status === 'starting')
  assert.equal(launches.length, 30)
  assert.equal(new Set(launches.map((event) => event.taskId)).size, 30)
  assert.deepEqual([...new Set(launches.map((event) => event.changes.dispatch.slot))].sort(), [1, 2, 3, 4, 5, 6])
  assert.ok(launches.every((event) => event.changes.dispatch.provider === (event.changes.dispatch.slot % 2 ? 'codex' : 'claude')))
  const busy = new Set()
  let peak = 0
  for (const event of history.filter((event) => event.type === 'attempt')) {
    if (['preparing', 'doing', 'committing', 'verifying'].includes(event.status)) busy.add(event.attemptId)
    else busy.delete(event.attemptId)
    peak = Math.max(peak, busy.size)
  }
  assert.equal(peak, 6)
  const clone = path.join(setup.temporary, 'fresh-clone')
  await git(setup.root, 'clone', '--branch', group.branch, setup.root, clone)
  const saved = JSON.parse(await readFile(path.join(clone, 'spec/work/mixed-thirty.json'), 'utf8'))
  assert.deepEqual(saved.summary, result.summary)
  assert.ok(saved.attempts.every((entry) => entry.status === 'integrated' && entry.integratedCommit))
  // The runner pruned every unit before saving (prune-branches): cleaning → integrated is not an integration.
  assert.equal(result.pruned.cleaned.length, 30)
  assert.equal(saved.history.filter((event) => event.status === 'integrated' && !['integrated', 'cleaning'].includes(event.previousStatus)).length, 30)
  assert.equal(saved.group.lastRun.outcome, 'completed')
  const state = await readFile(path.join(clone, 'spec/STATE.md'), 'utf8')
  assert.match(state, /\| mixed-thirty \| 6 \| 30 \| 30 \| 0 \| 0 \| 0 \| 0 \|/)
  assert.ok(!state.includes('| T001 |'))
  assert.equal((await inspectWork({ targetRoot: clone })).attempts.length, 0)
  const portable = await workHistory({ targetRoot: clone, work: group.id, task: 'T001' })
  assert.equal(portable.scope, 'snapshot')
  assert.ok(portable.history.every((entry) => entry.taskId === 'T001'))
  assert.ok(portable.history.some((entry) => entry.status === 'integrated'))
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

const laneTask = (id, dep, lane) => task(id, dep).replace(`dep:${dep}`, `dep:${dep} | touches:${lane === '-' ? '-' : `src/${lane}/`} | lane:${lane}`)

// specs: [id, dep, lane]. Replaces the default T001-T003 plan with lanes.
async function laneFixture(t, specs) {
  const setup = await fixture(t)
  for (const file of ['T001.first.md', 'T002.second.md', 'T003.after.md']) await rm(path.join(setup.root, 'spec/tasks', file))
  for (const [id, dep, lane] of specs) await writeFile(path.join(setup.root, `spec/tasks/${id}.lane.md`), laneTask(id, dep, lane))
  const stateFile = path.join(setup.root, 'spec/STATE.md')
  const rows = specs.map(([id, dep]) => `| ${id} | lane | ARCH | ${dep} | todo |`).join('\n')
  await writeFile(stateFile, (await readFile(stateFile, 'utf8')).replace(/(\|---\|---\|---\|---\|---\|\n)(?:\| T\d+[^\n]*\n)+/, `$1${rows}\n`))
  await commit(setup.root, 'lane plan')
  return setup
}

async function complete(workspace, taskId, file = `${taskId}.txt`) {
  const taskFile = path.join(workspace, `spec/tasks/${taskId}.lane.md`)
  await writeFile(taskFile, (await readFile(taskFile, 'utf8')).replace('- [ ]', '- [v]') + `- outcome: implemented\n- at: -\n- verified: worker ran ${taskId} tests\n- limits: -\n`)
  await writeFile(path.join(workspace, file), `${taskId}\n`)
  return commit(workspace, `implement ${taskId}`)
}

async function deliver(setup, attempt, verify) {
  await approve(setup, attempt)
  return integrateWork({ ...setup, attempt: attempt.id, verify })
}

test('lane은 한 공간에서 순서대로 구현하고 lane 단위로 리뷰·통합한다', async (t) => {
  const setup = await laneFixture(t, [['T001', '-', '-'], ['T002', 'T001', 'a'], ['T003', 'T002', 'a'], ['T004', 'T001', 'b'], ['T005', 'T003 T004', '-']])
  const group = await startWork({ ...setup, name: 'lanes' })
  let board = await workBoard({ ...setup, work: group.id })
  assert.deepEqual(board.units.map((unit) => [unit.key, unit.waitingOn, unit.claimable]), [
    ['T001', [], true], ['lane:a', ['T001'], false], ['lane:b', ['T001'], false], ['T005', ['T003', 'T004'], false]])
  const base = await claimNextWork({ ...setup, work: group.id, owner: 'a' })
  assert.deepEqual(base.tasks, ['T001'])
  assert.equal((await claimNextWork({ ...setup, work: group.id, owner: 'b' })).reason, 'no-eligible-task')
  await complete(base.workspace, 'T001')
  await submitWork({ ...setup, attempt: base.id, verify: [checkFile('T001.txt')] })
  await deliver(setup, base, [checkFile('T001.txt')])

  const laneA = await claimNextWork({ ...setup, work: group.id, owner: 'a' })
  assert.deepEqual([laneA.lane, laneA.tasks, laneA.taskId], ['a', ['T002', 'T003'], 'T002'])
  assert.match(laneA.branch, /^lane\/lanes\/a-/)
  const laneB = await claimNextWork({ ...setup, work: group.id, owner: 'b' })
  assert.deepEqual(laneB.tasks, ['T004'])
  const first = await complete(laneA.workspace, 'T002')
  // No host check at a lane step: the worker's impact-selected tests stay its evidence.
  const step = await submitWork({ ...setup, attempt: laneA.id })
  assert.deepEqual([step.status, step.taskId, step.steps.map((entry) => entry.commit)], ['doing', 'T003', [first]])
  assert.equal((await workBoard({ ...setup, work: group.id })).tasks.find((entry) => entry.id === 'T003').runtimeStatus, 'doing')
  await assert.rejects(submitWork({ ...setup, attempt: laneA.id }), /T003: .*acceptance/)
  const last = await complete(laneA.workspace, 'T003')
  const ready = await submitWork({ ...setup, attempt: laneA.id, verify: [checkFile('T003.txt')] })
  assert.deepEqual([ready.status, ready.verifiedCommit], ['ready', last])
  const integrated = await deliver(setup, laneA, [checkFile('T002.txt'), checkFile('T003.txt')])
  assert.match(await git(group.path, 'log', '-1', '--format=%s').then((out) => out.stdout), /Integrate lane a \(T002 T003\)/)
  const archived = await readFile(path.join(group.path, 'spec/tasks/done/T002.lane.md'), 'utf8')
  assert.match(archived, new RegExp(`at: ${first}`))
  assert.match(archived, /verified: worker ran T002 tests; integration "node -e/)
  assert.match(await readFile(path.join(group.path, 'spec/tasks/done/T003.lane.md'), 'utf8'), new RegExp(`at: ${last}\\n- verified: "node -e .*T003.txt.*; integration`))
  const state = await readFile(path.join(group.path, 'spec/STATE.md'), 'utf8')
  assert.ok(!/\| T00[23] \|/.test(state))
  assert.match(state, /- \d{6} T002 T003 integrated/)
  assert.equal(integrated.status, 'integrated')

  await complete(laneB.workspace, 'T004')
  await submitWork({ ...setup, attempt: laneB.id })
  await deliver(setup, laneB, [checkFile('T004.txt')])
  const last5 = await claimNextWork({ ...setup, work: group.id, owner: 'c' })
  assert.deepEqual(last5.tasks, ['T005'])
  await assert.rejects(finishWork({ ...setup, work: group.id, verify: [checkFile('T001.txt')] }), /통합되지 않은/)
  await complete(last5.workspace, 'T005')
  await submitWork({ ...setup, attempt: last5.id })
  await deliver(setup, last5, [checkFile('T005.txt')])
  assert.equal((await nextWork({ ...setup, work: group.id, owner: 'x' })).action, 'complete')
  await assert.rejects(finishWork({ ...setup, work: group.id, verify: [checkFile('missing.txt')] }), /검증 실패/)
  const finished = await finishWork({ ...setup, work: group.id, verify: ['T001.txt', 'T002.txt', 'T003.txt', 'T004.txt', 'T005.txt'].map(checkFile) })
  assert.equal(finished.snapshotError, undefined)
  board = await workBoard({ ...setup, work: group.id })
  assert.equal(board.verified.commit, finished.verified.commit)
  assert.equal(board.verified.current, true)
  assert.equal(JSON.parse(await readFile(path.join(group.path, 'spec/work/lanes.json'), 'utf8')).group.verified.commit, finished.verified.commit)
  const { history } = await workHistory({ ...setup, work: group.id, task: 'T003' })
  assert.ok(history.some((entry) => entry.attemptId === laneA.id && entry.status === 'integrated'))
})

test('서로 기다리는 lane 계획은 배정 전에 거부한다', async (t) => {
  // The reported deadlock: T009 (lane c) waits for T005 (lane b), and T006 (lane b) waits for T009.
  const setup = await laneFixture(t, [['T005', '-', 'b'], ['T006', 'T009', 'b'], ['T009', 'T005', 'c']])
  const group = await startWork({ ...setup, name: 'deadlock' })
  const board = await workBoard({ ...setup, work: group.id })
  assert.ok(board.errors.some((error) => error.includes('lane 순환')), JSON.stringify(board.errors))
  await assert.rejects(claimNextWork({ ...setup, work: group.id, owner: 'a' }), /태스크\/STATE/)
})

test('blocked만 남으면 next는 stalled, review-claim --wait는 제출을 기다렸다 선점한다', async (t) => {
  const setup = await fixture(t)
  const group = await startWork({ ...setup, name: 'waiting' })
  const a = await claimWork({ ...setup, work: group.id, task: 'T001', owner: 'a' })
  const b = await claimWork({ ...setup, work: group.id, task: 'T002', owner: 'b' })
  const idle = await nextWork({ ...setup, work: group.id, owner: 'c' })
  assert.deepEqual([idle.action, idle.reason], ['wait', 'no-eligible-task'])
  const waitingReviewer = claimReviewWaiting({ ...setup, work: group.id, owner: 'r', wait: 60, pollMs: 50 })
  await implement(a)
  await submitWork({ ...setup, attempt: a.id, verify: checks })
  assert.equal((await waitingReviewer).attempt, a.id)
  await updateWork({ ...setup, attempt: b.id, status: 'blocked', reason: 'needs decision' })
  await releaseReview({ ...setup, review: (await inspectWork(setup)).attempts.find((entry) => entry.id === a.id).review.id })
  await updateWork({ ...setup, attempt: a.id, status: 'blocked', reason: 'needs decision' })
  const stalled = await nextWork({ ...setup, work: group.id, owner: 'd', wait: 60, pollMs: 50 })
  assert.equal(stalled.action, 'stalled')
  assert.deepEqual(stalled.blocked.map((entry) => entry.tasks).sort(), [['T001'], ['T002']])
  const own = await nextWork({ ...setup, work: group.id, owner: 'b' })
  assert.deepEqual([own.action, own.attempt.id], ['blocked', b.id])
})

test('세션 루프: 기반 → 리뷰 → 백그라운드 통합 → 줄기 분담 → 묶음 검증까지 자동으로 진행한다', async (t) => {
  const setup = await laneFixture(t, [['T001', '-', '-'], ['T002', 'T001', 'a'], ['T003', 'T002', 'a'], ['T004', 'T001', 'b'], ['T005', 'T003 T004', '-']])
  const log = path.join(setup.temporary, 'tiers.log')
  const record = `node -e "require('fs').appendFileSync('${log}', [process.env.HAERAM_TIER, process.env.HAERAM_TASK || '-', process.env.HAERAM_DIFF_BASE].join(' ') + String.fromCharCode(10))"`
  const tiers = { taskVerify: [record], verify: [record], groupVerify: [record, checkFile('T005.txt')], reviewers: 2 }
  const session = (owner, extra = {}) => nextWork({ ...setup, owner, pollMs: 100, ...extra })
  const review = async (assignment) => {
    assert.equal(assignment.action, 'review', JSON.stringify(assignment))
    await finishReview({ ...setup, review: assignment.review.id, result: { verdict: 'approved', summary: 'reviewed', findings: [] } })
  }
  // A lane is implemented to its last task and submitted once.
  const deliver = async (attempt) => {
    for (const id of attempt.tasks) await complete(attempt.workspace, id)
    const submitted = await submitWork({ ...setup, attempt: attempt.id })
    assert.equal(submitted.status, 'ready')
    return submitted
  }

  // Session A starts the group from the main checkout and takes the foundation first.
  const first = await session('a', { start: true, ...tiers })
  assert.deepEqual([first.action, first.attempt.tasks], ['implement', ['T001']])
  const work = first.work
  assert.equal((await session('b')).reason, 'no-eligible-task')
  await deliver(first.attempt)
  const alone = await session('a', { wait: 60 })
  assert.deepEqual([alone.action, alone.reason], ['wait', 'needs-reviewer'])
  // Session B reviews the foundation; the CLI integrates it in the background.
  await review(await session('b', { wait: 60 }))
  const ofB = await session('b', { wait: 120 })
  const ofA = await session('a', { wait: 60 })
  assert.deepEqual([ofB.attempt.lane, ofA.attempt.lane], ['a', 'b'])
  const readyA = await deliver(ofB.attempt)
  await deliver(ofA.attempt)
  await review(await session('a', { wait: 60 }))
  await review(await session('b', { wait: 60 }))
  // Both lanes integrate one after the other; the second approval survives the first.
  const last = await session('a', { wait: 180 })
  assert.deepEqual(last.attempt.tasks, ['T005'])
  await deliver(last.attempt)
  await review(await session('b', { wait: 60 }))
  const done = await session('a', { wait: 180 })
  assert.equal(done.action, 'complete', JSON.stringify(done))
  assert.equal(done.verified.current, true)
  assert.equal((await session('b')).action, 'complete')

  const board = await workBoard({ ...setup, work })
  assert.deepEqual(board.doneIds, ['T001', 'T002', 'T003', 'T004', 'T005'])
  assert.ok(board.attempts.every((entry) => entry.status === 'integrated' && !entry.reviewHistory), JSON.stringify(board.attempts.map((entry) => [entry.status, entry.reason, entry.reviewHistory])))
  const lines = (await readFile(log, 'utf8')).trim().split('\n').map((line) => line.split(' '))
  assert.deepEqual(readyA.steps.map((entry) => [entry.taskId, entry.commit]), [['T002', readyA.verifiedCommit], ['T003', readyA.verifiedCommit]])
  assert.ok(lines.some(([tier, id, base]) => tier === 'task' && id === 'T003' && base === ofB.attempt.startCommit), JSON.stringify(lines))
  assert.equal(lines.filter(([tier]) => tier === 'task').length, 4)
  assert.equal(lines.filter(([tier]) => tier === 'unit').length, 4)
  assert.deepEqual(lines.filter(([tier]) => tier === 'group').map(([, , base]) => base), [board.group.baseCommit])
})

test('백그라운드 통합이 실패하면 단위 소유자에게 수정 요청으로 돌아간다', async (t) => {
  const setup = await fixture(t)
  const group = await startWork({ ...setup, name: 'auto-correct', verify: [checkFile('never.txt')] })
  const attempt = await claimWork({ ...setup, work: group.id, task: 'T001', owner: 'a' })
  await implement(attempt)
  await submitWork({ ...setup, attempt: attempt.id })
  await approve(setup, attempt)
  await assert.rejects(integrateWork({ ...setup, attempt: attempt.id, autoCorrect: true }), /통합을 완료하지/)
  const next = await nextWork({ ...setup, work: group.id, owner: 'a' })
  assert.deepEqual([next.action, next.attempt.id, next.attempt.correction.findings[0].where], ['implement', attempt.id, 'integration'])
  assert.match(next.attempt.correction.findings[0].message, /never\.txt/)
})

async function laneAdapter(setup, log) {
  const adapter = path.join(setup.temporary, 'lane-adapter.mjs')
  await writeFile(adapter, `import fs from 'node:fs'; import {execFileSync} from 'node:child_process';
let input=''; for await(const chunk of process.stdin) input+=chunk;
const job=JSON.parse(input);
fs.appendFileSync(process.env.HAERAM_TEST_LOG, JSON.stringify({role:job.role,taskId:job.taskId,tasks:job.tasks,workspace:job.workspace})+'\\n');
if(job.role==='worker') {
 const file='spec/tasks/'+job.taskId+'.lane.md';
 fs.writeFileSync(file, fs.readFileSync(file,'utf8').replace('- [ ]','- [v]')+'- outcome: implemented\\n- at: -\\n- verified: fixture\\n- limits: -\\n');
 fs.writeFileSync(job.taskId+'.txt','done');
 execFileSync('git',['add','.']);execFileSync('git',['commit','-m','implement '+job.taskId]);
 process.stdout.write(JSON.stringify({outcome:'completed',summary:'done'}));
} else process.stdout.write(JSON.stringify({verdict:'approved',summary:'reviewed',findings:[]}));`)
  const config = path.join(setup.temporary, 'lane-adapter.json')
  await writeFile(config, JSON.stringify({ command: process.execPath, args: [adapter] }))
  return { adapter: config, env: { ...process.env, HAERAM_TEST_LOG: log } }
}

test('실행기는 lane 태스크를 같은 공간에 차례로 배정하고 묶음 완료 검증을 한 번 실행한다', async (t) => {
  const setup = await laneFixture(t, [['T001', '-', '-'], ['T002', 'T001', 'a'], ['T003', 'T002', 'a'], ['T004', 'T001', 'b'], ['T005', 'T004', 'b'], ['T006', 'T003 T005', '-']])
  const group = await startWork({ ...setup, name: 'lane-runner' })
  const log = path.join(setup.temporary, 'dispatch.log')
  const runner = await laneAdapter(setup, log)
  const bases = path.join(setup.temporary, 'bases.log')
  const record = `node -e "require('fs').appendFileSync('${bases}', process.env.HAERAM_TASK + ' ' + process.env.HAERAM_DIFF_BASE + String.fromCharCode(10))"`
  const result = await runWork({ ...setup, work: group.id, ...runner,
    taskVerify: [checkFile('spec/STATE.md'), record], verify: [checkFile('spec/ssot/ARCH.md')], groupVerify: [checkFile('T006.txt')] })
  assert.equal(result.outcome, 'completed', JSON.stringify(result))
  assert.deepEqual(result.failures, [])
  assert.deepEqual(result.attempts.map((entry) => entry.status), ['integrated', 'integrated', 'integrated', 'integrated'])
  const jobs = (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
  const workers = jobs.filter((job) => job.role === 'worker')
  assert.deepEqual(workers.map((job) => job.taskId).sort(), ['T001', 'T002', 'T003', 'T004', 'T005', 'T006'])
  assert.equal(jobs.filter((job) => job.role === 'reviewer').length, 4)
  const where = Object.fromEntries(workers.map((job) => [job.taskId, job.workspace]))
  assert.equal(where.T002, where.T003)
  assert.equal(where.T004, where.T005)
  assert.notEqual(where.T002, where.T004)
  assert.deepEqual(workers.find((job) => job.taskId === 'T003').tasks, ['T002', 'T003'])
  assert.ok(result.finish.commit)
  const board = await workBoard({ ...setup, work: group.id })
  assert.equal(board.verified.current, true)
  // Each lane step's checks see only that task's changes.
  const laneA = board.attempts.find((entry) => entry.lane === 'a')
  const stepBase = Object.fromEntries((await readFile(bases, 'utf8')).trim().split('\n').map((line) => line.split(' ')))
  assert.equal(stepBase.T003, laneA.steps.find((entry) => entry.taskId === 'T002').commit)
  assert.match(await readFile(path.join(group.path, 'spec/tasks/done/T003.lane.md'), 'utf8'), /verified: "node -e .*STATE\.md.*"; ".*"; integration "node -e .*ARCH\.md/)
})

test('runner가 lane 중간에 멈추면 다음 runner가 같은 공간에서 이어받는다', async (t) => {
  const setup = await laneFixture(t, [['T001', '-', 'a'], ['T002', 'T001', 'a']])
  const group = await startWork({ ...setup, name: 'lane-resume' })
  const log = path.join(setup.temporary, 'dispatch.log')
  const runner = await laneAdapter(setup, log)
  const stopped = await runWork({ ...setup, work: group.id, ...runner, verify: [checkFile('T001.txt')], maxDispatches: 1 })
  assert.equal(stopped.outcome, 'dispatch-limit')
  assert.deepEqual(stopped.attempts.map(({ taskId, status }) => [taskId, status]), [['T002', 'doing']])
  const resumed = await runWork({ ...setup, work: group.id, ...runner, verify: [checkFile('T001.txt'), checkFile('T002.txt')] })
  assert.equal(resumed.outcome, 'completed', JSON.stringify(resumed))
  assert.deepEqual(resumed.attempts.map((entry) => entry.status), ['integrated'])
  const workers = (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line)).filter((job) => job.role === 'worker')
  assert.deepEqual(workers.map((job) => job.taskId), ['T001', 'T002'])
  assert.equal(workers[0].workspace, workers[1].workspace)
})
