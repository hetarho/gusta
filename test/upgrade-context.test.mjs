import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, symlink, lstat, open, readdir, rename } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { upgradeContext } from '../src/upgrade-context.mjs'
import { readSettings } from '../src/settings.mjs'

const execute = promisify(execFile)
const cli = new URL('../bin/gusta.mjs', import.meta.url).pathname
const hash = (text) => createHash('sha256').update(text).digest('hex')
const filesOnly = { inspect: async ({ targetRoot }) => ({ targetRoot: await realpath(targetRoot), git: null }) }
async function fixture(t) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'gusta-upgrade-context-')))
  const root = path.join(directory, 'project')
  await mkdir(root)
  t.after(() => rm(directory, { recursive: true, force: true }))
  const put = async (name, text) => { const file = path.join(root, name); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, text) }
  return { root, directory, put }
}

test('inventory includes arbitrary text, hidden and ignored-looking documents, scopes, workflows and old records without a semantic verdict', async (t) => {
  const { root, put } = await fixture(t)
  for (const [name, text] of Object.entries({
    '.gitignore': '.local/\n', 'AGENT.md': 'Project process.', 'src/AGENTS.md': 'Scope: this subtree.',
    'src/deep/CLAUDE.md': 'More local constraints.', '.local/operations': 'Never publish without approval.',
    '.github/workflows/release.yml': 'on: workflow_dispatch\n', 'a name without an extension': 'Read this process too.',
    'vendor/local-guide': 'A first-party guide in an unfamiliar vendor directory.', 'dist/handbook': 'Not proven generated.',
    'docs/old-release': 'Historical: always push each task.', 'docs/generated': '// @generated: do not edit directly.',
    'spec/SETTINGS.md': '# SETTINGS\n- land: current\n- push: false\n', '.env': 'PRIVATE_FIXTURE_VALUE=never-return-bodies',
  })) await put(name, text)
  await put('binary.asset', Buffer.from([0, 1, 2, 255]))
  await put('utf16-guide', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('A UTF-16 process guide.', 'utf16le')]))
  const result = await upgradeContext({ targetRoot: root, limit: 1000 }, filesOnly)
  assert.equal(result.ok, true); assert.equal(result.complete, true)
  assert.deepEqual(result.coverage.policyReviewed, false)
  const entries = new Map(result.entries.map((entry) => [entry.path, entry]))
  for (const name of ['.local/operations', '.github/workflows/release.yml', 'a name without an extension', 'vendor/local-guide', 'dist/handbook', 'docs/old-release']) assert.equal(entries.get(name).disposition, 'candidate', name)
  for (const [name, scope] of [['AGENT.md', '.'], ['src/AGENTS.md', 'src'], ['src/deep/CLAUDE.md', 'src/deep']]) {
    assert.equal(entries.get(name).kind, 'instruction'); assert.equal(entries.get(name).scope, scope)
  }
  assert.equal(entries.get('binary.asset').kind, 'binary')
  assert.equal(entries.get('utf16-guide').kind, 'text'); assert.equal(entries.get('utf16-guide').encoding, 'utf-16le')
  assert.match(entries.get('docs/generated').reason, /generated-content-marker/)
  assert.equal(entries.get('docs/generated').disposition, 'candidate')
  assert.equal(result.settings.settings.find(({ key }) => key === 'land').source, 'file')
  assert.equal(result.settings.settings.find(({ key }) => key === 'headless-mcp').source, 'default')
  assert.ok(!JSON.stringify(result).includes('never-return-bodies'))
})

test('known dependency/metadata/generated boundaries and symlinks have explicit reasons and are never followed', async (t) => {
  const { root, directory, put } = await fixture(t)
  for (const name of ['.git/hidden', 'node_modules/pkg/AGENTS.md', '__pycache__/cache', '.gusta-worktrees/other/guide']) await put(name, 'Do not read this subtree.')
  const outside = path.join(directory, 'outside')
  await mkdir(outside); await writeFile(path.join(outside, 'AGENTS.md'), 'Outside instruction.')
  await symlink(outside, path.join(root, 'linked-docs'))
  const result = await upgradeContext({ targetRoot: root }, filesOnly)
  assert.equal(result.ok, true)
  assert.deepEqual(result.entries.map(({ path: name }) => name), ['.git', '.gusta-worktrees', '__pycache__', 'linked-docs', 'node_modules'])
  assert.ok(result.entries.every((entry) => entry.disposition === 'excluded' && entry.reason))
  assert.equal(result.entries.find(({ path: name }) => name === 'linked-docs').kind, 'symlink')
})

test('nested checkout markers stop rule discovery at that checkout while ordinary ignored temporary documents remain visible', async (t) => {
  const { root, put } = await fixture(t)
  await put('.gitignore', '.tmp/\n')
  await put('.tmp/worktree/.git', 'gitdir: /outside/metadata\n')
  await put('.tmp/worktree/AGENTS.md', 'Belongs only to another checkout.')
  await put('nested-repository/.git/config', 'Separate repository metadata.')
  await put('nested-repository/README.md', 'Different checkout rules.')
  await put('.tmp/local-notes', 'First-party notes in this checkout.')
  const result = await upgradeContext({ targetRoot: root }, filesOnly)
  assert.equal(result.ok, true)
  for (const name of ['.tmp/worktree', 'nested-repository']) {
    const entry = result.entries.find(({ path: candidate }) => candidate === name)
    assert.equal(entry.reason, 'nested-checkout-boundary')
    assert.equal(entry.targetRoot, path.join(root, name))
    assert.equal(entry.marker, `${name}/.git`)
    assert.ok(!result.entries.some(({ path: candidate }) => candidate.startsWith(`${name}/`)))
  }
  assert.equal(result.entries.find(({ path: name }) => name === '.tmp/local-notes').disposition, 'candidate')
})

test('FIFO and socket paths are explicit boundaries and are never opened as documents', { skip: process.platform === 'win32' }, async (t) => {
  const { root } = await fixture(t)
  await execute('mkfifo', [path.join(root, 'input-pipe')])
  const socket = path.join(root, 'control.sock'), server = net.createServer()
  await new Promise((resolve, reject) => server.once('error', reject).listen(socket, resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  let opens = 0
  const result = await upgradeContext({ targetRoot: root }, { ...filesOnly, open: (...args) => { opens++; return open(...args) } })
  assert.equal(opens, 0)
  assert.deepEqual(result.entries.map(({ path: name, reason }) => [name, reason]), [['control.sock', 'non-regular-file'], ['input-pipe', 'non-regular-file']])
})

test('an ancestor replaced by an outside symlink during traversal cannot contribute outside policy bytes', async (t) => {
  const { root, directory } = await fixture(t)
  const scope = path.join(root, 'scope'), outside = path.join(directory, 'outside')
  await mkdir(scope); await mkdir(outside); await writeFile(path.join(outside, 'foreign-policy.md'), 'Outside policy must not be read.')
  let swapped = false, opens = 0
  const result = await upgradeContext({ targetRoot: root }, { ...filesOnly,
    readdir: async (file, options) => {
      if (file === scope && !swapped) { swapped = true; await rename(scope, path.join(root, 'scope-kept')); await symlink(outside, scope) }
      return readdir(file, options)
    },
    open: (...args) => { opens++; return open(...args) },
  })
  assert.equal(result.ok, false); assert.equal(result.coverage.inventoryComplete, false)
  assert.ok(result.errors.some(({ path: name, code }) => name === 'scope' && code === 'OUTSIDE_ROOT'))
  assert.ok(!result.entries.some(({ path: name }) => name === 'scope/foreign-policy.md'))
  assert.equal(opens, 0)
})

test('a parent swapped while opening a file is rejected before the opened handle reads bytes', async (t) => {
  const { root, directory, put } = await fixture(t)
  const scope = path.join(root, 'scope'), outside = path.join(directory, 'outside')
  await put('scope/rules', 'Project policy.')
  await mkdir(outside); await writeFile(path.join(outside, 'rules'), 'Foreign policy.')
  let reads = 0
  const result = await upgradeContext({ targetRoot: root }, { ...filesOnly, open: async (file, flags) => {
    await rename(scope, path.join(root, 'scope-kept')); await symlink(outside, scope)
    const handle = await open(file, flags), read = handle.read.bind(handle)
    handle.read = (...args) => { reads++; return read(...args) }
    return handle
  } })
  assert.equal(result.ok, false); assert.equal(result.coverage.inventoryComplete, false)
  assert.equal(reads, 0)
  assert.equal(result.entries.find(({ path: name }) => name === 'scope/rules').kind, 'unreadable')
})

test('Git provenance retains ignored first-party files and exposes submodules and deleted tracked paths without changing the checkout', async (t) => {
  const { root, put } = await fixture(t)
  const git = async (...args) => (await execute('git', ['-C', root, ...args], { encoding: 'utf8' })).stdout.trim()
  await git('init', '-q', '-b', 'trunk')
  await git('config', 'user.name', 'Test'); await git('config', 'user.email', 'test@example.com')
  await git('config', 'commit.gpgsign', 'false'); await git('config', 'core.hooksPath', '/dev/null')
  await put('.gitignore', '.hidden/\n'); await put('tracked-guide', 'Current rules.')
  await git('add', '.'); await git('commit', '-qm', 'fixture')
  const head = await git('rev-parse', 'HEAD')
  await git('update-index', '--add', '--cacheinfo', `160000,${head},module`)
  await put('module/AGENTS.md', 'Separate repository.')
  await put('.hidden/AGENT.md', 'Ignored but first-party instructions.')
  await rm(path.join(root, 'tracked-guide'))
  const before = await git('status', '--porcelain')
  const result = await upgradeContext({ targetRoot: root })
  assert.equal(result.ok, true, JSON.stringify(result.errors))
  assert.equal(result.source.head, head)
  const ignored = result.entries.find(({ path: name }) => name === '.hidden/AGENT.md')
  assert.equal(ignored.ignored, true); assert.equal(ignored.disposition, 'candidate')
  assert.equal(result.entries.find(({ path: name }) => name === 'module').kind, 'submodule')
  assert.ok(!result.entries.some(({ path: name }) => name === 'module/AGENTS.md'))
  assert.equal(result.entries.find(({ path: name }) => name === 'tracked-guide').reason, 'tracked-path-missing')
  assert.equal(await git('status', '--porcelain'), before)
})

test('only hash-proven unchanged managed skills are excluded; modified copies remain review candidates', async (t) => {
  const { root, put } = await fixture(t)
  const unchanged = '.codex/skills/one/SKILL.md', changed = '.claude/skills/two/SKILL.md'
  await put(unchanged, 'Original rules.'); await put(changed, 'Locally customized rules.')
  await put('.gusta-lock.json', JSON.stringify({ schemaVersion: 1, packageName: '@haeram/gusta', files: {
    [unchanged]: { sha256: hash('Original rules.') }, [changed]: { sha256: hash('Previous rules.') },
  } }))
  const result = await upgradeContext({ targetRoot: root }, filesOnly)
  const same = result.entries.find(({ path: name }) => name === unchanged), modified = result.entries.find(({ path: name }) => name === changed)
  assert.deepEqual([same.ownership, same.disposition], ['managed-unchanged', 'excluded'])
  assert.deepEqual([modified.ownership, modified.disposition], ['managed-modified', 'candidate'])
  assert.equal(await readFile(path.join(root, changed), 'utf8'), 'Locally customized rules.')
})

test('index pages share a deterministic snapshot and reject source drift instead of silently losing coverage', async (t) => {
  const { root, put } = await fixture(t)
  await put('one', 'First.'); await put('two', 'Second.'); await put('three', 'Third.')
  const before = await lstat(path.join(root, 'one'))
  const first = await upgradeContext({ targetRoot: root, limit: 1 }, filesOnly)
  const second = await upgradeContext({ targetRoot: root, offset: first.nextOffset, limit: 2, snapshot: first.snapshot }, filesOnly)
  assert.equal(first.complete, false); assert.equal(first.coverage.inventoryComplete, true)
  assert.equal(second.complete, true); assert.equal(second.nextOffset, null)
  assert.equal(first.snapshot, second.snapshot); assert.equal(first.total, 3)
  assert.deepEqual([...first.entries, ...second.entries].map(({ path: name }) => name), ['one', 'three', 'two'])
  assert.equal((await lstat(path.join(root, 'one'))).mtimeMs, before.mtimeMs)
  await put('one', 'Changed.')
  await assert.rejects(upgradeContext({ targetRoot: root, snapshot: first.snapshot }, filesOnly), /inventory가 바뀌었습니다/)
  assert.equal((await upgradeContext({ targetRoot: root, limit: 17333 }, filesOnly)).complete, true)
  for (const options of [{ limit: 0 }, { limit: Number.MAX_SAFE_INTEGER + 1 }, { offset: -1 }, { offset: 99 }]) await assert.rejects(upgradeContext({ targetRoot: root, ...options }, filesOnly))
})

test('critical configuration parsing preserves the same UTF-8 bytes and errors as runtime settings', async (t) => {
  const { root, put } = await fixture(t)
  for (const value of ['\ufeff# SETTINGS\n- land: integration\n', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('# SETTINGS\n- land: integration\n', 'utf16le')])]) {
    await put('spec/SETTINGS.md', value)
    let runtime
    await assert.rejects(readSettings({ root }), (error) => { runtime = error; return /SETTINGS.md/.test(error.message) })
    const result = await upgradeContext({ targetRoot: root }, filesOnly)
    assert.equal(result.ok, false); assert.equal(result.coverage.inventoryComplete, false)
    assert.deepEqual(result.settings.errors, runtime.details)
    assert.ok(result.errors.some(({ code }) => code === 'INVALID_SETTINGS'))
  }
})

test('unreadable files, invalid manifests and unavailable settings never look like complete successful inspection', async (t) => {
  const { root, put } = await fixture(t)
  await put('blocked', 'Read failure.'); await put('.gusta-lock.json', '{invalid')
  await put('spec/STATE.md', '# STATE\n')
  await symlink(path.join(root, 'blocked'), path.join(root, 'spec/SETTINGS.md'))
  const result = await upgradeContext({ targetRoot: root }, { ...filesOnly, open: async (file, flags) => {
    if (path.basename(file) === 'blocked') throw Object.assign(new Error('test read denied'), { code: 'EACCES' })
    return open(file, flags)
  } })
  assert.equal(result.ok, false); assert.equal(result.coverage.inventoryComplete, false)
  assert.equal(result.settings.available, false)
  assert.ok(result.errors.some(({ path: name, code }) => name === 'blocked' && code === 'EACCES'))
  assert.ok(result.errors.some(({ path: name }) => name === '.gusta-lock.json'))
  assert.equal(result.entries.find(({ path: name }) => name === 'blocked').disposition, 'unreadable')
})

test('CLI emits read-only JSON inventory, supports paging and snapshot validation, and reports invalid options', async (t) => {
  const { root, put } = await fixture(t)
  await put('.private/runbook', 'Local documentation.'); await put('AGENTS.md', 'Rules.')
  const run = (...args) => execute(process.execPath, [cli, 'upgrade-context', '--target', root, ...args], { encoding: 'utf8' })
  const first = JSON.parse((await run('--json', '--limit=1')).stdout)
  assert.equal(first.ok, true); assert.equal(first.complete, false)
  const last = JSON.parse((await run('--offset', String(first.nextOffset), '--snapshot', first.snapshot)).stdout)
  assert.equal(last.complete, true); assert.equal(last.snapshot, first.snapshot)
  await assert.rejects(run('--limit=0'), (error) => error.code === 1 && /--limit/.test(error.stderr))
  await put('new-document', 'More rules.')
  await assert.rejects(run('--snapshot', first.snapshot), (error) => error.code === 1 && /inventory가 바뀌었습니다/.test(error.stderr))
})
