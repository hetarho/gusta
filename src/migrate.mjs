import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import path from 'node:path'
import { inspectWorkspace, git, showMany } from './workspace.mjs'
import { legacyCfg, parseSettings, applySettings, effectiveSettings, SETTINGS_FILE } from './settings.mjs'
import { lintSpec } from './spec-lint.mjs'
import { getPackageInfo } from './package-info.mjs'
import { AGENT_CONFIG, LOCK_FILE, PACKAGE_NAME } from './constants.mjs'
import { SkillPackageError } from './errors.mjs'
import { SESSIONS_FILE, EMPTY_SESSIONS, readSessions, splitState, mergeSessions, legacySections } from './coord-doc.mjs'
import { COORD_BRANCH, openCoord } from './coord-branch.mjs'

const execute = promisify(execFile)
const BUNDLED_FORMAT = new URL('../skills/gusta-create-architecture/assets/FORMAT.md', import.meta.url)
const CHANGELOG = new URL('../CHANGELOG.md', import.meta.url)

// Structural changes between versions, applied in order to the texts a project keeps: spec/STATE.md
// (`state`), spec/SETTINGS.md (`settings`) and SESSIONS.md on the coordination branch (`sessions`;
// null or absent when there is no branch to hold it — not a Git checkout). Each run is pure over
// those texts and idempotent: on already-migrated input it returns the input itself. Semantic
// merges (a project's own FORMAT edits) are reported, not guessed — see formatDrift and syncFormat.
export const MIGRATIONS = [
  {
    id: 'branch-settings',
    summary: 'STATE cfg push/plan → spec/SETTINGS.md land·push·plan',
    run(input) {
      const { state, settings } = input
      if (state === null) return input
      const parsed = settings === null ? { values: {}, errors: [] } : parseSettings(settings)
      if (parsed.errors.length) return input
      const legacy = legacyCfg(state)
      if (legacy.push === null && legacy.plan === null) return input
      const present = parsed.values
      const changes = {}
      if (legacy.push && !['-', '?'].includes(legacy.push)) {
        if (present.land === undefined || present.land === '?') changes.land = legacy.push
        if (present.push === undefined) changes.push = true
      }
      if (legacy.plan && legacy.plan !== '?' && (present.plan === undefined || present.plan === '?')) changes.plan = legacy.plan
      return { ...input, state: dropCfgKeys(state, ['push', 'plan']), settings: Object.keys(changes).length ? applySettings(settings, changes) : settings }
    },
  },
  {
    id: 'sessions-branch',
    summary: `STATE active·inbox·log → ${SESSIONS_FILE} on the coordination branch`,
    // The sections leave STATE and join what the coordination document already holds: lines are
    // unioned and a session row both hold keeps the later `at`, so a run repeated after the
    // branch was written (and STATE was not) ends in the same two texts. A six-cell active row
    // gets `-` for branch and commit. Without a coordination document STATE keeps its sections.
    // `history` (movedBefore) is what the branch held before this run: a line any of its commits
    // ever had was moved already — by an earlier run or another checkout — and is not moved again
    // (the owner may have resolved it since); the old active rows move only into a branch that did
    // not exist yet (the sessions on an existing one beat again). Absent: nothing was moved before.
    run(input) {
      const { state, sessions } = input
      if (state === null || sessions === null || sessions === undefined) return input
      const split = splitState(state, movedOnce(input.history))
      if (!split.moved.length) return input
      return { ...input, state: split.state, sessions: split.sessions === EMPTY_SESSIONS ? sessions : mergeSessions('', sessions, split.sessions).text }
    },
  },
]

// What of STATE's session sections a migration takes, given the branch's history.
function movedOnce(history) {
  const seen = new Set((history?.lines ?? []).map((line) => line.trim()))
  return { rows: !history?.existed, line: (line) => !seen.has(line.trim()) }
}

// Every migration over one input → the texts they end in and what each one changed.
export function runMigrations(input) {
  let current = input
  const applied = []
  for (const migration of MIGRATIONS) {
    const next = migration.run(current)
    const changed = ['state', 'settings', 'sessions'].filter((key) => next[key] !== current[key])
    if (changed.length) applied.push({ id: migration.id, summary: migration.summary, changed })
    current = next
  }
  return { result: current, applied }
}

// The session sections a STATE text still carries and what each holds; `carries` is false when
// they are all empty (nothing for the coordination branch to take). dropped: what of it the
// branch's history says is not moved again (see sessions-branch).
export function sessionSections(state, history) {
  const count = (split) => {
    const held = readSessions(split.sessions)
    return Object.fromEntries(split.moved.map((section) => [section, section === 'active' ? held.active.length : held[section].length]))
  }
  const split = splitState(state)
  const all = count(split), taken = count(splitState(state, movedOnce(history)))
  const entry = (section, value) => section === 'active' ? { section, rows: value } : { section, lines: value }
  return { carries: split.sessions !== EMPTY_SESSIONS, sections: split.moved.map((section) => entry(section, all[section])),
    dropped: split.moved.filter((section) => all[section] > taken[section]).map((section) => entry(section, all[section] - taken[section])) }
}

// Remove `- key: ...` lines from the STATE cfg section only.
export function dropCfgKeys(state, keys) {
  const lines = state.split('\n')
  let inCfg = false
  return lines.filter((line) => {
    if (/^## /.test(line)) inCfg = line.trim() === '## cfg'
    return !(inCfg && keys.some((key) => new RegExp(`^-\\s+${key}:`).test(line)))
  }).join('\n')
}

// Package FORMAT lines the project lacks (new or reworded rules) and project lines the package
// no longer has (obsolete or the project's own), per section. The update skill merges them.
// With `previous` (the previously installed template, null when there is none) each project line
// gets its provenance: previousTemplate when byte-identical to a line of it, projectOwned
// otherwise, unknown without it.
export function formatDrift(packaged, project, previous) {
  const bySection = (text) => {
    const result = new Map()
    let section = '(top)'
    for (const line of text.split('\n')) {
      if (/^## /.test(line)) { section = line.slice(3).trim(); continue }
      if (/^\s*(- |\| )/.test(line)) result.set(line.trim(), { section, raw: line.replace(/\r$/, '') })
    }
    return result
  }
  const ours = bySection(packaged), theirs = bySection(project)
  const template = previous ? new Set(previous.split(/\r?\n/)) : null
  const provenance = (raw) => previous === undefined ? {} : { provenance: !template ? 'unknown' : template.has(raw) ? 'previousTemplate' : 'projectOwned' }
  const missing = [...ours].filter(([line]) => !theirs.has(line)).map(([line, { section }]) => ({ section, line }))
  const extra = [...theirs].filter(([line]) => !ours.has(line)).map(([line, { section, raw }]) => ({ section, line, ...provenance(raw) }))
  return { missing, extra }
}

// Index pairs (a → b) of one longest common subsequence of two line lists.
function common(a, b) {
  const rows = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1))
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) rows[i][j] = a[i] === b[j] ? rows[i + 1][j + 1] + 1 : Math.max(rows[i + 1][j], rows[i][j + 1])
  const pairs = new Map()
  for (let i = 0, j = 0; i < a.length && j < b.length;) {
    if (a[i] === b[j]) pairs.set(i++, j++)
    else if (rows[i + 1][j] >= rows[i][j + 1]) i++
    else j++
  }
  return pairs
}

const same = (a, b) => a.length === b.length && a.every((line, index) => line === b[index])
const find = (lines, part) => { for (let at = 0; at + part.length <= lines.length; at++) if (same(lines.slice(at, at + part.length), part)) return at; return -1 }

// Three-way line merge. Base lines both sides kept anchor the hunks between them.
function merge(base, ours, theirs) {
  const inOurs = common(base, ours), inTheirs = common(base, theirs), out = []
  let b = 0, o = 0, t = 0
  const hunk = (bEnd, oEnd, tEnd) => {
    const was = base.slice(b, bEnd), mine = ours.slice(o, oEnd), next = theirs.slice(t, tEnd)
    if (same(mine, was)) return out.push(...next)
    if (same(next, was)) return out.push(...mine)
    // Both changed. The project's lines stay; base lines it still holds whole become the bundled
    // ones, and lines both inserted here are both kept (once).
    const at = was.length ? find(mine, was) : find(mine, next) < 0 ? 0 : -1
    out.push(...at < 0 ? mine : [...mine.slice(0, at), ...next, ...mine.slice(at + was.length)])
  }
  for (let index = 0; index < base.length; index++) {
    if (!inOurs.has(index) || !inTheirs.has(index)) continue
    hunk(index, inOurs.get(index), inTheirs.get(index))
    out.push(base[index]); b = index + 1; o = inOurs.get(index) + 1; t = inTheirs.get(index) + 1
  }
  hunk(base.length, ours.length, theirs.length)
  return out
}

// The project FORMAT with the lines it still has as the previously installed template had them
// replaced by the bundled template (a three-way merge, that template as the base): a line the
// project wrote or changed is never replaced or removed, and a template line it deleted does not
// come back. Pure. A merge that would not give back its own result on a second run is not applied
// (the project text returns), so a synced text always returns unchanged.
export function syncFormat(previous, project, packaged) {
  const [base, theirs] = [previous, packaged].map((text) => text.split(/\r?\n/))
  const merged = merge(base, project.split(/\r?\n/), theirs)
  const text = merged.join(project.includes('\r\n') ? '\r\n' : '\n')
  return text !== project && same(merge(base, merged, theirs), merged) ? text : project
}

const TEMPLATE = 'gusta-create-architecture/assets/FORMAT.md'
const digest = (text) => createHash('sha256').update(text).digest('hex')

// The FORMAT template of the install before the running version, from Git — no network. An
// install is committed with its lock file (gusta-update's install commit), so one commit holds the
// installed copy and the SHA-256 the installer recorded for it. Candidates, newest first: HEAD,
// then — when HEAD's lock already names the running version — the state before each commit that
// changed the lock. The first whose lock names another version is the previous install; its copy
// counts only when it matches the recorded hash (an unmodified package copy).
// Limits: a project that does not commit its installed skills and lock, or committed an edited
// copy, has none (provenance unknown, nothing replaced). Installs before that one are not
// consulted: lines only they had count as the project's own — reported, never replaced.
export async function previousTemplate(root, running, { show = (specs) => showMany(root, specs), log = () => git(root, ['log', '--format=%H', '-n', '20', 'HEAD', '--', LOCK_FILE], [128]) } = {}) {
  const copies = Object.values(AGENT_CONFIG).map(({ root: prefix }) => `${prefix}/${TEMPLATE}`)
  const revs = ['HEAD']
  for (let index = 0; index < revs.length; index++) {
    const [lockText, ...texts] = await show([`${revs[index]}:${LOCK_FILE}`, ...copies.map((file) => `${revs[index]}:${file}`)])
    let lock
    try { lock = JSON.parse(lockText ?? 'null') } catch { return { reason: 'invalid-lock' } }
    if (lock?.packageName !== PACKAGE_NAME || !lock.files || typeof lock.files !== 'object') return { reason: 'no-lock' }
    if (lock.packageVersion === running) {
      if (!index) revs.push(...((await log()) ?? '').split('\n').filter(Boolean).map((commit) => `${commit}^`))
      continue
    }
    const found = copies.findIndex((file, at) => typeof texts[at] === 'string' && lock.files[file]?.sha256 === digest(texts[at]))
    const version = lock.packageVersion ?? null
    return found < 0 ? { reason: 'no-unmodified-copy', version } : { version, source: `${revs[index]}:${copies[found]}`, text: texts[found] }
  }
  return { reason: 'no-previous-version' }
}

async function readOptional(file) {
  try { return await readFile(file, 'utf8') } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

const counted = (entry) => `${entry.section} ${entry.rows ?? entry.lines}${entry.rows === undefined ? '줄' : '행'}`

// gusta migrate [--dry-run]: apply every pending migration and the FORMAT sync (syncFormat over
// deps.previousFormat(root), default previousTemplate), then report the FORMAT drift left, unset
// settings and lint. The caller reviews and commits (spec/ only). deps.coord opens the
// coordination branch (openCoord's signature); deps.history(store) → { existed, lines } is what
// that branch held before (default store.history(): its log here and on the remote).
// SESSIONS.md is an input like the files: read from the coordination branch — synced with the
// remote first, so a checkout that never fetched it does not start a second history — and written
// there before any file: once STATE loses its session sections that branch holds their only copy.
// A run that dies in between leaves the lines in both, and the next one ends in the same texts;
// so does a run in another checkout whose STATE still has the sections (see sessions-branch).
// --dry-run writes neither (and reads the branch as last fetched). A target that is not a Git
// checkout has no branch to move them to: that migration is skipped and STATE keeps the sections.
export async function migrateSpec(options = {}, deps = {}) {
  const workspace = await inspectWorkspace(options)
  const root = workspace.git?.root ?? workspace.targetRoot
  const files = { state: path.join(root, 'spec/STATE.md'), settings: path.join(root, SETTINGS_FILE) }
  const disk = { state: await readOptional(files.state), settings: await readOptional(files.settings) }
  if (disk.state === null) throw new SkillPackageError('spec/STATE.md가 없습니다. 새 프로젝트는 gusta-create-architecture로 시작하세요.')
  // Invalid owner choices are evidence to preserve, not absent keys for a migration to fill.
  const before = effectiveSettings(disk.settings, disk.state)
  const invalidInput = before.errors.length > 0
  const chosen = (key, fallback) => before.settings.find((entry) => entry.key === key)?.value ?? fallback
  const coord = invalidInput || !workspace.git ? null
    : await (deps.coord ?? openCoord)({ cwd: root, branch: chosen('coord', COORD_BRANCH), push: chosen('coord-push', true) !== false })
  // A sync that cannot reach the remote, or cannot take it in, leaves the branch as last fetched.
  if (coord?.sync && !options.dryRun && legacySections(disk.state).length) await coord.sync().catch(() => null)
  const held = coord ? await coord.read() : { commit: null, text: null }
  const historyOf = async () => deps.history ? deps.history(coord) : coord.history ? coord.history() : { existed: held.commit !== null, lines: [] }
  const history = coord ? await historyOf() : undefined
  const original = { ...disk, sessions: held.text, ...(history ? { history } : {}) }
  const { result: current, applied: ran } = invalidInput ? { result: original, applied: [] } : runMigrations(original)
  const settings = effectiveSettings(current.settings, current.state)
  const ok = !settings.errors.length
  const place = { ...Object.fromEntries(Object.entries(files).map(([key, file]) => [key, path.relative(root, file)])), sessions: `${coord?.branch}:${SESSIONS_FILE}` }
  const applied = ok ? ran.map(({ id, summary, changed }) => ({ id, summary, files: changed.map((key) => place[key]) })) : []
  const changed = new Set(ok ? ran.flatMap((entry) => entry.changed) : [])
  const formatFile = path.join(root, 'spec/FORMAT.md'), projectFormat = await readOptional(formatFile)
  const packaged = projectFormat === null ? null : await readFile(BUNDLED_FORMAT, 'utf8')
  const prior = projectFormat === null ? null : !workspace.git ? { reason: 'not-git' }
    : await (deps.previousFormat ?? (async (at) => previousTemplate(at, (await getPackageInfo()).version)))(root)
  const synced = ok && prior?.text ? syncFormat(prior.text, projectFormat, packaged) : projectFormat
  if (synced !== projectFormat) applied.push({ id: 'format-template', summary: 'spec/FORMAT.md lines as the previous template had them → the bundled template', files: ['spec/FORMAT.md'] })
  const found = ok ? sessionSections(disk.state, history) : { carries: false, sections: [], dropped: [] }
  let commit = held.commit, published = null
  if (!options.dryRun && ok) {
    if (changed.has('sessions')) {
      // The branch may have moved since it was read: the same migrations run on what it holds now.
      commit = (await coord.update(async (text, at) => runMigrations({ ...disk, sessions: text, history: at.commit === held.commit ? history : await historyOf() }).result.sessions, { message: 'gusta: migrate sessions from STATE' })).commit
    }
    for (const key of Object.keys(files).filter((name) => changed.has(name))) {
      await mkdir(path.dirname(files[key]), { recursive: true })
      await writeFile(files[key], current[key])
    }
    if (synced !== projectFormat) await writeFile(formatFile, synced)
    // Other clones read the moved lines from the remote (SETTINGS coord-push); a run repeated
    // after a failure publishes too. publish never throws: its answer is reported.
    if (coord && found.carries) {
      const sent = await coord.publish()
      published = { pushed: sent.pushed, reason: sent.reason ?? null, error: sent.error ?? null, lost: sent.lost ?? [] }
      if (sent.commit) commit = sent.commit
    }
  }
  const dropped = coord ? found.dropped : []
  const sessions = !ok ? null : {
    branch: coord?.branch ?? null, moved: coord ? found.sections : [], commit: coord ? commit : null, published, skipped: coord ? null : 'not-git', ...(dropped.length ? { dropped } : {}),
    note: !found.sections.length ? 'STATE에 옮길 세션 섹션(active·inbox·log)이 없습니다.'
      : !coord ? `Git checkout이 아니어서 STATE의 ${found.sections.map((entry) => entry.section).join('·')}를 옮기지 않았습니다 — 조정 브랜치는 Git 저장소에만 둘 수 있습니다.`
      : `조정 브랜치 ${coord.branch}의 ${SESSIONS_FILE}로 ${options.dryRun ? '옮길 예정입니다' : '옮겼습니다'}: ${found.sections.map(counted).join(' · ')}.${dropped.length ? ` 그중 이미 조정 브랜치에 있던(그 뒤 해소된 것 포함) 줄과, 브랜치가 이미 있어 세션이 다시 등록할 옛 active 행은 옮기지 않았습니다: ${dropped.map(counted).join(' · ')}.` : ''}`,
  }
  // The drift left once the sync is written (--dry-run too): what the update skill still reviews.
  const { text: _text, ...previous } = prior ?? {}
  const format = projectFormat === null ? { missing: [], extra: [], absent: true } : { previous, ...formatDrift(packaged, synced, prior.text ?? null) }
  const lint = options.dryRun || !ok ? null : await lintSpec({ targetRoot: root })
  return { schemaVersion: 1, ok, dryRun: Boolean(options.dryRun), applied, sessions, format, unset: settings.unset, settingsErrors: settings.errors,
    lint: lint && { ok: lint.ok, errors: lint.errors, warnings: lint.warnings } }
}

const parts = (version) => version.split('.').map(Number)
const newer = (a, b) => {
  const [x, y] = [parts(a), parts(b)]
  for (let index = 0; index < 3; index++) if ((x[index] ?? 0) !== (y[index] ?? 0)) return (x[index] ?? 0) > (y[index] ?? 0)
  return false
}

// CHANGELOG sections after `since` up to `until` (inclusive), newest first, each bullet cut to its
// first sentence: what the update skill reports as changed behavior.
export function changesSince(changelog, since, until) {
  const result = []
  let current = null
  for (const line of changelog.split('\n')) {
    const heading = line.match(/^## (\d+\.\d+\.\d+)\s*$/)
    if (heading) { current = (!since || newer(heading[1], since)) && (!until || !newer(heading[1], until)) ? { version: heading[1], items: [] } : null; if (current) result.push(current); continue }
    if (/^## /.test(line)) { current = null; continue }
    if (current && line.startsWith('- ')) current.items.push(line.slice(2).split(/(?<=\.)\s/)[0].slice(0, 240))
  }
  return result
}

// gusta outdated: the version this project installed (lock file), the one running,
// and the newest on npm, plus the running package's CHANGELOG since the installed version.
// A failed npm lookup is reported, not fatal.
export async function packageVersions(options = {}, { view = (name) => execute('npm', ['view', name, 'version'], { encoding: 'utf8', timeout: 30000 }).then((result) => result.stdout.trim()) } = {}) {
  const workspace = await inspectWorkspace(options)
  const root = workspace.git?.root ?? workspace.targetRoot
  const lock = await readOptional(path.join(root, LOCK_FILE))
  let installed = null
  try { installed = lock ? JSON.parse(lock).packageVersion ?? null : null } catch { installed = null }
  const running = (await getPackageInfo()).version
  let latest = null, error = null
  try { latest = await view(PACKAGE_NAME) } catch (caught) { error = (caught.stderr || caught.message || '').trim().slice(-300) }
  const changes = installed ? changesSince(await readOptional(CHANGELOG) ?? '', installed, running) : []
  return { schemaVersion: 1, ok: true, installed, running, latest, outdated: Boolean(latest && (!installed || newer(latest, installed))), changes, error }
}
