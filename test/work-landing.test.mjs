import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { startWork, claimWork, claimNextWork, submitWork, integrateWork, finishWork, workBoard, workBrief, updateWork, syncWork } from '../src/work-groups.mjs'
import { nextWork } from '../src/work-wait.mjs'
import { claimReview, finishReview, resumeWork } from '../src/work-review.mjs'

const execute = promisify(execFile)
const git = (cwd, ...args) => execute('git', ['-C', cwd, ...args], { encoding: 'utf8' })
const commit = async (cwd, message = 'change') => {
  await git(cwd, 'add', '-A')
  await git(cwd, 'commit', '-q', '-m', message)
  return (await git(cwd, 'rev-parse', 'HEAD')).stdout.trim()
}
const always = 'node -e "0"'

const taskFile = (id, { dep = '-', touches = '-', explore = '', acceptance = '- [ ] result exists' } = {}) =>
  `# ${id} example\n> st:todo | ssot:ARCH-1 | base:ARCH@1 | dep:${dep} | touches:${touches}${explore ? ` | explore:${explore}` : ''}\n\n## goal\nimplement ${id}\n\n## acceptance\n${acceptance}\n\n## impl notes\n- keep contracts\n\n## result\n`

// tasks: [{ id, title, ...taskFile options }]
async function fixture(t, tasks) {
  const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), 'gusta-landing-')))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const root = path.join(temporary, 'repo')
  await mkdir(path.join(root, 'spec/tasks'), { recursive: true })
  await mkdir(path.join(root, 'spec/ssot'), { recursive: true })
  await git(temporary, 'init', '-q', '-b', 'trunk', root)
  for (const [key, value] of [['user.name', 'Test'], ['user.email', 'test@example.com'], ['commit.gpgsign', 'false'], ['core.hooksPath', path.join(temporary, 'no-hooks')]]) await git(root, 'config', key, value)
  const rows = tasks.map((task) => `| ${task.id} | ${task.title} | ARCH | ${task.dep ?? '-'} | todo |`).join('\n')
  await writeFile(path.join(root, 'spec/FORMAT.md'), '# FORMAT\n')
  await writeFile(path.join(root, 'spec/STATE.md'), `# STATE\n\n## cfg\n- level: expert\n- lang: ko\n- docs: en\n- push: trunk\n\n## ssot\n| id | rev | tasked | pending | [?] |\n|---|---|---|---|---|\n| ARCH | 1 | 1 | - | 0 |\n\n## tasks\n| id | title | ssot | dep | st |\n|---|---|---|---|---|\n${rows}\n\n## next\n- gusta-implement-task\n\n## log\n- 261012 gusta-create-task ARCH\n`)
  await writeFile(path.join(root, 'spec/ssot/ARCH.md'), '# ARCH architecture\n> r1 | architecture\n\n## decisions\n- ARCH-1 [o] runtime: node\n  - only LTS releases\n- ARCH-2 [o] tests: node --test\n\n## chg\n- r1 260924 initial\n')
  for (const task of tasks) await writeFile(path.join(root, `spec/tasks/${task.id}.${task.title}.md`), taskFile(task.id, task))
  await commit(root, 'spec')
  return { temporary, root, targetRoot: root }
}

async function implement(attempt, files = { 'one.txt': 'result\n' }) {
  const name = (await execute('ls', [path.join(attempt.workspace, 'spec/tasks')], { encoding: 'utf8' })).stdout.split('\n').find((entry) => entry.startsWith(`${attempt.taskId}.`))
  const file = path.join(attempt.workspace, 'spec/tasks', name)
  const content = await readFile(file, 'utf8')
  if (!content.includes('- outcome:')) await writeFile(file, content.replaceAll('- [ ]', '- [v]') + '- outcome: implemented\n- at: -\n- verified: pending submit\n- limits: -\n')
  for (const [relative, value] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(attempt.workspace, relative)), { recursive: true })
    await writeFile(path.join(attempt.workspace, relative), value)
  }
  return commit(attempt.workspace, `implement ${attempt.taskId}`)
}

async function approve(setup, attempt) {
  const review = await claimReview({ ...setup, work: attempt.group, attempt: attempt.id, owner: 'reviewer' })
  assert.ok(review.id, JSON.stringify(review))
  return finishReview({ ...setup, review: review.id, result: { verdict: 'approved', summary: 'reviewed', findings: [] } })
}

test('explore 태스크와 그 후속은 배정하지 않고, 묶음은 그 둘을 남긴 채 main-session으로 끝난다', async (t) => {
  const setup = await fixture(t, [{ id: 'T001', title: 'first' }, { id: 'T002', title: 'calibrate', explore: '2h', acceptance: '- [ ] bands measured\n- [ ] exit: record the table and finish' }, { id: 'T003', title: 'after', dep: 'T002' }])
  const group = await startWork({ ...setup, name: 'feature', verify: [always] })
  await assert.rejects(claimWork({ ...setup, work: group.id, task: 'T002' }), /explore 태스크와 그 후속/)
  const first = await claimNextWork({ ...setup, work: group.id, owner: 'a' })
  assert.equal(first.taskId, 'T001')
  assert.equal((await claimNextWork({ ...setup, work: group.id, owner: 'b' })).reason, 'no-eligible-task')
  const board = await workBoard({ ...setup, work: group.id })
  assert.deepEqual(board.tasks.filter((task) => task.mainSession).map((task) => task.id), ['T002', 'T003'])
  await implement(first)
  await submitWork({ ...setup, attempt: first.id })
  await approve(setup, first)
  await integrateWork({ ...setup, attempt: first.id })
  const next = await nextWork({ ...setup, work: group.id, owner: 'a' })
  assert.equal(next.action, 'main-session')
  assert.deepEqual(next.tasks, ['T002', 'T003'])
  const finished = await finishWork({ ...setup, work: group.id, verify: [always] })
  assert.ok(finished.verified.commit)
})

test('push 브랜치가 있으면 통합마다 반영하고, 원격이 앞서 있으면 먼저 합친 뒤 검증한다', async (t) => {
  const setup = await fixture(t, [{ id: 'T001', title: 'first' }, { id: 'T002', title: 'second' }])
  const remote = path.join(setup.temporary, 'remote.git')
  await execute('git', ['init', '-q', '--bare', '-b', 'trunk', remote])
  await git(setup.root, 'remote', 'add', 'origin', remote)
  await git(setup.root, 'push', '-q', 'origin', 'trunk')
  const group = await startWork({ ...setup, name: 'feature', verify: [always], push: 'trunk' })
  assert.equal(group.push, 'trunk')
  const first = await claimWork({ ...setup, work: group.id, task: 'T001' })
  await implement(first)
  await submitWork({ ...setup, attempt: first.id })
  await approve(setup, first)
  const landed = await integrateWork({ ...setup, attempt: first.id })
  assert.equal(landed.pushed.error, undefined)
  assert.equal((await execute('git', ['--git-dir', remote, 'rev-parse', 'trunk'], { encoding: 'utf8' })).stdout.trim(), landed.integratedCommit)
  // Another machine lands a change on trunk and logs it in STATE.
  const other = path.join(setup.temporary, 'other')
  await execute('git', ['clone', '-q', remote, other])
  for (const [key, value] of [['user.name', 'Other'], ['user.email', 'other@example.com'], ['commit.gpgsign', 'false']]) await git(other, 'config', key, value)
  await writeFile(path.join(other, 'elsewhere.txt'), 'from the other machine\n')
  const state = path.join(other, 'spec/STATE.md')
  await writeFile(state, (await readFile(state, 'utf8')).replace('## log\n', '## log\n- 261013 other machine: hotfix\n'))
  await commit(other, 'hotfix elsewhere')
  await git(other, 'push', '-q', 'origin', 'trunk')
  // A checkpoint on the group branch now diverges from trunk: its push is refused and recorded.
  const saved = await syncWork({ ...setup, work: group.id })
  assert.match(saved.pushed.error, /rejected|fetch first|non-fast-forward/)
  const second = await claimWork({ ...setup, work: group.id, task: 'T002' })
  await implement(second, { 'two.txt': 'second\n' })
  await submitWork({ ...setup, attempt: second.id })
  await approve(setup, second)
  const both = await integrateWork({ ...setup, attempt: second.id, verify: ['node -e "require(\'fs\').accessSync(\'elsewhere.txt\')"'] })
  assert.equal(both.pushed.error, undefined)
  const trunk = (await execute('git', ['--git-dir', remote, 'show', 'trunk:spec/STATE.md'], { encoding: 'utf8' })).stdout
  assert.match(trunk, /- 261013 other machine: hotfix/)
  assert.match(trunk, /T002 integrated/)
  assert.equal((await execute('git', ['--git-dir', remote, 'show', 'trunk:elsewhere.txt'], { encoding: 'utf8' })).stdout, 'from the other machine\n')
})

test('risky 정책: touches 안의 작은 변경에 테스트가 있으면 정책 승인, 아니면 리뷰로 간다', async (t) => {
  const setup = await fixture(t, [{ id: 'T001', title: 'first', touches: 'src/' }, { id: 'T002', title: 'second', touches: 'lib/' }])
  const group = await startWork({ ...setup, name: 'feature', verify: [always] })
  const safe = await claimWork({ ...setup, work: group.id, task: 'T001' })
  await implement(safe, { 'src/sum.js': 'module.exports = (a, b) => a + b\n', 'src/sum.test.js': "require('assert').equal(require('./sum')(1, 2), 3)\n" })
  const approved = await submitWork({ ...setup, attempt: safe.id })
  assert.equal(approved.status, 'approved')
  assert.equal(approved.review.owner, 'policy')
  assert.equal(approved.risk.risky, false)
  const risky = await claimWork({ ...setup, work: group.id, task: 'T002' })
  await implement(risky, { 'lib/a.js': 'x\n', 'outside.txt': 'y\n' })
  const ready = await submitWork({ ...setup, attempt: risky.id })
  assert.equal(ready.status, 'ready')
  assert.deepEqual(ready.risk.reasons, ['outside touches: outside.txt', 'no test file changed'])
  const all = await startWork({ ...setup, name: 'strict', verify: [always], review: 'all' })
  assert.equal(all.review, 'all')
})

test('재제출은 고친 커밋부터의 변경만 GUSTA_DIFF_BASE로 넘기고, 같은 트리의 검사는 다시 돌리지 않는다', async (t) => {
  const setup = await fixture(t, [{ id: 'T001', title: 'first' }])
  const record = path.join(setup.temporary, 'bases.txt')
  const taskVerify = `node -e "require('fs').appendFileSync('${record}', process.env.GUSTA_DIFF_BASE + '\\n')"`
  const counted = path.join(setup.temporary, 'runs.txt')
  const plain = `node -e "require('fs').appendFileSync('${counted}', 'x')"`
  const group = await startWork({ ...setup, name: 'feature', verify: [always], taskVerify: [taskVerify, plain] })
  const attempt = await claimWork({ ...setup, work: group.id, task: 'T001' })
  const firstCommit = await implement(attempt)
  await submitWork({ ...setup, attempt: attempt.id })
  // The same commit submitted again: the plain check passed on this tree already.
  await updateWork({ ...setup, attempt: attempt.id, status: 'doing' })
  const again = await submitWork({ ...setup, attempt: attempt.id })
  assert.equal((await readFile(counted, 'utf8')).length, 1)
  assert.ok(again.verification.find((entry) => entry.command === plain).cached)
  const review = await claimReview({ ...setup, work: group.id, owner: 'reviewer' })
  await finishReview({ ...setup, review: review.id, result: { verdict: 'changes_requested', summary: 'fix', findings: [{ priority: 'P2', where: 'one.txt', message: 'wrong' }] } })
  await resumeWork({ ...setup, work: group.id, owner: 'worker' })
  await implement(attempt, { 'one.txt': 'fixed\n' })
  await submitWork({ ...setup, attempt: attempt.id })
  const bases = (await readFile(record, 'utf8')).trim().split('\n')
  assert.equal(bases.at(-1), firstCommit)
  assert.notEqual(bases[0], firstCommit)
})

test('work brief는 단위의 태스크, 인용한 결정 블록, 저장된 검증 명령을 준다', async (t) => {
  const setup = await fixture(t, [{ id: 'T001', title: 'first' }])
  const group = await startWork({ ...setup, name: 'feature', verify: ['npm test'], taskVerify: ['npm run lint'] })
  const attempt = await claimWork({ ...setup, work: group.id, task: 'T001' })
  const brief = await workBrief({ ...setup, attempt: attempt.id })
  assert.equal(brief.tasks.length, 1)
  assert.match(brief.tasks[0].content, /## result/)
  // pre-0.7 fields keep their meaning; each decision now also says why and where it came from
  assert.deepEqual(brief.decisions[0], { ...brief.decisions[0], id: 'ARCH-1', text: '- ARCH-1 [o] runtime: node\n  - only LTS releases' })
  assert.deepEqual(brief.decisions.map((entry) => [entry.id, entry.via[0].kind]), [['ARCH-1', 'cited'], ['ARCH-2', 'always']])
  assert.deepEqual(brief.verify, { task: ['npm run lint'], unit: ['npm test'] })
  assert.equal(brief.taskId, 'T001')
  assert.deepEqual([brief.source.kind, brief.source.commit, brief.complete], ['commit', brief.commit, true])
  assert.equal(brief.domains[0].path, 'spec/ssot/ARCH.md')
})
