import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { inspectWorkspace, readTaskBoard } from '../src/index.mjs'

const execute = promisify(execFile)
const cli = fileURLToPath(new URL('../bin/gusta.mjs', import.meta.url))
const git = (cwd, ...args) => execute('git', ['-C', cwd, ...args])

async function fixture(t, committed = true) {
  const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), 'gusta-workspace-')))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const root = path.join(temporary, 'project with spaces')
  await mkdir(root)
  await git(root, 'init', '-b', 'trunk')
  if (committed) await git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'initial')
  return { root, temporary }
}

const task = (id, deps = '-', st = 'todo') => `# ${id} example\n> st:${st} | ssot:ARCH-1 | base:ARCH@1 | dep:${deps}\n\n## goal\nexample\n\n## acceptance\n- [ ] works\n\n## impl notes\n\n## result\n`

async function writeTasks(root, entries) {
  await mkdir(path.join(root, 'spec', 'tasks', 'done'), { recursive: true })
  for (const [file, content] of Object.entries(entries)) await writeFile(path.join(root, 'spec', 'tasks', file), content)
}

test('외부 경로·임의 브랜치의 linked worktree는 같은 common dir, 다른 git dir을 갖는다', async (t) => {
  const { root, temporary } = await fixture(t)
  const linked = path.join(temporary, 'outside tree')
  await git(root, 'worktree', 'add', '-b', 'provider/issue-123', linked)
  await git(root, 'worktree', 'lock', '--reason', 'external owner', linked)
  const nested = path.join(linked, 'nested')
  await mkdir(nested)
  const alias = path.join(temporary, 'alias')
  await symlink(nested, alias, 'dir')
  const before = await git(root, 'status', '--porcelain')
  const primary = await inspectWorkspace({ targetRoot: root })
  const external = await inspectWorkspace({ targetRoot: alias })
  assert.equal(primary.git.commonDir, external.git.commonDir)
  assert.notEqual(primary.git.gitDir, external.git.gitDir)
  assert.equal(external.git.root, linked)
  assert.equal(external.git.branch, 'provider/issue-123')
  assert.equal(external.git.isLinkedWorktree, true)
  assert.equal(primary.git.isLinkedWorktree, false)
  assert.equal(external.git.worktrees.find((tree) => tree.path === linked).locked, 'external owner')
  assert.equal((await git(root, 'status', '--porcelain')).stdout, before.stdout)
})

test('detached HEAD와 첫 커밋 전 저장소를 구분한다', async (t) => {
  const { root, temporary } = await fixture(t)
  const detached = path.join(temporary, 'detached')
  await git(root, 'worktree', 'add', '--detach', detached)
  const result = await inspectWorkspace({ targetRoot: detached })
  assert.equal(result.git.branch, null)
  assert.equal(result.git.detached, true)
  assert.match(result.git.head, /^[a-f0-9]{40,64}$/)
  const unborn = await fixture(t, false)
  const initial = await inspectWorkspace({ targetRoot: unborn.root })
  assert.equal(initial.git.branch, 'trunk')
  assert.equal(initial.git.head, null)
  assert.equal(initial.git.detached, false)
  assert.equal(initial.git.worktrees[0].head, null)
})

test('Git이 없는 프로젝트와 bare 저장소를 checkout으로 오인하지 않는다', async (t) => {
  const { root, temporary } = await fixture(t)
  const outside = await inspectWorkspace({ targetRoot: temporary })
  assert.equal(outside.git, null)
  const bare = path.join(temporary, 'bare.git')
  await git(root, 'clone', '--bare', root, bare)
  const result = await inspectWorkspace({ targetRoot: bare })
  assert.equal(result.git, null)
  assert.ok(result.warnings.some((warning) => warning.includes('bare')))
  await assert.rejects(inspectWorkspace({ targetRoot: path.join(temporary, 'missing') }), { code: 'ENOENT' })
})

test('board는 현재 checkout 파일에서 파생하고 다른 worktree의 완료를 섞지 않는다', async (t) => {
  const { root, temporary } = await fixture(t)
  await writeTasks(root, { 'T002.api.md': task('T002', 'T001'), 'T001.base.md': task('T001') })
  await git(root, 'add', 'spec')
  await git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '-m', 'tasks')
  const linked = path.join(temporary, 'worker')
  await git(root, 'worktree', 'add', '-b', 'feature', linked)
  await rm(path.join(linked, 'spec/tasks/T001.base.md'))
  await writeTasks(linked, { 'done/T001.base.md': 'history deliberately not parsed' })
  const main = await readTaskBoard({ targetRoot: root })
  const worker = await readTaskBoard({ targetRoot: linked })
  assert.equal(main.scope, 'checkout')
  assert.deepEqual(main.errors, [])
  assert.equal(main.tasks.find((entry) => entry.id === 'T002').dependencyReady, false)
  assert.deepEqual(worker.errors, [])
  assert.equal(worker.tasks[0].dependencyReady, true)
  assert.deepEqual(worker.doneIds, ['T001'])
})

test('board는 오래된 STATE를 경고하고 파일의 st·dep을 보여준다', async (t) => {
  const { root } = await fixture(t)
  await writeTasks(root, { 'T002.api.md': task('T002', 'T001'), 'done/T001.base.md': '' })
  await writeFile(path.join(root, 'spec/STATE.md'), '## tasks\n| id | title | ssot | dep | st |\n|---|---|---|---|---|\n| T002 | old | ARCH | - | doing@260922.ab |\n')
  const board = await readTaskBoard({ targetRoot: root })
  assert.equal(board.tasks[0].st, 'todo')
  assert.deepEqual(board.tasks[0].deps, ['T001'])
  assert.equal(board.warnings.filter((warning) => warning.includes('다릅니다')).length, 2)
})

test('board는 순환·누락 dep·중복 ID를 오류로 표시하고 준비 판정을 하지 않는다', async (t) => {
  const { root } = await fixture(t)
  await writeTasks(root, {
    'T001.base.md': task('T001', 'T002'),
    'T002.api.md': task('T002', 'T001 T999'),
    'T003.one.md': task('T003'), 'T003.two.md': task('T003'),
    'done/T004.one.md': '', 'done/T004.two.md': '',
  })
  const result = await readTaskBoard({ targetRoot: root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('T001 → T002 → T001')))
  assert.ok(result.errors.some((error) => error.includes('dep T999')))
  assert.ok(result.errors.some((error) => error.includes('중복: T003')))
  assert.ok(result.errors.some((error) => error.includes('중복: T004')))
  assert.equal(result.tasks.some((entry) => entry.dependencyReady), false)
})

test('board JSON 오류 응답도 파싱 가능하고 exit code가 1이다', async (t) => {
  const { root } = await fixture(t)
  await assert.rejects(execute(process.execPath, [cli, 'board', '--target', root, '--json']), (error) => {
    assert.equal(error.code, 1)
    const result = JSON.parse(error.stdout)
    assert.equal(result.ok, false)
    assert.ok(result.errors.some((message) => message.includes('부트스트랩')))
    assert.equal(error.stderr, '')
    return true
  })
  const { stdout } = await execute(process.execPath, [cli, 'context', '--target', root, '--json'])
  assert.equal(JSON.parse(stdout).git.branch, 'trunk')
})

test('board는 Git 없는 프로젝트에서도 동작하고 잘못된 파일·상태를 거부한다', async (t) => {
  const { temporary } = await fixture(t)
  await writeTasks(temporary, { 'T001.test.md': task('T002', '-', 'ready'), 'unknown.md': '' })
  const result = await readTaskBoard({ targetRoot: temporary })
  assert.equal(result.workspace.git, null)
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('ID가 파일명과 다릅니다')))
  assert.ok(result.errors.some((error) => error.includes('st 형식 오류')))
  assert.ok(result.errors.some((error) => error.includes('T###.<slug>.md')))
})
