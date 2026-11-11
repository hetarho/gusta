import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { parseBatch, batchShow, showMany, git, inspectWorkspace } from '../src/workspace.mjs'
import { readTaskBoard } from '../src/task-board.mjs'

const execute = promisify(execFile)
const sha = 'a'.repeat(40)
const entry = (type, content) => Buffer.concat([Buffer.from(`${sha} ${type} ${Buffer.byteLength(content)}\n`), Buffer.from(content), Buffer.from('\n')])

test('parseBatch: byte sizes, missing objects and unknown answers', () => {
  const output = Buffer.concat([entry('blob', 'ü\nline\n'), Buffer.from('x:y missing\n'), Buffer.from('abc ambiguous\n'), entry('tree', 'raw')])
  assert.deepEqual(parseBatch(output, 4), [{ type: 'blob', size: 8, content: 'ü\nline\n' }, null, undefined, { type: 'tree', size: 3, content: 'raw' }])
  assert.deepEqual(parseBatch(Buffer.from(''), 1), [undefined])
})

test('batchShow answers only what show would print byte for byte; the rest stays for show', async () => {
  const calls = []
  const batch = async (cwd, args, input) => {
    calls.push({ cwd, args, input })
    return Buffer.concat([entry('blob', 'one'), Buffer.from('c:missing.md missing\n'), entry('tree', 'raw')])
  }
  const answers = await batchShow('/repo', ['c:one.md', 'c:missing.md', 'c:dir.md', 'c:new\nline.md'], batch)
  assert.deepEqual(answers, ['one', null, undefined, undefined])
  assert.deepEqual(calls, [{ cwd: '/repo', args: ['cat-file', '--batch'], input: 'c:one.md\nc:missing.md\nc:dir.md\n' }])
  // A failed batch (not a repository, git missing) leaves every spec to show.
  assert.deepEqual(await batchShow('/repo', ['c:a'], async () => { throw Object.assign(new Error('fatal'), { code: 128 }) }), [undefined])
  // Nothing to ask: no process.
  assert.deepEqual(await batchShow('/repo', ['x\ny'], () => assert.fail('no batch')), [undefined])
})

test('showMany shows on its own exactly what the batch could not answer', async () => {
  const shown = []
  const result = await showMany('/repo', ['c:one.md', 'c:dir.md'], {
    batch: async () => Buffer.concat([entry('blob', 'one'), entry('tree', 'raw')]),
    show: async (spec) => { shown.push(spec); return `shown ${spec}` },
  })
  assert.deepEqual(result, ['one', 'shown c:dir.md'])
  assert.deepEqual(shown, ['c:dir.md'])
})

test('showMany equals git show for blobs, missing paths, trees and odd names in a real repository', async (t) => {
  const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), 'haeram-batch-')))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const root = path.join(temporary, 'repo with spaces')
  await mkdir(path.join(root, 'spec/tasks/T009.dir.md'), { recursive: true })
  await execute('git', ['init', '-q', '-b', 'trunk', root])
  await writeFile(path.join(root, 'spec/tasks/T001.a b.md'), '# T001 ü\n> st:todo\n')
  await writeFile(path.join(root, 'spec/tasks/T009.dir.md/inner'), 'inner\n')
  await writeFile(path.join(root, 'spec/STATE.md'), '')
  await execute('git', ['-C', root, 'add', '.'])
  await execute('git', ['-C', root, '-c', 'user.name=T', '-c', 'user.email=t@e', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'c'])
  const commit = (await git(root, ['rev-parse', 'HEAD'])).trim()
  const specs = ['spec/tasks/T001.a b.md', 'spec/tasks/T009.dir.md', 'spec/STATE.md', 'spec/none.md', 'spec/new\nline.md'].map((file) => `${commit}:${file}`)
  const expected = await Promise.all(specs.map((spec) => git(root, ['show', spec], [128])))
  assert.deepEqual(await showMany(root, specs), expected)
  assert.equal(expected[0], '# T001 ü\n> st:todo\n')
  assert.match(expected[1], /^tree /)
  assert.deepEqual(expected.slice(2), ['', null, null])
})

test('readTaskBoard at a commit lists tasks and the done archive like the checkout it came from', async (t) => {
  const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), 'haeram-batch-board-')))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const root = path.join(temporary, 'repo')
  await mkdir(path.join(root, 'spec/tasks/done/older'), { recursive: true })
  await execute('git', ['init', '-q', '-b', 'trunk', root])
  const task = (id, dep = '-') => `# ${id} example\n> st:todo | ssot:ARCH-1 | base:ARCH@1 | dep:${dep}\n\n## goal\nx\n`
  await writeFile(path.join(root, 'spec/tasks/T002.b.md'), task('T002', 'T001'))
  await writeFile(path.join(root, 'spec/tasks/T003.c.md'), task('T003', 'T002'))
  await writeFile(path.join(root, 'spec/tasks/done/T001.a.md'), task('T001'))
  await writeFile(path.join(root, 'spec/tasks/done/older/T000.z.md'), task('T000'))
  await writeFile(path.join(root, 'spec/STATE.md'), '# STATE\n\n## tasks\n| id | title | ssot | dep | st |\n|---|---|---|---|---|\n| T002 | b | ARCH | T001 | todo |\n| T003 | c | ARCH | T002 | todo |\n')
  await execute('git', ['-C', root, 'add', '.'])
  await execute('git', ['-C', root, '-c', 'user.name=T', '-c', 'user.email=t@e', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'c'])
  const pick = ({ ok, tasks, doneIds, errors, warnings }) => ({ ok, tasks, doneIds, errors, warnings })
  const committed = await readTaskBoard({ targetRoot: root, ref: 'HEAD' })
  assert.deepEqual(pick(committed), pick(await readTaskBoard({ targetRoot: root })))
  assert.deepEqual(committed.doneIds, ['T001'])
  assert.deepEqual(committed.tasks.map((entry) => [entry.id, entry.waitingOn]), [['T002', []], ['T003', ['T002']]])
  // A caller's inspection of the same root, made in the same operation, is used instead of a new one.
  const inspected = await inspectWorkspace({ targetRoot: root })
  const reused = await readTaskBoard({ targetRoot: root, workspace: inspected, ref: 'HEAD' })
  assert.equal(reused.workspace, inspected)
  assert.deepEqual(pick(reused), pick(committed))
})
