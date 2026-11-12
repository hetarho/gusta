import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm, rename, realpath, access } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { execute, git } from './helpers/vibe-fixture.mjs'
import { vibePlanSync, vibePlanPush } from '../src/vibe-plan.mjs'

const STATE = `# STATE
> state

## cfg
- level: expert
- lang: ko
- docs: en
- push: -
- plan: main

## ssot
| id | rev | tasked | pending | [?] |
|---|---|---|---|---|
| ARCH | 1 | 1 | - | 0 |

## tasks
| id | title | ssot | dep | st |
|---|---|---|---|---|
| T001 | first | ARCH | - | todo |

## next
- gusta-implement-task T001

## log
- 261012 gusta-create-task ARCH
`
const task = (id, title) => `# ${id} ${title}\n> st:todo | ssot:ARCH-1 | base:ARCH@1 | dep:-\n\n## goal\n${title}\n\n## acceptance\n- [ ] works\n\n## impl notes\n- -\n\n## result\n`
const present = (file) => access(file).then(() => true, () => false)

async function configure(root, temporary) {
  for (const [key, value] of [['user.name', 'Test'], ['user.email', 'test@example.com'], ['commit.gpgsign', 'false'], ['core.hooksPath', path.join(temporary, 'no-hooks')]]) await git(root, 'config', key, value)
}

// A main checkout and two feature worktrees, optionally sharing a bare remote.
async function project(t, { remote = true } = {}) {
  const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), 'gusta-plan-')))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const main = path.join(temporary, 'main')
  await execute('git', ['init', '-q', '-b', 'main', main])
  await configure(main, temporary)
  await mkdir(path.join(main, 'spec/tasks/done'), { recursive: true })
  await mkdir(path.join(main, 'src'), { recursive: true })
  await writeFile(path.join(main, 'spec/STATE.md'), STATE)
  await writeFile(path.join(main, 'spec/tasks/T001.first.md'), task('T001', 'first'))
  await writeFile(path.join(main, 'spec/tasks/done/.keep'), '')
  await writeFile(path.join(main, 'src/app.js'), 'export const app = 1\n')
  await git(main, 'add', '-A'); await git(main, 'commit', '-q', '-m', 'init')
  let origin = null
  if (remote) {
    origin = path.join(temporary, 'origin.git')
    await execute('git', ['init', '-q', '--bare', '-b', 'main', origin])
    await git(main, 'remote', 'add', 'origin', origin)
    await git(main, 'push', '-q', 'origin', 'main')
  }
  const worktree = async (name) => {
    const directory = path.join(temporary, name)
    await git(main, 'worktree', 'add', '-q', '-b', name, directory)
    return directory
  }
  return { temporary, main, origin, one: await worktree('feat-one'), two: await worktree('feat-two') }
}

// What gusta-create-task writes: one task file and its STATE row, committed alone.
async function planTask(root, id, title) {
  await writeFile(path.join(root, `spec/tasks/${id}.${title}.md`), task(id, title))
  const state = await readFile(path.join(root, 'spec/STATE.md'), 'utf8')
  await writeFile(path.join(root, 'spec/STATE.md'), state.replace('\n\n## next', `\n| ${id} | ${title} | ARCH | - | todo |\n\n## next`))
  await git(root, 'add', '-A'); await git(root, 'commit', '-q', '-m', `gusta-create-task ${id}`)
}

test('두 worktree가 같은 번호를 만들면 먼저 올린 쪽이 이기고, 진 쪽은 다시 채번해 올린다', async (t) => {
  const { main, origin, one, two } = await project(t)
  await planTask(one, 'T002', 'alpha')
  await planTask(two, 'T002', 'beta')
  // Code in a worktree stays there; only the spec commit reaches main.
  await writeFile(path.join(one, 'src/app.js'), 'export const app = 2\n')
  await git(one, 'commit', '-qam', 'code')
  await assert.rejects(vibePlanPush({ targetRoot: one }), /spec\/ 밖 변경/)
  const first = await vibePlanPush({ targetRoot: one, commit: ['HEAD~1'] })
  assert.equal(first.ok, true)
  assert.equal(first.remote, true)
  assert.equal(first.local, 'ff')
  assert.equal(await git(origin, 'rev-parse', 'main'), first.published)
  assert.equal(await git(origin, 'show', 'main:src/app.js'), 'export const app = 1')
  // A planning commit straight on main is published as is; the clean main checkout follows.
  assert.equal(first.published, await git(one, 'rev-parse', 'HEAD~1'))
  assert.equal(first.merge, 'none')
  assert.ok(await present(path.join(main, 'spec/tasks/T002.alpha.md')))

  await assert.rejects(vibePlanPush({ targetRoot: two }), (error) => /태스크 ID 충돌/.test(error.message) && error.details.some((line) => line.startsWith('T002:')))
  await assert.rejects(vibePlanSync({ targetRoot: two }), /태스크 ID 충돌/)
  // Renumber the unpublished planning commit and publish again.
  await rename(path.join(two, 'spec/tasks/T002.beta.md'), path.join(two, 'spec/tasks/T003.beta.md'))
  await writeFile(path.join(two, 'spec/tasks/T003.beta.md'), task('T003', 'beta'))
  const state = await readFile(path.join(two, 'spec/STATE.md'), 'utf8')
  await writeFile(path.join(two, 'spec/STATE.md'), state.replace('| T002 | beta |', '| T003 | beta |'))
  await git(two, 'add', '-A'); await git(two, 'commit', '-q', '--amend', '--no-edit')
  const second = await vibePlanPush({ targetRoot: two })
  assert.deepEqual([second.ok, second.merge], [true, 'merge'])
  assert.notEqual(second.published, await git(two, 'rev-parse', 'HEAD^1'))
  const remoteState = await git(origin, 'show', 'main:spec/STATE.md')
  assert.match(remoteState, /\| T002 \| alpha \|[\s\S]*\| T003 \| beta \|/)
  assert.match(await readFile(path.join(two, 'spec/STATE.md'), 'utf8'), /\| T002 \| alpha \|/)
  assert.deepEqual(await vibePlanPush({ targetRoot: two, commit: [second.published] }), { schemaVersion: 1, ok: true, pushed: null, reason: 'up-to-date', plan: 'main' })
  // The first worktree picks up the newer planning before its next numbering.
  assert.equal((await vibePlanSync({ targetRoot: one })).action, 'merge')
  assert.ok(await present(path.join(one, 'spec/tasks/T003.beta.md')))
  assert.equal(await readFile(path.join(one, 'src/app.js'), 'utf8'), 'export const app = 2\n')
})

test('원격이 없으면 로컬 main에 반영하고, main checkout이 더러우면 거절한다', async (t) => {
  const { main, one } = await project(t, { remote: false })
  await planTask(one, 'T002', 'alpha')
  await writeFile(path.join(main, 'src/app.js'), 'export const app = 9\n')
  await assert.rejects(vibePlanPush({ targetRoot: one }), /로컬 기획 브랜치 main/)
  await git(main, 'checkout', '-q', '--', 'src/app.js')
  const result = await vibePlanPush({ targetRoot: one })
  assert.deepEqual([result.ok, result.pushed, result.local, result.merge], [true, null, 'ff', 'none'])
  assert.equal(await git(main, 'rev-parse', 'HEAD'), result.published)
  assert.ok(await present(path.join(main, 'spec/tasks/T002.alpha.md')))
  // Planning on main itself has nothing to publish.
  await planTask(main, 'T003', 'beta')
  assert.equal((await vibePlanPush({ targetRoot: main })).reason, 'up-to-date')
})

test('발행 뒤 worktree가 태스크를 완료 처리해도 main에 합칠 때 todo가 되살아나지 않는다', async (t) => {
  const { main, one } = await project(t)
  await planTask(one, 'T002', 'alpha')
  await vibePlanPush({ targetRoot: one })
  await rename(path.join(one, 'spec/tasks/T002.alpha.md'), path.join(one, 'spec/tasks/done/T002.alpha.md'))
  const state = await readFile(path.join(one, 'spec/STATE.md'), 'utf8')
  await writeFile(path.join(one, 'spec/STATE.md'), state.replace('| T002 | alpha | ARCH | - | todo |\n', ''))
  await git(one, 'add', '-A'); await git(one, 'commit', '-q', '-m', 'archive T002')
  await git(main, 'merge', '-q', '--no-edit', 'feat-one')
  assert.equal(await present(path.join(main, 'spec/tasks/T002.alpha.md')), false)
  assert.ok(await present(path.join(main, 'spec/tasks/done/T002.alpha.md')))
  assert.doesNotMatch(await readFile(path.join(main, 'spec/STATE.md'), 'utf8'), /\| T002 \|/)
})

test('cfg plan이 -이면 아무것도 하지 않는다', async (t) => {
  const { one } = await project(t)
  const state = await readFile(path.join(one, 'spec/STATE.md'), 'utf8')
  await writeFile(path.join(one, 'spec/STATE.md'), state.replace('- plan: main', '- plan: -'))
  await git(one, 'commit', '-qam', 'opt out')
  assert.equal((await vibePlanSync({ targetRoot: one })).reason, 'plan-disabled')
  assert.equal((await vibePlanPush({ targetRoot: one })).reason, 'plan-disabled')
})
