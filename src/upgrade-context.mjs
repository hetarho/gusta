import { open, readdir, lstat, readlink, realpath } from 'node:fs/promises'
import { constants } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { inspectWorkspace, git, gitInput } from './workspace.mjs'
import { effectiveSettings, SETTINGS_FILE } from './settings.mjs'
import { AGENT_CONFIG, LOCK_FILE, PACKAGE_NAME } from './constants.mjs'
import { SkillPackageError } from './errors.mjs'

// Walk the checkout, not a document-name allowlist or Git's unignored files. These known
// boundaries remain visible in the inventory; unfamiliar vendor/build directories are walked.
const BOUNDARIES = new Map([
  ['.git', 'git-metadata'], ['.hg', 'vcs-metadata'], ['.svn', 'vcs-metadata'],
  ['node_modules', 'dependency-tree'], ['.venv', 'dependency-environment'],
  ['__pycache__', 'generated-bytecode'], ['.haeram-worktrees', 'generated-worktrees'],
])
const CAPTURE = new Set([LOCK_FILE, SETTINGS_FILE, 'spec/STATE.md'])
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0
const digest = (value) => createHash('sha256').update(value).digest('hex')
const safePath = (value) => typeof value === 'string' && value && !path.posix.isAbsolute(value) && !value.split('/').some((part) => !part || part === '..' || part === '.') && !value.includes('\\')
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs

function pageNumber(value, fallback, name, minimum, maximum = Number.MAX_SAFE_INTEGER) {
  const number = value === undefined ? fallback : Number(value)
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) throw new SkillPackageError(`${name} 값이 올바르지 않습니다.`, [`${minimum}..${maximum}`])
  return number
}

// Hash by streaming, including binary files. Capture only the three small configuration inputs;
// the API never returns document bodies. UTF-16 documents with a BOM remain text candidates.
async function describeFile(file, relative, before, deps) {
  await deps.guardDirectory(path.dirname(file))
  const handle = await deps.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || !sameFile(before, opened)) throw new Error('file changed before reading')
    // O_NOFOLLOW protects the leaf only. Recheck its parent before reading any bytes so a
    // replaced ancestor cannot turn a discovered project path into an outside-root read.
    await deps.guardDirectory(path.dirname(file))
    const hash = createHash('sha256'), buffer = Buffer.alloc(65536), captured = []
    let decoder, binary = false, invalidEncoding = false, prefix = '', encoding = 'utf-8'
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      if (!bytesRead) break
      const chunk = buffer.subarray(0, bytesRead)
      hash.update(chunk)
      if (CAPTURE.has(relative)) captured.push(Buffer.from(chunk))
      if (!decoder) {
        if (chunk[0] === 0xff && chunk[1] === 0xfe) encoding = 'utf-16le'
        if (chunk[0] === 0xfe && chunk[1] === 0xff) encoding = 'utf-16be'
        decoder = new TextDecoder(encoding, { fatal: true })
      }
      if (encoding === 'utf-8' && chunk.includes(0)) binary = true
      if (!binary && !invalidEncoding) {
        try { prefix += decoder.decode(chunk, { stream: true }).slice(0, Math.max(0, 4096 - prefix.length)) }
        catch { invalidEncoding = true }
      }
    }
    if (!binary && !invalidEncoding && decoder) {
      try { prefix += decoder.decode().slice(0, Math.max(0, 4096 - prefix.length)) } catch { invalidEncoding = true }
    }
    if (!sameFile(before, await handle.stat()) || !sameFile(before, await deps.lstat(file))) throw new Error('file changed while reading')
    const sha256 = hash.digest('hex')
    if (binary || invalidEncoding) return { kind: 'binary', disposition: 'excluded', sha256, reason: binary ? 'binary-content' : 'binary-or-unsupported-text-encoding' }
    const instruction = /^(AGENT|AGENTS|CLAUDE)\.md$/i.test(path.posix.basename(relative))
    const generated = /@generated\b|Code generated[^\n]*DO NOT EDIT|DO NOT EDIT[^\n]*generated/i.test(prefix)
    return { kind: instruction ? 'instruction' : 'text', disposition: 'candidate', sha256, encoding,
      ...(instruction ? { scope: path.posix.dirname(relative) } : {}),
      ...(generated ? { reason: 'generated-content-marker; review its source before changing' } : {}),
      // Configuration consumers use readFile(..., 'utf8'). Preserve BOM/invalid encoding
      // exactly as those consumers see it; document decoding must not sanitize settings.
      ...(CAPTURE.has(relative) ? { content: Buffer.concat(captured).toString('utf8') } : {}) }
  } finally { await handle.close() }
}

// A deterministic read-only index, not a semantic policy audit. Native file tools read the
// candidates and resolve local references; neither a page nor an empty search proves review.
export async function upgradeContext(options = {}, injected = {}) {
  const deps = { inspect: inspectWorkspace, git, gitInput, open, readdir, lstat, readlink, realpath, ...injected }
  const offset = pageNumber(options.offset, 0, '--offset', 0), limit = pageNumber(options.limit, 100, '--limit', 1)
  if (options.snapshot !== undefined && !/^[a-f0-9]{64}$/.test(options.snapshot)) throw new SkillPackageError('--snapshot에는 inventory의 SHA-256 값이 필요합니다.')
  const workspace = await deps.inspect(options), root = workspace.git?.root ?? workspace.targetRoot
  const errors = [], entries = [], contents = new Map(), tracked = new Map()
  const directories = new Map()
  deps.guardDirectory = async (directory) => {
    const resolved = await deps.realpath(directory), relative = path.relative(root, resolved)
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw Object.assign(new Error('directory resolves outside the inventory root'), { code: 'OUTSIDE_ROOT' })
    const current = await deps.lstat(directory), expected = directories.get(directory)
    if (resolved !== directory || !current.isDirectory() || expected && !sameFile(expected, current)) throw Object.assign(new Error('directory changed during inventory'), { code: 'DIRECTORY_CHANGED' })
    directories.set(directory, current)
  }
  const problem = (relative, error) => {
    const issue = { path: relative, code: String(error.code ?? 'READ_FAILED'), message: error.message }
    errors.push(issue)
    return issue
  }
  if (workspace.git) {
    try {
      for (const row of (await deps.git(root, ['ls-files', '--stage', '-z'])).split('\0').filter(Boolean)) {
        const tab = row.indexOf('\t')
        tracked.set(row.slice(tab + 1), row.slice(0, tab).split(' ')[0])
      }
    } catch (error) { problem('.', error) }
  }
  const visit = async (directory, relative = '') => {
    let children
    try {
      await deps.guardDirectory(directory)
      children = (await deps.readdir(directory, { withFileTypes: true })).sort((a, b) => compare(a.name, b.name))
      await deps.guardDirectory(directory)
    }
    catch (error) { problem(relative || '.', error); return }
    for (const child of children) {
      const name = relative ? `${relative}/${child.name}` : child.name, file = path.join(directory, child.name)
      const base = { path: name, provenance: workspace.git ? tracked.has(name) ? 'tracked' : 'untracked' : 'filesystem' }
      try {
        const stats = await deps.lstat(file)
        if (stats.isSymbolicLink()) {
          entries.push({ ...base, kind: 'symlink', disposition: 'excluded', reason: 'symlink-not-followed', target: await deps.readlink(file) })
        } else if (tracked.get(name) === '160000') {
          entries.push({ ...base, kind: 'submodule', disposition: 'excluded', reason: 'separate-repository-boundary' })
        } else if (BOUNDARIES.has(child.name)) {
          entries.push({ ...base, kind: 'boundary', disposition: 'excluded', reason: BOUNDARIES.get(child.name) })
        } else if (stats.isDirectory()) {
          directories.set(file, stats)
          await deps.guardDirectory(file)
          const marker = await deps.lstat(path.join(file, '.git')).catch((error) => { if (error.code === 'ENOENT') return null; throw error })
          if (marker) entries.push({ ...base, kind: 'boundary', disposition: 'excluded', reason: 'nested-checkout-boundary',
            targetRoot: file, marker: `${name}/.git` })
          else await visit(file, name)
        }
        else if (stats.isFile()) {
          const described = await describeFile(file, name, stats, deps)
          if (Object.hasOwn(described, 'content')) { contents.set(name, described.content); delete described.content }
          entries.push({ ...base, bytes: stats.size, ...described })
        } else entries.push({ ...base, kind: 'boundary', disposition: 'excluded', reason: 'non-regular-file' })
      } catch (error) {
        const issue = problem(name, error)
        entries.push({ ...base, kind: 'unreadable', disposition: 'unreadable', reason: issue.code })
      }
    }
    try { await deps.guardDirectory(directory) } catch (error) { problem(relative || '.', error) }
  }
  await visit(root)
  // A deleted tracked document is also visible. Descendants of an explicit boundary are not
  // individually enumerated; the boundary's reason describes that coverage limit.
  const present = new Set(entries.map((entry) => entry.path)), excluded = entries.filter((entry) => ['boundary', 'submodule', 'symlink'].includes(entry.kind))
  for (const [name, mode] of tracked) if (!present.has(name) && !excluded.some((entry) => name.startsWith(`${entry.path}/`))) {
    entries.push({ path: name, provenance: 'tracked', kind: mode === '160000' ? 'submodule' : 'missing', disposition: 'excluded', reason: mode === '160000' ? 'separate-repository-boundary' : 'tracked-path-missing' })
  }
  entries.sort((a, b) => compare(a.path, b.path))
  if (workspace.git && entries.length) {
    try {
      const output = await deps.gitInput(root, ['check-ignore', '--stdin', '-z'], `${entries.map((entry) => entry.path).join('\0')}\0`).catch((error) => { if (error.code === 1) return Buffer.alloc(0); throw error })
      const ignored = new Set(output.toString('utf8').split('\0').filter(Boolean))
      for (const entry of entries) entry.ignored = ignored.has(entry.path)
    } catch (error) { problem('.', error) }
  }
  if (contents.has(LOCK_FILE)) {
    try {
      const lock = JSON.parse(contents.get(LOCK_FILE))
      if (lock.schemaVersion !== 1 || lock.packageName !== PACKAGE_NAME || !lock.files || Array.isArray(lock.files) || typeof lock.files !== 'object') throw new Error('invalid package ownership manifest')
      for (const [name, record] of Object.entries(lock.files)) {
        if (!safePath(name) || !Object.values(AGENT_CONFIG).some(({ root: prefix }) => name.startsWith(`${prefix}/`)) || !/^[a-f0-9]{64}$/.test(record?.sha256 ?? '')) throw new Error('invalid managed-file record')
        const entry = entries.find((candidate) => candidate.path === name)
        if (!entry) continue
        entry.ownership = entry.sha256 === record.sha256 ? 'managed-unchanged' : 'managed-modified'
        if (entry.ownership === 'managed-unchanged') { entry.disposition = 'excluded'; entry.reason = 'unchanged-package-managed-copy' }
      }
    } catch (error) { problem(LOCK_FILE, error) }
  }
  const unavailable = [SETTINGS_FILE, 'spec/STATE.md'].filter((name) => entries.some((entry) => entry.path === name && !['text', 'instruction', 'missing'].includes(entry.kind)))
  const settings = unavailable.length ? { available: false, unavailable } : { available: true, ...effectiveSettings(contents.get(SETTINGS_FILE) ?? null, contents.get('spec/STATE.md') ?? null) }
  for (const message of settings.errors ?? []) problem(SETTINGS_FILE, { code: 'INVALID_SETTINGS', message })
  if (workspace.git) {
    try {
      const head = (await deps.git(root, ['rev-parse', '--verify', '--quiet', 'HEAD'], [1, 128]))?.trim() ?? null
      if (head !== workspace.git.head) problem('.', { code: 'SOURCE_CHANGED', message: 'HEAD changed during inventory' })
    } catch (error) { problem('.', error) }
  }
  const source = { kind: workspace.git ? 'worktree' : 'filesystem', head: workspace.git?.head ?? null }
  const snapshot = digest(JSON.stringify({ source, entries, errors, settings }))
  if (options.snapshot && options.snapshot !== snapshot) throw new SkillPackageError('inventory가 바뀌었습니다. 첫 페이지부터 다시 확인하세요.', [options.snapshot, snapshot])
  if (offset > entries.length) throw new SkillPackageError('--offset이 inventory 항목 수보다 큽니다.')
  const nextOffset = offset + limit < entries.length ? offset + limit : null
  return { schemaVersion: 1, ok: !errors.length, targetRoot: root, source, snapshot, total: entries.length, offset, limit, nextOffset,
    complete: nextOffset === null, coverage: { inventoryComplete: !errors.length, policyReviewed: false,
      excluded: entries.filter((entry) => entry.disposition === 'excluded').length,
      note: 'Excluded boundaries are not traversed. Binary or unsupported encodings need separate inspection. History and generated markers are context, not policy verdicts; resolve local references with file tools.' },
    entries: entries.slice(offset, offset + limit), settings, errors }
}
