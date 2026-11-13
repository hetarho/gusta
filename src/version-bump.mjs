import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { isDeepStrictEqual, promisify } from 'node:util'
import { git, gitInput, batchShow } from './workspace.mjs'
import { parseSsot } from './spec-format.mjs'

// SETTINGS version: auto. When the CLI moves the release branch — deploy when set, else land — it
// adds one commit that raises the manifest version. The level comes from Git alone, never a model:
// sessions racing for the same branch must reach the same answer, and a push spends no model turn.
// A version a person changed stands (the only way to a major); a decision confirmed (`[o]`) since
// the current version was set — one that was absent or still open (`[?]`) then — means minor;
// anything else is a patch.
const execute = promisify(execFile)

// Paths a landing may change without being a release — the set the final gate ignores as well.
export const BOOKKEEPING = /^spec\/(?:STATE\.md$|reports\/|tasks\/|work\/)/
const SSOT_DOC = /^spec\/ssot\/.+\.md$/
// IDs of the decisions an SSOT text holds as confirmed (`[o]`).
export const confirmedDecisions = (text) => [...parseSsot(text ?? '').decisions.values()].filter((block) => block.status === 'decided').map((block) => block.id)
const PLAIN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

// The next plain X.Y.Z, or null for anything else (a prerelease line is a person's call).
export function nextVersion(version, level) {
  const parts = typeof version === 'string' ? version.match(PLAIN) : null
  if (!parts) return null
  const [major, minor, patch] = parts.slice(1).map(Number)
  return level === 'minor' ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`
}

// Why `vibe push` or `vibe deploy` leaves the version alone, from SETTINGS alone; null = it may bump.
// `plan` is settings.mjs branchPlan. land-via pr: the CLI does not hold the moment of the merge.
export function bumpGate(values, plan, command) {
  if (values.version !== 'auto') return values.version === 'off' ? 'off' : 'unset'
  if (plan.via === 'pr') return 'land-via-pr'
  if (command === 'deploy') return null
  return plan.deploy && plan.deploy !== plan.land ? 'on-deploy' : plan.land ? null : 'no-release-branch'
}

// The verdict for landing `head` on a release branch now at `base`: { level, from, to } or
// { skipped }. changed: paths differing between the two; versions: the manifest's at each commit;
// knownDecisions: IDs of the decisions confirmed (`[o]`) when the current version was set,
// headDecisions: those confirmed at head. An open (`[?]`) or rejected (`[x]`) decision is in neither:
// writing a question down, or turning an option down, releases no new rule.
export function bumpLevel({ base, head, changed = null, baseVersion = null, headVersion = null, knownDecisions = [], headDecisions = [] }) {
  if (!base) return { skipped: 'no-base' }
  if (base === head) return { skipped: 'unchanged' }
  if (changed?.every((file) => BOOKKEEPING.test(file))) return { skipped: 'bookkeeping-only' }
  if (headVersion === null) return { skipped: 'no-manifest' }
  if (baseVersion !== headVersion) return { skipped: 'manual', from: baseVersion, to: headVersion }
  const known = new Set(knownDecisions)
  const level = headDecisions.some((id) => !known.has(id)) ? 'minor' : 'patch'
  const to = nextVersion(headVersion, level)
  return to ? { level, from: headVersion, to } : { skipped: 'unsupported-version', from: headVersion }
}

// Where the string at `keys` sits in valid JSON text: { key, start, end } — the offset of the key's
// opening quote and the value's span with its quotes — or null. The text is scanned as written,
// never re-serialized, so replacing [start, end) leaves every other byte alone.
function locate(text, keys) {
  let at = 0, found = null
  const blank = () => { while (at < text.length && ' \t\r\n'.includes(text[at])) at += 1 }
  const string = () => {
    const start = at
    for (at += 1; text[at] !== '"'; at += text[at] === '\\' ? 2 : 1) if (at >= text.length) throw new SyntaxError('unterminated string')
    at += 1
    return start
  }
  // depth: how many of `keys` lead to this value, or -1 off the path. Returns a string's start.
  const value = (depth) => {
    blank()
    if (text[at] === '"') return string()
    if (text[at] === '{') {
      at += 1; blank()
      if (text[at] === '}') { at += 1; return null }
      for (;;) {
        blank()
        const key = string()
        const inner = depth >= 0 && JSON.parse(text.slice(key, at)) === keys[depth] ? depth + 1 : -1
        blank(); at += 1
        const start = value(inner)
        if (inner === keys.length && start !== null) found ??= { key, start, end: at }
        blank()
        if (text[at++] !== ',') return null
      }
    }
    if (text[at] === '[') {
      at += 1; blank()
      if (text[at] === ']') { at += 1; return null }
      for (;;) { value(-1); blank(); if (text[at++] !== ',') return null }
    }
    while (at < text.length && !',}] \t\r\n'.includes(text[at])) at += 1
    return null
  }
  value(0)
  return found
}

const parsed = (text) => { try { return JSON.parse(text) } catch { return undefined } }
const valueAt = (document, keys) => {
  const found = keys.reduce((node, key) => node !== null && typeof node === 'object' && Object.hasOwn(node, key) ? node[key] : undefined, document)
  return typeof found === 'string' ? found : null
}
const stringAt = (text, keys) => valueAt(parsed(text), keys)

// `text` with the strings at `paths` set to `value` (a path the document lacks is left out), or null
// when those bytes alone cannot do it: not JSON, no such string, or the result does not parse back
// to the original with exactly those values changed (a repeated key, say).
function setStrings(text, paths, value) {
  const expected = parsed(text)
  const present = paths.filter((keys) => valueAt(expected, keys) !== null)
  const spans = present.map((keys) => locate(text, keys))
  if (!spans.length || spans.includes(null)) return null
  for (const keys of present) keys.slice(0, -1).reduce((node, key) => node[key], expected)[keys.at(-1)] = value
  let next = text
  for (const span of spans.sort((a, b) => b.start - a.start)) next = next.slice(0, span.start) + JSON.stringify(value) + next.slice(span.end)
  return isDeepStrictEqual(parsed(next), expected) ? next : null
}

// A JSON file whose version sits at paths[0] and is repeated at the other paths.
const json = (file, paths) => ({ file,
  version: (text) => stringAt(text, paths[0]),
  // The bytes that spell the current version, key included: what `git log -S` looks for.
  marker: (text) => { const span = stringAt(text, paths[0]) === null ? null : locate(text, paths[0]); return span ? text.slice(span.key, span.end) : null },
  edit: (text, to) => setStrings(text, paths, to) })

// One adapter per ecosystem, the first whose manifest holds a version at the landed commit. Files sit
// at the repository root; companions repeat the version and follow it when the commit tracks them.
export const MANIFESTS = [
  { id: 'npm', ...json('package.json', [['version']]), companions: [json('package-lock.json', [['version'], ['packages', '', 'version']])] },
]
const VERSIONED = new Map(MANIFESTS.flatMap((manifest) => [manifest, ...manifest.companions]).map((entry) => [entry.file, entry]))

// Whether `after` is `before` with nothing but its version value changed.
export function versionOnly(file, before, after) {
  const entry = VERSIONED.get(file)
  const version = entry && before != null && after != null ? entry.version(before) : null
  return version !== null && entry.edit(after, version) === before
}

// What to commit for landing `head` on `base`: { level, from, to, files: { path: new text } } or
// { skipped }. deps: read(commit, file) → text|null · changed(from, to) → paths ·
// docs(commit, files) → texts · versionSetAt(commit, file, marker) → the commit that wrote it|null.
export async function planBump({ base, head }, deps) {
  if (!base || base === head) return bumpLevel({ base, head })
  const changed = await deps.changed(base, head)
  let manifest = null, text = null
  for (const candidate of MANIFESTS) {
    text = await deps.read(head, candidate.file)
    if (text !== null && candidate.version(text) !== null) { manifest = candidate; break }
  }
  const baseText = manifest ? await deps.read(base, manifest.file) : null
  const facts = { base, head, changed, baseVersion: baseText === null ? null : manifest.version(baseText), headVersion: manifest ? manifest.version(text) : null }
  const early = bumpLevel(facts)
  if (early.skipped) return early
  // "New" is measured from the commit that set the current version, not from base: planning commits
  // reach the release branch on their own (vibe plan-push), ahead of the code that follows them.
  let since = await deps.versionSetAt(base, manifest.file, manifest.marker(baseText))
  if (!since || manifest.version(await deps.read(since, manifest.file) ?? '') !== facts.baseVersion) since = base
  const docs = (since === base ? changed : await deps.changed(since, head)).filter((file) => SSOT_DOC.test(file))
  const [knownDecisions, headDecisions] = await Promise.all([since, head].map(async (commit) =>
    (await deps.docs(commit, docs)).flatMap(confirmedDecisions)))
  const verdict = bumpLevel({ ...facts, knownDecisions, headDecisions })
  if (verdict.skipped) return verdict
  const files = {}
  for (const entry of [manifest, ...manifest.companions]) {
    const current = entry === manifest ? text : await deps.read(head, entry.file)
    if (current === null) continue
    files[entry.file] = entry.edit(current, verdict.to)
    // A file that cannot be rewritten byte for byte is not a manifest this supports.
    if (files[entry.file] === null) return { skipped: 'no-manifest' }
  }
  return { ...verdict, files }
}

const blobOf = async (root, commit, file) => (await git(root, ['ls-tree', '-z', commit, '--', file])).match(/^(100644|100755) blob ([0-9a-f]+)\t/) ?? []

const gitDeps = (root) => ({
  // A regular file's text exactly as committed; null when absent or not UTF-8 (it could not be
  // written back byte for byte).
  read: async (commit, file) => {
    const [, , blob] = await blobOf(root, commit, file)
    if (!blob) return null
    const bytes = await gitInput(root, ['cat-file', 'blob', blob], '')
    const text = bytes.toString('utf8')
    return Buffer.from(text, 'utf8').equals(bytes) ? text : null
  },
  changed: async (from, to) => (await git(root, ['diff', '--name-only', '--no-renames', '-z', from, to])).split('\0').filter(Boolean),
  docs: async (commit, files) => {
    const specs = files.map((file) => `${commit}:${file}`), shown = await batchShow(root, specs)
    return Promise.all(specs.map(async (spec, index) => (shown[index] === undefined ? await git(root, ['show', spec], [128]) : shown[index]) ?? ''))
  },
  versionSetAt: async (commit, file, marker) => marker ? (await git(root, ['log', '-1', '--format=%H', `-S${marker}`, commit, '--', file])).trim() || null : null,
})

// commit-tree is plumbing and ignores commit.gpgsign: a project whose release branch requires signed
// commits would refuse every bump. The bump is signed (-S, the user's own gpg/ssh setup) when that
// setting is on. A signature that cannot be made — no key, a locked agent, a prompt nobody answers
// within SIGN_TIMEOUT_MS — throws SignError: the bump is skipped, the landing is not.
export const SIGN_TIMEOUT_MS = 60000
export class SignError extends Error {}
const signs = async (root) => (await git(root, ['config', '--type=bool', '--get', 'commit.gpgsign'], [1]))?.trim() === 'true'

// One commit on `parent` with `files` replaced, built in a temporary index: HEAD, the index and the
// working tree stay as they are, and no ref points at the commit until the caller moves one.
async function commitFiles(root, parent, message, files) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'gusta-version-'))
  const index = (args) => execute('git', ['-C', root, ...args], { encoding: 'utf8', env: { ...process.env, GIT_INDEX_FILE: path.join(temporary, 'index') } })
  try {
    await index(['read-tree', parent])
    for (const [file, text] of Object.entries(files)) {
      const [, mode] = await blobOf(root, parent, file)
      // --stdin hashes the bytes as given: no line-ending or clean filter rewrites them.
      const blob = (await gitInput(root, ['hash-object', '-w', '--stdin'], text)).toString().trim()
      await index(['update-index', '--cacheinfo', `${mode},${blob},${file}`])
    }
    const tree = (await index(['write-tree'])).stdout.trim()
    if (!(await signs(root))) return (await git(root, ['commit-tree', tree, '-p', parent, '-m', message])).trim()
    try {
      return (await execute('git', ['-C', root, 'commit-tree', '-S', tree, '-p', parent, '-m', message], { encoding: 'utf8', timeout: SIGN_TIMEOUT_MS })).stdout.trim()
    } catch (error) {
      throw new SignError(`${error.killed ? `signing timed out after ${SIGN_TIMEOUT_MS / 1000}s: ` : ''}${`${error.stderr || error.message}`.trim().slice(-500)}`)
    }
  } finally { await rm(temporary, { recursive: true, force: true }) }
}

// The bump for landing `head` on a release branch now at `base`: { commit, version }. commit is
// null when nothing is bumped, and version then says why ({ skipped }; `sign-failed` keeps the
// level it would have had and the signer's error).
export async function versionBump(root, { base, head }, injected = {}) {
  const deps = { ...gitDeps(root), commit: commitFiles, ...injected }
  const plan = await planBump({ base, head }, deps)
  if (plan.skipped) return { commit: null, version: plan }
  const { files, ...version } = plan
  try {
    return { commit: await deps.commit(root, head, `chore: bump version to ${version.to}`, files), version }
  } catch (error) {
    if (!(error instanceof SignError)) throw error
    return { commit: null, version: { skipped: 'sign-failed', ...version, error: error.message } }
  }
}

// Of `files` that differ between two commits, those that changed more than a version value.
export async function beyondVersion(root, from, to, files, injected = {}) {
  const { read } = { ...gitDeps(root), ...injected }
  const kept = []
  for (const file of files) if (!VERSIONED.has(file) || !versionOnly(file, await read(from, file), await read(to, file))) kept.push(file)
  return kept
}
