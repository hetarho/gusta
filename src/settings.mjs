import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { inspectWorkspace, git } from './workspace.mjs'
import { sections } from './spec-format.mjs'
import { SkillPackageError } from './errors.mjs'

// spec/SETTINGS.md holds package behavior the owner chose: one `- key: value  # note` line per key.
// A missing file or key means the default, so projects need no migration when a key is added.
// `?` marks a choice nobody made yet: haeram-init asks for it before work starts.
const BRANCH = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[A-Za-z0-9._/-]+(?<![./])$/
const isBranch = (value) => typeof value === 'string' && BRANCH.test(value) && value !== 'HEAD' && !value.endsWith('.lock')
const oneOf = (...values) => ({ values: values.join('|'), accepts: (value) => values.includes(value) })
const branchOr = (...special) => ({ values: `${special.join('|')}|<branch>`, accepts: (value) => special.includes(value) || (isBranch(value) && !['true', 'false'].includes(value)) })

export const SETTINGS = {
  'prune-branches': { default: true, ...oneOf(true, false),
    note: 'true = when work ends, delete the branches, worktrees and wip refs the CLI created once their work is merged; false = keep them' },
  land: { default: '?', required: true, ...branchOr('?', 'current'),
    note: 'branch finished work lands on (start-vibe session end, self-improve, work groups); current = stay on the branch the work was done on' },
  'land-via': { default: 'merge', ...oneOf('merge', 'pr'),
    note: 'merge = merge into land (on the remote when push is true); pr = push the work branch and open a PR into land' },
  push: { default: false, ...oneOf(true, false),
    note: 'true = push land to the remote once at session end or loop stop (every push runs remote CI)' },
  deploy: { default: '-', ...branchOr('-'),
    note: "branch the deploy command (vibe deploy, '배포해줘') fast-forwards to land; - = land is the release branch" },
  plan: { default: '?', ...branchOr('?', '-'),
    note: 'planning branch where task IDs and SSOT revs are numbered (vibe plan-sync/plan-push); ? = land when it names a branch, else the repository default branch; - = this checkout only' },
}
export const SETTINGS_FILE = 'spec/SETTINGS.md'
const TITLE = '# SETTINGS'
const PREAMBLE = '> Package behavior the owner chose. Show or change with /haeram-setting (`vibe settings`); decide unset (?) keys with /haeram-init. A missing key uses its default.'
const LINE = /^-\s+([\w-]+):\s*([^#]*?)\s*(?:#.*)?$/
const coerce = (raw) => raw === 'true' ? true : raw === 'false' ? false : raw
const fail = (message, details = []) => { throw new SkillPackageError(message, details) }

export function parseSettings(text) {
  const values = {}, errors = [], unknown = []
  for (const line of text.split('\n')) {
    const match = line.match(LINE)
    if (!match) continue
    const [, key, raw] = match
    if (!Object.hasOwn(SETTINGS, key)) { unknown.push(key); continue }
    const value = coerce(raw)
    if (!SETTINGS[key].accepts(value)) errors.push(`${key}: ${raw || '(empty)'} (${SETTINGS[key].values})`)
    else values[key] = value
  }
  if (text.trim() && !text.split('\n').includes(TITLE)) errors.push(`title is not '${TITLE}'`)
  return { values, errors, unknown }
}

// STATE cfg push/plan before they moved here (read only while SETTINGS lacks the key; migrate moves them).
export function legacyCfg(stateText) {
  const cfg = new Map()
  for (const line of stateText ? sections(stateText).get('cfg') ?? [] : []) {
    const match = line.match(/^-\s+([\w-]+):\s*([^#]*)/)
    if (match) cfg.set(match[1], match[2].trim())
  }
  return { push: cfg.get('push') ?? null, plan: cfg.get('plan') ?? null }
}

// Every key with its effective value and source. Branch keys fall back to the legacy STATE cfg:
// cfg push <branch> meant "land on <branch> and push it"; cfg plan named the planning branch.
// An invalid value fails closed: callers that act on a setting must not guess what the owner meant.
export function effectiveSettings(text, stateText = null) {
  const parsed = text === null ? { values: {}, errors: [], unknown: [] } : parseSettings(text)
  const legacy = legacyCfg(stateText)
  const legacyPush = isBranch(legacy.push) && !['-', '?'].includes(legacy.push) ? legacy.push : null
  const fallback = { land: legacyPush, push: legacyPush ? true : undefined, plan: legacy.plan && legacy.plan !== '?' && SETTINGS.plan.accepts(legacy.plan) ? legacy.plan : null }
  const settings = Object.entries(SETTINGS).map(([key, spec]) => {
    const fromFile = Object.hasOwn(parsed.values, key) && !(parsed.values[key] === '?' && fallback[key] != null)
    const fromLegacy = !fromFile && fallback[key] != null
    const value = fromFile ? parsed.values[key] : fromLegacy ? fallback[key] : spec.default
    return { key, value, default: spec.default, source: fromFile ? 'file' : fromLegacy ? 'legacy-cfg' : 'default', values: spec.values, note: spec.note }
  })
  const unset = settings.filter((entry) => SETTINGS[entry.key].required && entry.value === '?').map((entry) => entry.key)
  const legacyKeys = ['push', 'plan'].filter((key) => legacy[key] !== null)
  return { exists: text !== null, settings, errors: parsed.errors, unknown: parsed.unknown, unset, legacy: legacyKeys }
}

// What the session tools act on. land/plan are branch names or null; pushTarget is the branch
// `vibe push` publishes (land, or the current branch when land is current).
export function branchPlan(values, { branch = null, defaultBranch = null } = {}) {
  const land = isBranch(values.land) && values.land !== 'current' ? values.land : null
  const plan = values.plan === '-' ? null : isBranch(values.plan) ? values.plan : land ?? defaultBranch
  const via = values['land-via']
  return {
    land, via, push: values.push === true, deploy: isBranch(values.deploy) ? values.deploy : null, plan,
    pushTarget: values.push === true && via !== 'pr' ? land ?? branch : null,
    landTarget: land && land !== branch ? land : null,
    unset: values.land === '?',
  }
}

async function readOptional(file) {
  try { return await readFile(file, 'utf8') } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

async function settingsRoot(options) {
  if (options.root) return options.root
  const workspace = await inspectWorkspace(options)
  return workspace.git?.root ?? workspace.targetRoot
}

export async function readSettings(options) {
  const root = await settingsRoot(options)
  const result = effectiveSettings(await readOptional(path.join(root, SETTINGS_FILE)), await readOptional(path.join(root, 'spec/STATE.md')))
  if (result.errors.length) fail(`${SETTINGS_FILE} 값이 잘못됐습니다. /haeram-setting으로 고치세요.`, result.errors)
  return { ...result, values: Object.fromEntries(result.settings.map((entry) => [entry.key, entry.value])) }
}

// The effective value of one key in a checkout. Throws when the file holds an invalid value.
export async function readSetting(options, key) {
  return (await readSettings(options)).values[key]
}

// The branch the repository calls its default (origin/HEAD), else the main checkout's branch.
export async function defaultBranch(root) {
  const remote = (await git(root, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], [1, 128]))?.trim()
  if (remote) return remote.replace(/^[^/]+\//, '')
  const first = (await git(root, ['worktree', 'list', '--porcelain'], [128]))?.match(/^branch refs\/heads\/(.+)$/m)
  return first?.[1] ?? null
}

function renderLine(key, value) {
  return `- ${key}: ${value}  # ${SETTINGS[key].note}`
}

// Replace each key's line in place (keeping everything else), or append it; a new file gets
// the title and preamble. The caller commits.
export function applySettings(text, changes) {
  const lines = text === null ? [TITLE, PREAMBLE, ''] : text.replace(/\n$/, '').split('\n')
  for (const [key, value] of Object.entries(changes)) {
    const index = lines.findIndex((line) => line.match(LINE)?.[1] === key)
    if (index === -1) lines.push(renderLine(key, value))
    else lines[index] = renderLine(key, value)
  }
  return `${lines.join('\n')}\n`
}

function parseChanges(pairs = []) {
  const changes = {}
  for (const pair of pairs) {
    const [key, ...rest] = pair.split('=')
    if (!Object.hasOwn(SETTINGS, key ?? '')) fail(`알 수 없는 설정: ${key}`, Object.keys(SETTINGS))
    const value = coerce(rest.join('=').trim())
    if (!SETTINGS[key].accepts(value)) fail(`${key} 값은 ${SETTINGS[key].values} 중 하나입니다.`)
    changes[key] = value
  }
  return changes
}

export async function writeSettings(root, changes) {
  const file = path.join(root, SETTINGS_FILE)
  const before = await readOptional(file)
  const parsed = before === null ? { values: {} } : parseSettings(before)
  const changed = Object.keys(changes).filter((key) => before === null || parsed.values[key] !== changes[key])
  if (changed.length) {
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, applySettings(before, Object.fromEntries(changed.map((key) => [key, changes[key]]))))
  }
  return changed
}

// vibe settings [--set key=value ...]: show the effective settings; --set writes spec/SETTINGS.md.
export async function vibeSettings(options = {}) {
  const changes = parseChanges(options.set)
  const root = await settingsRoot(options)
  const changed = await writeSettings(root, changes)
  const result = effectiveSettings(await readOptional(path.join(root, SETTINGS_FILE)), await readOptional(path.join(root, 'spec/STATE.md')))
  return { schemaVersion: 1, ok: !result.errors.length, file: SETTINGS_FILE, ...result, changed }
}
