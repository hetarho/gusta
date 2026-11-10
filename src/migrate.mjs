import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { inspectWorkspace } from './workspace.mjs'
import { legacyCfg, parseSettings, applySettings, effectiveSettings, SETTINGS_FILE } from './settings.mjs'
import { lintSpec } from './spec-lint.mjs'
import { getPackageInfo } from './package-info.mjs'
import { LOCK_FILE, PACKAGE_NAME } from './constants.mjs'
import { SkillPackageError } from './errors.mjs'

const execute = promisify(execFile)
const BUNDLED_FORMAT = new URL('../skills/create-architecture/assets/FORMAT.md', import.meta.url)
const CHANGELOG = new URL('../CHANGELOG.md', import.meta.url)

// Structural changes between versions, applied to a project's spec/ in order. Each run is pure
// over file texts and idempotent: on already-migrated files it returns them unchanged. Semantic
// merges (a project's own FORMAT edits) are reported, not guessed — see formatDrift.
export const MIGRATIONS = [
  {
    id: 'branch-settings',
    summary: 'STATE cfg push/plan → spec/SETTINGS.md land·push·plan',
    run({ state, settings }) {
      if (state === null) return { state, settings }
      const legacy = legacyCfg(state)
      if (legacy.push === null && legacy.plan === null) return { state, settings }
      const present = settings === null ? {} : parseSettings(settings).values
      const changes = {}
      if (legacy.push && !['-', '?'].includes(legacy.push)) {
        if (present.land === undefined || present.land === '?') changes.land = legacy.push
        if (present.push === undefined) changes.push = true
      }
      if (legacy.plan && legacy.plan !== '?' && (present.plan === undefined || present.plan === '?')) changes.plan = legacy.plan
      return { state: dropCfgKeys(state, ['push', 'plan']), settings: Object.keys(changes).length ? applySettings(settings, changes) : settings }
    },
  },
]

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
export function formatDrift(packaged, project) {
  const bySection = (text) => {
    const result = new Map()
    let section = '(top)'
    for (const line of text.split('\n')) {
      if (/^## /.test(line)) { section = line.slice(3).trim(); continue }
      if (/^\s*(- |\| )/.test(line)) result.set(line.trim(), section)
    }
    return result
  }
  const ours = bySection(packaged), theirs = bySection(project)
  const missing = [...ours].filter(([line]) => !theirs.has(line)).map(([line, section]) => ({ section, line }))
  const extra = [...theirs].filter(([line]) => !ours.has(line)).map(([line, section]) => ({ section, line }))
  return { missing, extra }
}

async function readOptional(file) {
  try { return await readFile(file, 'utf8') } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

// haeram-spec-creator migrate [--dry-run]: apply every pending migration to spec/, then report
// FORMAT drift, unset settings and lint. The caller reviews and commits (spec/ only).
export async function migrateSpec(options = {}) {
  const workspace = await inspectWorkspace(options)
  const root = workspace.git?.root ?? workspace.targetRoot
  const files = { state: path.join(root, 'spec/STATE.md'), settings: path.join(root, SETTINGS_FILE) }
  let current = { state: await readOptional(files.state), settings: await readOptional(files.settings) }
  if (current.state === null) throw new SkillPackageError('spec/STATE.md가 없습니다. 새 프로젝트는 create-architecture로 시작하세요.')
  const applied = []
  for (const migration of MIGRATIONS) {
    const next = migration.run(current)
    const changed = Object.keys(files).filter((key) => next[key] !== current[key])
    if (changed.length) applied.push({ id: migration.id, summary: migration.summary, files: changed.map((key) => path.relative(root, files[key])) })
    current = next
  }
  if (!options.dryRun) {
    for (const key of new Set(applied.flatMap((entry) => entry.files))) {
      const name = Object.keys(files).find((entry) => path.relative(root, files[entry]) === key)
      await mkdir(path.dirname(files[name]), { recursive: true })
      await writeFile(files[name], current[name])
    }
  }
  const projectFormat = await readOptional(path.join(root, 'spec/FORMAT.md'))
  const format = projectFormat === null ? { missing: [], extra: [], absent: true } : formatDrift(await readFile(BUNDLED_FORMAT, 'utf8'), projectFormat)
  const settings = effectiveSettings(current.settings, current.state)
  const lint = options.dryRun ? null : await lintSpec({ targetRoot: root })
  return { schemaVersion: 1, ok: true, dryRun: Boolean(options.dryRun), applied, format, unset: settings.unset, settingsErrors: settings.errors,
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

// haeram-spec-creator outdated: the version this project installed (lock file), the one running,
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
