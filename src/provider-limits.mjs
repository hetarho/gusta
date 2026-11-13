import { readFile, writeFile, rename, mkdir, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { TIERS } from './agent-catalog.mjs'

// Why an AI tool's headless run failed, read from what its adapter kept (no model call, no I/O): a usage
// limit (the tool, or one model family, is out until a reset), a rate limit, an overload, a sign-in
// problem, or anything else. Runners move a unit to the next allowed combination on the first two
// (recorded in limits.json, shared by every worktree of the clone), retry an overload once, drop a tool
// that needs a login for the run, and count none of them as a failed unit.
export const FAILURE_KINDS = ['usage-limit', 'rate-limit', 'overloaded', 'auth', 'other']
// The kinds runners fall back on instead of counting a failure; the first two are recorded blocks.
export const LIMIT_KINDS = ['usage-limit', 'rate-limit', 'overloaded', 'auth']
export const BLOCKING = ['usage-limit', 'rate-limit']
// The adapter's exit code for a classified failure (EX_TEMPFAIL), with one {"failure":{...}} stdout line.
export const LIMIT_EXIT = 75
// No reset in the message: 30 minutes, doubled for a target blocked on a guess within a day, up to 5 hours.
export const GUESS_MS = 30 * 60000
export const MAX_GUESS_MS = 5 * 3600000
const REMEMBER_MS = 24 * 3600000
// An overload is retried once on the same combination after this pause.
export const OVERLOAD_RETRY_MS = 30000
// Waiting for a reset checks the stop file, configuration requests and the deadline this often.
export const LIMIT_POLL_MS = 60000

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const USAGE = /hit your (?:[\w-]+ )?(?:usage )?limit|usage limit|usage_limit_reached|quota_exceeded|insufficient_quota|exceeded your (?:current )?quota|credit balance is too low|billing_error|out of (?:credits|extra usage)/i
// Message words only (a bare status number could be anything in a stderr tail); structured status codes
// are read from the events above.
const AUTH = /not logged in|please (?:run )?\/?log ?in\b|log ?in again|invalid (?:api|x-api) key|invalid_api_key|authentication[_ ](?:error|failed)|401 unauthori[sz]ed|(?:oauth |access |refresh )?token (?:has )?(?:expired|been revoked)|invalid_grant/i
const RATE = /rate[ _-]?limit|too many requests/i
const OVERLOAD = /overloaded|server is busy|temporarily unavailable/i

// --- reset times -------------------------------------------------------------------------------
// Wall-clock fields read in a named zone, or the machine's local zone when none (or an unknown one).
function zoneOffset(ms, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
    .formatToParts(ms).filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]))
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour % 24, parts.minute, parts.second) - Math.floor(ms / 1000) * 1000
}
const validZone = (timeZone) => { try { return Boolean(timeZone) && Boolean(new Intl.DateTimeFormat('en-US', { timeZone })) } catch { return false } }
function today(now, timeZone) {
  if (!timeZone) { const date = new Date(now); return { year: date.getFullYear(), month: date.getMonth(), day: date.getDate() } }
  const shifted = new Date(now + zoneOffset(now, timeZone))
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth(), day: shifted.getUTCDate() }
}
function wallClock({ year, month, day, hour, minute }, timeZone) {
  if (!timeZone) return new Date(year, month, day, hour, minute).getTime()
  const guess = Date.UTC(year, month, day, hour, minute)
  const first = guess - zoneOffset(guess, timeZone)
  return guess - zoneOffset(first, timeZone)
}
const hour24 = (hour, meridiem) => { const pm = /^p/i.test(meridiem ?? ''), am = /^a/i.test(meridiem ?? ''); return pm && hour < 12 ? hour + 12 : am && hour === 12 ? 0 : hour }
// A time of day (with an optional month and day) at or after now: a time already past today is tomorrow's,
// a date already past is next year's.
function nextWallClock({ month = null, day = null, year = null, hour, minute }, now, timeZone) {
  if (hour > 23 || minute > 59) return null
  const base = today(now, timeZone)
  if (month === null) {
    const at = wallClock({ ...base, hour, minute }, timeZone)
    return at > now ? at : wallClock({ ...base, day: base.day + 1, hour, minute }, timeZone)
  }
  const at = wallClock({ year: year ?? base.year, month, day, hour, minute }, timeZone)
  return at > now || year !== null ? at : wallClock({ year: base.year + 1, month, day, hour, minute }, timeZone)
}
const relative = (text) => {
  let ms = 0
  for (const [, count, unit] of text.matchAll(/(\d+)\s*(d(?:ays?)?|h(?:ours?|rs?)?|m(?:in(?:ute)?s?)?|s(?:ec(?:ond)?s?)?)\b/gi)) ms += Number(count) * ({ d: 86400000, h: 3600000, m: 60000, s: 1000 })[unit[0].toLowerCase()]
  return ms || null
}
const month = (name) => name ? MONTHS.indexOf(name.slice(0, 3).toLowerCase()) : -1

// "resets 3:45pm", "resets Nov 18, 9am (Asia/Seoul)", "resets in 2h 5m" (Claude); "Try again at Nov 14, 2026
// 3:45 PM", "try again in 3 hours" (Codex). Local time unless the message names an IANA zone in parentheses.
export function parseResetText(text, now, { timeZone = null } = {}) {
  const value = String(text ?? '')
  const after = value.match(/\b(?:resets?|try again)\s+in\s+([^.·;\n]+)/i)
  if (after) { const ms = relative(after[1]); return ms ? now + ms : null }
  const match = value.match(/\b(?:resets?(?:\s+at)?|try again at|reset at|available again at)\s+(?:on\s+)?(?:([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(\d{4})?,?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?(?:\s*\(([A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+|UTC)\))?/i)
  if (!match) return null
  const [, monthName, day, year, hour, minute = '0', meridiem, zone] = match
  if (monthName && month(monthName) < 0) return null
  if (!monthName && !meridiem && !value.slice(match.index).match(/^\D*\d{1,2}:\d{2}/)) return null
  const zoneName = validZone(zone) ? zone : validZone(timeZone) ? timeZone : null
  return nextWallClock({ month: monthName ? month(monthName) : null, day: day ? Number(day) : null, year: year ? Number(year) : null, hour: hour24(Number(hour), meridiem), minute: Number(minute) }, now, zoneName)
}
// A reset the tool sent as a number (epoch seconds or milliseconds) or an ISO string.
export function resetValue(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value < 1e12 ? value * 1000 : value
  if (typeof value === 'string' && /^\d{9,13}$/.test(value)) return resetValue(Number(value))
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isFinite(parsed) ? parsed : null
}

// --- classification ----------------------------------------------------------------------------
const textOf = (value) => typeof value === 'string' ? value : value && typeof value === 'object' ? [value.message, value.error, value.result, value.code, value.type].map(textOf).filter(Boolean).join(' ') : ''
const familyIn = (tool, word) => word && Object.hasOwn(TIERS[tool] ?? {}, word.toLowerCase()) ? word.toLowerCase() : null
// Claude's rate_limit_info.rateLimitType: five_hour (session) and seven_day (weekly) are the whole tool's.
const CLAUDE_WINDOWS = { seven_day_opus: 'opus', seven_day_sonnet: 'sonnet' }

// record: { tool, model?, events: parsed provider events the adapter kept, text: its stderr tail }.
// The answer: { kind, scope (tool|family for a block, tool for auth), tool, family?, model?, resetAt?, message }.
export function classifyFailure({ tool, model = null, events = [], text = '' } = {}, { now = Date.now(), timeZone = null } = {}) {
  const list = (Array.isArray(events) ? events : []).filter((event) => event && typeof event === 'object')
  const messages = []
  let kind = null, family = null, reset = null, reported = false
  if (tool === 'claude') {
    const rejected = list.filter((event) => event.type === 'rate_limit_event' && event.rate_limit_info?.status === 'rejected').at(-1)?.rate_limit_info
    const result = list.filter((event) => event.type === 'result' && (event.is_error || String(event.subtype ?? '').startsWith('error'))).at(-1)
    const retry = list.filter((event) => event.type === 'system' && event.subtype === 'api_retry').at(-1)
    if (result) messages.push(textOf(result.result), ...(Array.isArray(result.errors) ? result.errors.map(textOf) : []), textOf(result.error))
    if (rejected) {
      kind = 'usage-limit'
      family = CLAUDE_WINDOWS[rejected.rateLimitType] ?? null
      reset = resetValue(rejected.resetsAt)
      reported = reset !== null
      messages.push(textOf(rejected.errorCode), rejected.rateLimitType ?? '')
    }
    if (!kind && result?.terminal_reason === 'blocking_limit') kind = 'usage-limit'
    const status = Number(result?.api_error_status ?? retry?.error_status)
    if (retry) messages.push(textOf(retry.error), textOf(retry.error_message))
    if (!kind && retry?.error === 'billing_error') kind = 'usage-limit'
    if (!kind && (retry?.error === 'authentication_failed' || status === 401 || status === 403)) kind = 'auth'
    if (!kind && (retry?.error === 'rate_limit' || status === 429)) kind = 'rate-limit'
    if (!kind && (retry?.error === 'overloaded' || status === 529)) kind = 'overloaded'
  } else {
    const failed = list.filter((event) => ['turn.failed', 'error'].includes(event.type))
    for (const event of failed) {
      messages.push(textOf(event.error ?? event.message ?? event))
      const info = event.error && typeof event.error === 'object' ? event.error : event
      const seconds = Number(info.resets_in_seconds ?? info.resetsInSeconds)
      if (Number.isFinite(seconds) && seconds > 0) { reset = now + seconds * 1000; reported = true }
      else if (resetValue(info.resets_at ?? info.resetsAt)) { reset = resetValue(info.resets_at ?? info.resetsAt); reported = true }
    }
  }
  const said = messages.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
  const all = `${said} ${String(text ?? '')}`
  if (!kind) kind = USAGE.test(all) ? 'usage-limit' : AUTH.test(all) ? 'auth' : RATE.test(all) ? 'rate-limit' : OVERLOAD.test(all) ? 'overloaded' : 'other'
  // "You've hit your Opus limit": that family; session, weekly and usage limits are the whole tool's.
  if (kind === 'usage-limit' && !family) family = familyIn(tool, all.match(/hit your ([\w-]+) limit/i)?.[1])
  // An old format carries the epoch after a bar: "usage limit reached|1760000000".
  if (BLOCKING.includes(kind) && !reported) {
    reset = resetValue(all.match(/limit reached\|(\d{9,13})/i)?.[1]) ?? parseResetText(all, now, { timeZone })
  }
  const resetAt = reset !== null && reset > now ? new Date(reset).toISOString() : null
  const message = (said || String(text ?? '').trim().split('\n').filter(Boolean).at(-1) || kind).slice(0, 300)
  return { kind, scope: BLOCKING.includes(kind) ? family ? 'family' : 'tool' : kind === 'auth' ? 'tool' : null, tool,
    ...(family && BLOCKING.includes(kind) ? { family } : {}), ...(model ? { model } : {}), ...(resetAt && BLOCKING.includes(kind) ? { resetAt } : {}), message }
}

// The adapter's stdout line for a classified failure, and its reader (the last line of the output).
export const failureLine = (failure) => JSON.stringify({ failure })
export function parseFailure(output) {
  const last = String(output ?? '').trim().split('\n').at(-1)
  try {
    const failure = JSON.parse(last)?.failure
    return failure && FAILURE_KINDS.includes(failure.kind) && typeof failure.tool === 'string' ? failure : null
  } catch { return null }
}

// --- the shared block record -------------------------------------------------------------------
// <git common dir>/gusta/v1/limits.json: { schemaVersion, entries: [{ tool, family?, reason, resetAt,
// since, source: reported|estimated, guessMs?, hits, message? }] }. Advisory like timings.json: a lost
// concurrent write costs one entry, and an entry whose reset has passed no longer blocks anything.
export const limitsFile = (runtime) => path.join(runtime, 'limits.json')
const targetOf = (entry) => `${entry.tool}/${entry.family ?? '*'}`
export const limitTarget = (entry) => entry.family ? `${entry.tool}/${entry.family}` : entry.tool
const valid = (entry) => entry && typeof entry.tool === 'string' && BLOCKING.includes(entry.reason) && Number.isFinite(Date.parse(entry.resetAt))
export function limitStore(text) {
  try {
    const store = JSON.parse(text)
    return store?.schemaVersion === 1 && Array.isArray(store.entries) ? { schemaVersion: 1, entries: store.entries.filter(valid) } : { schemaVersion: 1, entries: [] }
  } catch { return { schemaVersion: 1, entries: [] } }
}
export const activeLimits = (store, now) => store.entries.filter((entry) => Date.parse(entry.resetAt) > now)
// The store after a usage or rate limit: the reset the tool named, else a guess that doubles while the
// same target keeps hitting its limit (remembered for a day after its reset).
export function noteLimit(store, failure, now) {
  if (!BLOCKING.includes(failure?.kind)) return store
  const entry = { tool: failure.tool, ...(failure.family ? { family: failure.family } : {}) }
  const previous = store.entries.find((item) => targetOf(item) === targetOf(entry) && Date.parse(item.resetAt) + REMEMBER_MS > now)
  const said = failure.resetAt && Date.parse(failure.resetAt) > now ? Date.parse(failure.resetAt) : null
  const guessMs = said ? null : previous?.guessMs ? Math.min(previous.guessMs * 2, MAX_GUESS_MS) : GUESS_MS
  const next = { ...entry, reason: failure.kind, resetAt: new Date(said ?? now + guessMs).toISOString(),
    since: previous && Date.parse(previous.resetAt) > now ? previous.since : new Date(now).toISOString(), source: said ? 'reported' : 'estimated',
    ...(guessMs ? { guessMs } : {}), hits: (previous?.hits ?? 0) + 1, ...(failure.message ? { message: String(failure.message).slice(0, 200) } : {}) }
  return { schemaVersion: 1, entries: [...store.entries.filter((item) => targetOf(item) !== targetOf(entry) && Date.parse(item.resetAt) + REMEMBER_MS > now), next] }
}
// What routeAgent must skip while these entries hold.
export const limitBlocks = (entries) => entries.map((entry) => ({ tool: entry.tool, ...(entry.family ? { family: entry.family } : {}), reason: entry.reason }))
export const earliestReset = (entries) => entries.length ? Math.min(...entries.map((entry) => Date.parse(entry.resetAt))) : null

const io = { readFile, writeFile, rename, mkdir, rm }
export async function readLimits(runtime, { fs = io } = {}) {
  return limitStore(await fs.readFile(limitsFile(runtime), 'utf8').catch(() => ''))
}
// One read-modify-write; returns the entry it recorded.
export async function recordLimit(runtime, failure, { fs = io, now = Date.now() } = {}) {
  const store = noteLimit(await readLimits(runtime, { fs }), failure, now)
  await fs.mkdir(runtime, { recursive: true })
  const temporary = path.join(runtime, `limits.${randomUUID()}.tmp`)
  await fs.writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`)
  try { await fs.rename(temporary, limitsFile(runtime)) } catch (error) { await fs.rm(temporary, { force: true }).catch(() => {}); throw error }
  return store.entries.find((entry) => targetOf(entry) === targetOf({ tool: failure.tool, family: failure.family }))
}

// --- what people read --------------------------------------------------------------------------
const pad = (value) => String(value).padStart(2, '0')
// A reset in local time: HH:MM today, MM-DD HH:MM on another day.
export function resetLabel(iso, now = Date.now()) {
  const at = new Date(iso), day = new Date(now)
  const clock = `${pad(at.getHours())}:${pad(at.getMinutes())}`
  return at.toDateString() === day.toDateString() ? clock : `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${clock}`
}
// "claude 15:45·codex/sol 16:10까지 한도 — 그 뒤 다시 실행하세요" for a run that stopped at its limits.
export const limitHint = (entries, now = Date.now()) => entries.length
  ? `${[...entries].sort((a, b) => Date.parse(a.resetAt) - Date.parse(b.resetAt)).map((entry) => `${limitTarget(entry)} ${resetLabel(entry.resetAt, now)}`).join('·')}까지 사용량 한도 — 그 뒤 다시 실행하세요`
  : null
// A done-line note for a unit moved off a limited combination: "claude limit, resets 15:45" (~ a guess).
export const fallbackNote = (hit, now = Date.now()) => `${limitTarget(hit)} ${hit.kind === 'usage-limit' ? 'limit' : hit.kind}${hit.resetAt ? `, resets ${hit.estimated ? '~' : ''}${resetLabel(hit.resetAt, now)}` : ''}`
