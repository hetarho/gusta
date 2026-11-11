import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { access, mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { parseBatch, batchShow, showMany, git, gitOperation, inspectWorkspace } from '../src/workspace.mjs'
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

const markerPaths = '.git/MERGE_HEAD\n.git/CHERRY_PICK_HEAD\n.git/REVERT_HEAD\n.git/rebase-merge\n.git/rebase-apply\n'
function fakeGit({ refs = [], files = [], verified = [], failBatch = false } = {}) {
  const calls = []
  return {
    calls,
    run: async (root, args) => {
      calls.push(args.join(' '))
      if (args[1] === '--verify') return verified.includes(args[3]) ? `${sha}\n` : null
      return args.length === 3 ? `.git/${args[2]}\n` : markerPaths
    },
    batch: async (root, args, input) => {
      calls.push(args.join(' '))
      if (failBatch) throw Object.assign(new Error('fatal'), { code: 128 })
      return Buffer.from(input.split('\n').filter(Boolean).map((name) => refs.includes(name) ? `${sha} commit 1` : `${name} missing`).join('\n') + '\n')
    },
    present: async (file) => files.some((name) => file.endsWith(`/.git/${name}`)),
  }
}

test('gitOperation: two processes find the first operation in the original order', async () => {
  const idle = fakeGit()
  assert.equal(await gitOperation('/repo', idle), null)
  assert.deepEqual(idle.calls, ['rev-parse --git-path MERGE_HEAD --git-path CHERRY_PICK_HEAD --git-path REVERT_HEAD --git-path rebase-merge --git-path rebase-apply', 'cat-file --batch-check'])
  assert.equal(await gitOperation('/repo', fakeGit({ refs: ['REVERT_HEAD', 'CHERRY_PICK_HEAD'], files: ['rebase-merge'] })), 'CHERRY_PICK_HEAD')
  assert.equal(await gitOperation('/repo', fakeGit({ files: ['rebase-apply', 'rebase-merge'] })), 'rebase-merge')
  // A ref file whose object is lost: cat-file says missing, rev-parse --verify decides as before.
  const lost = fakeGit({ files: ['MERGE_HEAD'], verified: ['MERGE_HEAD'] })
  assert.equal(await gitOperation('/repo', lost), 'MERGE_HEAD')
  assert.equal(lost.calls.at(-1), 'rev-parse --verify --quiet MERGE_HEAD')
  assert.equal(await gitOperation('/repo', fakeGit({ files: ['MERGE_HEAD'] })), null)
  // A failed batch takes the one-call-per-marker path.
  const fallback = fakeGit({ failBatch: true, files: ['rebase-apply'] })
  assert.equal(await gitOperation('/repo', fallback), 'rebase-apply')
  assert.deepEqual(fallback.calls.slice(2), ['rev-parse --verify --quiet MERGE_HEAD', 'rev-parse --verify --quiet CHERRY_PICK_HEAD', 'rev-parse --verify --quiet REVERT_HEAD', 'rev-parse --git-path rebase-merge', 'rev-parse --git-path rebase-apply'])
})

test('gitOperation agrees with one rev-parse per marker in a real repository and linked worktree', async (t) => {
  const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), 'haeram-batch-op-')))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const root = path.join(temporary, 'repo')
  await execute('git', ['init', '-q', '-b', 'trunk', root])
  await execute('git', ['-C', root, '-c', 'user.name=T', '-c', 'user.email=t@e', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'c'])
  const linked = path.join(temporary, 'linked tree')
  await execute('git', ['-C', root, 'worktree', 'add', '-q', '-b', 'side', linked])
  const commit = (await git(root, ['rev-parse', 'HEAD'])).trim()
  const original = async (where) => {
    for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']) if (await git(where, ['rev-parse', '--verify', '--quiet', marker], [1])) return marker
    for (const marker of ['rebase-merge', 'rebase-apply']) {
      const location = (await git(where, ['rev-parse', '--git-path', marker])).replace(/\r?\n$/, '')
      if (await access(path.resolve(where, location)).then(() => true, () => false)) return marker
    }
    return null
  }
  const gitDir = (await git(linked, ['rev-parse', '--absolute-git-dir'])).trim()
  const states = [
    [root, null, async () => {}],
    [root, 'MERGE_HEAD', () => writeFile(path.join(root, '.git/MERGE_HEAD'), `${commit}\n`)],
    [root, 'MERGE_HEAD', () => writeFile(path.join(root, '.git/MERGE_HEAD'), `${'1'.repeat(40)}\n`)],
    [root, null, () => writeFile(path.join(root, '.git/MERGE_HEAD'), 'garbage\n')],
    [root, 'REVERT_HEAD', async () => { await rm(path.join(root, '.git/MERGE_HEAD')); await writeFile(path.join(root, '.git/REVERT_HEAD'), `${commit}\n`) }],
    [linked, null, async () => {}],
    [linked, 'rebase-apply', () => mkdir(path.join(gitDir, 'rebase-apply'))],
    [linked, 'CHERRY_PICK_HEAD', () => writeFile(path.join(gitDir, 'CHERRY_PICK_HEAD'), `${commit}\n`)],
  ]
  for (const [where, expected, change] of states) {
    await change()
    assert.equal(await original(where), expected)
    assert.equal(await gitOperation(where), expected)
  }
})

test('inspectWorkspace asks three questions in one round and answers like one question at a time', async (t) => {
  const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), 'haeram-batch-inspect-')))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const root = path.join(temporary, 'repo with spaces')
  await mkdir(path.join(root, 'sub dir'), { recursive: true })
  await execute('git', ['init', '-q', '-b', 'trunk', root])
  await writeFile(path.join(root, 'sub dir/HEAD'), 'a file named like the ref\n')
  await execute('git', ['-C', root, 'add', '.'])
  await execute('git', ['-C', root, '-c', 'user.name=T', '-c', 'user.email=t@e', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'c'])
  const linked = path.join(temporary, 'linked')
  await execute('git', ['-C', root, 'worktree', 'add', '-q', '-b', 'side', linked])
  const detached = path.join(temporary, 'detached')
  await execute('git', ['-C', root, 'worktree', 'add', '-q', '--detach', detached])
  const unborn = path.join(temporary, 'unborn')
  await execute('git', ['init', '-q', unborn])
  await writeFile(path.join(unborn, 'HEAD'), 'x\n')
  const bare = path.join(temporary, 'bare.git')
  await execute('git', ['clone', '-q', '--bare', root, bare])
  const plain = path.join(temporary, 'plain')
  await mkdir(plain)
  const oneByOne = (cwd, args, codes) => args.length === 6 ? Promise.reject(new Error('asked one by one')) : git(cwd, args, codes)
  for (const target of [root, path.join(root, 'sub dir'), linked, detached, unborn, bare, path.join(root, '.git'), plain]) {
    assert.deepEqual(await inspectWorkspace({ targetRoot: target }), await inspectWorkspace({ targetRoot: target }, oneByOne), target)
  }
  const asked = []
  await inspectWorkspace({ targetRoot: linked }, (cwd, args, codes) => { asked.push(args[0]); return git(cwd, args, codes) })
  assert.deepEqual(asked.sort(), ['rev-parse', 'symbolic-ref', 'worktree'])
  assert.equal((await inspectWorkspace({ targetRoot: unborn })).git.head, null)
})
