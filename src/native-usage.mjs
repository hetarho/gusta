import { constants } from 'node:fs'
import { open, opendir, lstat, mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { inspectWorkspace } from './workspace.mjs'
import { readSetting } from './settings.mjs'
import { SESSION_TAG } from './spec-format.mjs'
import { SkillPackageError } from './errors.mjs'
import { saveUsageReports, usageReportCompletion } from './usage-report.mjs'

const hash = (value) => createHash('sha256').update(value).digest('hex')
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const FIELDS = { input: 'input_tokens', output: 'output_tokens', cacheRead: 'cache_read_input_tokens', cacheWrite: 'cache_creation_input_tokens' }
const LIMITS = { files: 256, bytes: 128 * 1024 * 1024, lineBytes: 4 * 1024 * 1024, entries: 2048, depth: 6 }
const numeric = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null
const fail = (message) => { throw new SkillPackageError(message) }
const addIssue = (scan, issue) => { if (!scan.issues.includes(issue)) scan.issues.push(issue) }

async function directoryEntries(directory, scan) {
  try {
    if (!(await lstat(directory)).isDirectory()) { addIssue(scan, 'unsafe-or-missing-directory'); return [] }
    const entries = []
    const handle = await opendir(directory)
    for await (const entry of handle) {
      if (++scan.directoryEntries > scan.limits.entries) { addIssue(scan, 'directory-entry-limit'); break }
      entries.push(entry)
    }
    return entries.sort((a, b) => a.name.localeCompare(b.name))
  } catch (error) {
    if (error.code !== 'ENOENT') addIssue(scan, 'unreadable-directory')
    return []
  }
}

// Bounded streaming: even an oversized or unfinished JSONL record cannot grow memory without limit.
async function records(file, scan, consume) {
  if (++scan.files > scan.limits.files) { addIssue(scan, 'file-limit'); return }
  let handle
  try {
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const stat = await handle.stat()
    if (!stat.isFile()) { addIssue(scan, 'unsafe-log-file'); return }
    const buffer = Buffer.alloc(64 * 1024)
    let pending = Buffer.alloc(0), skipping = false, position = 0
    // Snapshot the file length; live writes belong to a later report.
    while (position < stat.size && scan.bytes < scan.limits.bytes) {
      const length = Math.min(buffer.length, stat.size - position, scan.limits.bytes - scan.bytes)
      const { bytesRead } = await handle.read(buffer, 0, length, position)
      if (!bytesRead) break
      position += bytesRead; scan.bytes += bytesRead
      let start = 0
      for (let index = 0; index < bytesRead; index++) {
        if (buffer[index] !== 10) continue
        const part = buffer.subarray(start, index)
        if (!skipping && pending.length + part.length <= scan.limits.lineBytes) {
          const line = Buffer.concat([pending, part]).toString('utf8')
          if (line.trim()) {
            try { consume(JSON.parse(line)) } catch { addIssue(scan, 'malformed-record') }
          }
        } else addIssue(scan, 'oversized-record')
        pending = Buffer.alloc(0); skipping = false; start = index + 1
      }
      const tail = buffer.subarray(start, bytesRead)
      if (!skipping && pending.length + tail.length <= scan.limits.lineBytes) pending = Buffer.concat([pending, tail])
      else { skipping = true; pending = Buffer.alloc(0); addIssue(scan, 'oversized-record') }
    }
    if (position < stat.size) addIssue(scan, 'byte-limit')
    if (pending.length || skipping) addIssue(scan, 'unfinished-record')
  } catch { addIssue(scan, 'unreadable-log') }
  finally { await handle?.close() }
}

const newScan = (limits) => ({ limits: { ...LIMITS, ...limits }, files: 0, bytes: 0, directoryEntries: 0, issues: [] })
const sameProject = (record, root) => typeof record.cwd === 'string' && path.resolve(record.cwd) === root
function markerCommand(record, marker) {
  if (record.type !== 'assistant' || !Array.isArray(record.message?.content)) return false
  return record.message.content.some((block) => {
    if (block?.type !== 'tool_use') return false
    const command = block.input?.command ?? block.input?.cmd
    return typeof command === 'string' && /\bvibe\s+usage\s+start\b/.test(command)
      && new RegExp(`(?:^|\\s)--marker(?:=|\\s+)["']?${marker}(?:["']?(?:\\s|$))`).test(command)
  })
}

async function rootLogs(projectDir, scan) {
  return (await directoryEntries(projectDir, scan)).filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl') && ID.test(entry.name.slice(0, -6)))
}

// A literal marker is found only in shell-tool attribution, never in quoted prompt/tool results.
// Inspect only this checkout's project directory; never choose a session by recency.
export async function resolveNativeSession({ projectDir, root, session, sessionKey, marker, limits }) {
  if (session) {
    if (!ID.test(session)) fail('--session에는 정확한 Claude 세션 ID가 필요합니다.')
    return { session, issues: [] }
  }
  if (!sessionKey && !/^[a-f0-9]{32}$/.test(marker ?? '')) fail('--session 또는 이번 명령에 직접 쓴 임의 32자리 16진수 --marker가 필요합니다.')
  const scan = newScan(limits), matches = new Set()
  for (const entry of await rootLogs(projectDir, scan)) {
    const id = entry.name.slice(0, -6)
    if (sessionKey) { if (hash(id) === sessionKey) matches.add(id); continue }
    if (scan.files >= scan.limits.files || scan.bytes >= scan.limits.bytes) { addIssue(scan, 'attribution-scan-limit'); break }
    await records(path.join(projectDir, entry.name), scan, (record) => {
      if (record.sessionId === id && sameProject(record, root) && !record.isSidechain && markerCommand(record, marker)) matches.add(id)
    })
  }
  // Incomplete search cannot establish marker uniqueness, even when one match was read.
  if (matches.size !== 1 || scan.issues.length) return { session: null, issues: [...scan.issues, matches.size > 1 ? 'ambiguous-session' : 'session-unavailable'] }
  return { session: [...matches][0], issues: [] }
}

async function childLogs(directory, scan, depth = 0) {
  if (depth > scan.limits.depth) { addIssue(scan, 'directory-depth-limit'); return [] }
  const files = []
  for (const entry of await directoryEntries(directory, scan)) {
    const file = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) { addIssue(scan, 'skipped-symlink'); continue }
    if (entry.isDirectory()) files.push(...await childLogs(file, scan, depth + 1))
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(file)
  }
  return files
}

// Only usage/identity metadata escapes this boundary. Raw content is discarded immediately.
export async function scanNativeUsage({ projectDir, root, session, limits }) {
  if (!ID.test(session ?? '')) fail('정확한 Claude 세션 ID가 필요합니다.')
  const scan = newScan(limits), messages = new Map(), sessions = new Set()
  const main = path.join(projectDir, `${session}.jsonl`)
  let children = []
  try {
    if (!(await lstat(projectDir)).isDirectory()) addIssue(scan, 'unsafe-project-directory')
    else {
      const sessionDirectory = path.join(projectDir, session)
      try {
        if ((await lstat(sessionDirectory)).isDirectory()) children = await childLogs(path.join(sessionDirectory, 'subagents'), scan)
        else addIssue(scan, 'unsafe-session-directory')
      } catch (error) { if (error.code !== 'ENOENT') addIssue(scan, 'unreadable-directory') }
    }
  } catch { addIssue(scan, 'project-unavailable') }
  const files = scan.issues.includes('unsafe-project-directory') || scan.issues.includes('project-unavailable') ? [] : [main, ...children]
  let attributed = false, duplicates = 0, excluded = 0, unidentified = 0, unattributedChildren = 0
  for (const file of files) {
    const child = file !== main
    const sessionAlias = hash(`${session}:${child ? path.relative(projectDir, file) : 'parent'}`)
    await records(file, scan, (record) => {
      if (!['user', 'assistant'].includes(record.type)) return
      if (child) {
        // The transcript's selected-session subtree and provider identities establish ownership.
        // Native workers may legitimately use another worktree cwd; do not drop their usage.
        if (!attributed || record.sessionId !== session || record.isSidechain !== true
          || typeof record.agentId !== 'string' || path.basename(file) !== `agent-${record.agentId}.jsonl`) {
          excluded++; unattributedChildren++; addIssue(scan, 'unproven-child-ownership'); return
        }
      } else if (record.sessionId !== session || !sameProject(record, root) || record.isSidechain) { excluded++; return }
      attributed = true; sessions.add(sessionAlias)
      if (record.type !== 'assistant') return
      if (typeof record.message?.id !== 'string' || !record.message.id) { unidentified++; addIssue(scan, 'missing-message-id'); return }
      const key = hash(`${session}:${record.message.id}`)
      const tokens = Object.fromEntries(Object.entries(FIELDS).map(([name, field]) => [name, numeric(record.message.usage?.[field])]))
      const previous = messages.get(key)
      if (previous) duplicates++
      const models = new Set(previous?.models ?? [])
      if (typeof record.message.model === 'string') models.add(record.message.model)
      messages.set(key, { key, session: previous?.session ?? sessionAlias, role: previous?.role ?? (child ? 'native-child' : 'orchestrator'), models: [...models],
        tokens: Object.fromEntries(Object.keys(FIELDS).map((name) => [name, previous?.tokens[name] == null ? tokens[name] : tokens[name] == null ? previous.tokens[name] : Math.max(previous.tokens[name], tokens[name])])) })
    })
  }
  if (!attributed) addIssue(scan, 'session-unavailable')
  return { messages: [...messages.values()], sessions: sessions.size, duplicates, excluded, unidentified, unattributedChildren, issues: scan.issues, scanComplete: !scan.issues.length, files: Math.min(scan.files, scan.limits.files), bytes: scan.bytes }
}

function deltaMessages(snapshot, baseline) {
  if (!baseline) return snapshot.messages
  const old = new Map(baseline.messages.map((message) => [message.key, message]))
  const result = []
  for (const message of snapshot.messages) {
    const previous = old.get(message.key)
    old.delete(message.key)
    if (previous && Object.keys(FIELDS).every((name) => previous.tokens[name] === message.tokens[name])) continue
    const tokens = Object.fromEntries(Object.keys(FIELDS).map((name) => {
      const before = previous?.tokens[name]
      const now = message.tokens[name]
      if (now === null || (previous && before === null) || (!previous && !baseline.scanComplete) || (before != null && now < before)) return [name, null]
      return [name, now - (before ?? 0)]
    }))
    result.push({ ...message, tokens })
  }
  if (old.size) snapshot.issues.push('baseline-messages-missing')
  if (!baseline.scanComplete) snapshot.issues.push('baseline-incomplete')
  return result
}

function totals(messages) {
  const allFields = [...Object.keys(FIELDS), 'processedInput']
  const rows = messages.map(({ tokens }) => ({ ...tokens, processedInput: ['input', 'cacheRead', 'cacheWrite'].every((name) => tokens[name] !== null) ? tokens.input + tokens.cacheRead + tokens.cacheWrite : null }))
  return Object.fromEntries(allFields.map((name) => [name, { known: rows.reduce((sum, row) => sum + (row[name] ?? 0), 0), reported: rows.filter((row) => row[name] !== null).length, expected: rows.length }]))
}

export function nativeUsageReport(snapshot, baseline = null) {
  const messages = deltaMessages(snapshot, baseline), tokens = totals(messages)
  const participating = new Set(messages.map((message) => message.key))
  const knownInput = snapshot.messages.filter((message) => participating.has(message.key)).map(({ tokens: row }) => ['input', 'cacheRead', 'cacheWrite'].every((name) => row[name] !== null) ? row.input + row.cacheRead + row.cacheWrite : null).filter((value) => value !== null)
  const modelNames = [...new Set(messages.flatMap((message) => message.models.length ? message.models : ['unknown']))].sort()
  const issues = [...new Set(snapshot.issues)]
  const missing = Object.values(tokens).some((entry) => entry.reported < entry.expected)
  const unavailable = issues.includes('session-unavailable') || issues.includes('baseline-unavailable')
  if (unavailable && !messages.length) for (const field of Object.values(tokens)) field.known = null
  return { schemaVersion: 1, scope: 'native-claude-recorded-logs', boundary: baseline ? 'baseline-delta' : 'entire-recorded-session',
    status: unavailable ? 'missing' : issues.length || missing ? 'partial' : 'recorded',
    tokens, messages: messages.length, sessions: { orchestrator: snapshot.sessions > 0 ? 1 : 0, nativeChildren: new Set(messages.filter((message) => message.role === 'native-child').map((message) => message.session)).size, unobserved: 'unknown' },
    models: modelNames.map((model) => { const matching = messages.filter((message) => message.models.includes(model) || (!message.models.length && model === 'unknown')); return { model, messages: matching.length, tokens: totals(matching) } }),
    observedMaxProcessedInput: knownInput.length ? knownInput.reduce((maximum, value) => Math.max(maximum, value), 0) : null,
    cacheReadShare: tokens.processedInput.expected > 0 && tokens.processedInput.reported === tokens.processedInput.expected && tokens.processedInput.known > 0 ? tokens.cacheRead.known / tokens.processedInput.known : null,
    coverage: { logScanComplete: snapshot.scanComplete, baselineComplete: baseline?.scanComplete ?? null, duplicateSnapshots: snapshot.duplicates, excludedRecords: snapshot.excluded, unidentifiedMessages: snapshot.unidentified, unattributedChildRecords: snapshot.unattributedChildren ?? 0, issues },
    limits: 'Recorded log snapshot through report invocation; parent attribution requires this checkout. Proven native children within the selected session subtree include worktree contexts. Later final reply, unrelated sessions and CLI adapter invocations are outside this scope. Unrecorded usage is unknown. Native and adapter totals must not be added.' }
}

export function nativeUsageSummary(report) {
  const token = (name) => { const field = report.tokens[name]; return !field.expected && report.status !== 'recorded' ? 'unknown' : `${field.known}${field.reported < field.expected ? '+unknown' : ''}` }
  return `Native Claude recorded logs (${report.boundary}, ${report.status}): sessions ${report.sessions.orchestrator}+${report.sessions.nativeChildren} native children, messages ${report.messages}; models ${report.models.map((entry) => entry.model).join(', ') || 'unknown'}; input ${token('input')}, output ${token('output')}, cache-read ${token('cacheRead')}, cache-creation ${token('cacheWrite')}; max observed processed input ${report.observedMaxProcessedInput ?? 'unknown'}, cache-read share ${report.cacheReadShare === null ? 'unknown' : `${(report.cacheReadShare * 100).toFixed(1)}%`}; coverage ${report.coverage.issues.join(', ') || 'recorded snapshot only'}, unobserved sessions unknown. Excludes later final reply and separate adapter totals.`
}

async function atomicJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  await rename(temporary, file)
}

// Public command boundary: opt-out returns before inspecting logs or creating any artifact.
export async function vibeUsage(options = {}, injected = {}) {
  const enabled = await (injected.readSetting ?? readSetting)(options, 'usage-measurement')
  if (!enabled) return { schemaVersion: 1, ok: true, enabled: false }
  const step = options.step ?? 'report'
  if (!['start', 'report'].includes(step)) fail('vibe usage <start|report> --tag <tag> [--session <id>|--marker <literal>]')
  if ((step === 'start' || !options.session) && !SESSION_TAG.test(options.tag ?? '')) fail('--tag에는 영숫자 2-8자의 세션 tag가 필요합니다.')
  if (options.tag !== undefined && !SESSION_TAG.test(options.tag)) fail('--tag에는 영숫자 2-8자의 세션 tag가 필요합니다.')
  if (options.session && options.marker) fail('--session과 --marker는 함께 쓰지 않습니다.')
  if (step === 'report' && (options.marker || (options.session && options.tag))) fail('vibe usage report에는 --tag 또는 --session 하나만 씁니다.')
  const workspace = await (injected.inspectWorkspace ?? inspectWorkspace)(options)
  if (!workspace.git) fail('로컬 사용량 보고서에는 Git checkout이 필요합니다.')
  const root = workspace.git.root
  const runtime = path.join(workspace.git.commonDir, 'gusta', 'v1', 'native-usage')
  const lockFile = path.join(runtime, `${options.tag ?? hash(options.session).slice(0, 8)}.lock`)
  let lock
  try {
    await mkdir(runtime, { recursive: true })
    lock = await open(lockFile, 'wx', 0o600)
  } catch {
    const summary = 'Native Claude measurement unavailable: local runtime is unwritable or this measurement is locked.'
    return { schemaVersion: 1, ok: true, enabled: true, status: 'missing', started: false, artifact: null,
      summary, ...usageReportCompletion(null, summary, null, ['runtime-unavailable']), guidance: 'Continue the task and report missing measurement; use a unique tag when another invocation owns this tag.' }
  }
  try { return await measureNativeUsage(options, injected, { root, runtime, step }) }
  finally { await lock.close(); await rm(lockFile, { force: true }) }
}

async function measureNativeUsage(options, injected, { root, runtime, step }) {
  const baselineFile = options.tag ? path.join(runtime, `${options.tag}.baseline.json`) : null
  let baseline = null
  const baselineIssues = []
  if (step === 'report' && !options.session) {
    try { baseline = JSON.parse(await readFile(baselineFile, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') baselineIssues.push('baseline-unreadable') }
    if (baseline && (baseline.schemaVersion !== 1 || baseline.project !== hash(root) || !/^[a-f0-9]{64}$/.test(baseline.sessionKey ?? '') || !Array.isArray(baseline.messages)
      || baseline.messages.some((message) => !message?.key || !message.tokens || Object.keys(FIELDS).some((field) => message.tokens[field] !== null && numeric(message.tokens[field]) === null)))) { baseline = null; baselineIssues.push('baseline-invalid') }
  }
  const projectDir = path.resolve(options.projectDir ?? path.join(options.env?.CLAUDE_CONFIG_DIR ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'), 'projects', root.replace(/[^A-Za-z0-9]/g, '-')))
  const resolved = baseline || step === 'start' || options.session
    ? await (injected.resolveNativeSession ?? resolveNativeSession)({ projectDir, root, session: options.session, sessionKey: baseline?.sessionKey, marker: options.marker, limits: injected.limits })
    : { session: null, issues: ['baseline-unavailable', ...baselineIssues] }
  const snapshot = resolved.session ? await (injected.scanNativeUsage ?? scanNativeUsage)({ projectDir, root, session: resolved.session, limits: injected.limits })
    : { messages: [], sessions: 0, duplicates: 0, excluded: 0, unidentified: 0, issues: resolved.issues, scanComplete: false }
  const report = nativeUsageReport(snapshot, baseline)
  report.period = { startedAt: baseline?.startedAt ?? null, finishedAt: new Date((injected.now ?? Date.now)()).toISOString() }
  const result = { schemaVersion: 1, ok: true, enabled: true, status: report.status, summary: nativeUsageSummary(report) }
  if (step === 'start') {
    if (resolved.session && !snapshot.issues.includes('session-unavailable')) {
      const markerKey = options.marker ? hash(options.marker) : null
      let previous
      try { previous = JSON.parse(await readFile(baselineFile, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') fail('기존 네이티브 사용량 기준선을 읽을 수 없습니다.') }
      if (!previous?.finishedAt && previous?.markerKey === markerKey && previous?.sessionKey === hash(resolved.session) && previous?.project === hash(root)) {
        return { ...result, summary: 'Native Claude baseline preserved for the same invocation marker.', started: true, reused: true, baseline: baselineFile }
      }
      if (previous && !previous.finishedAt) return { ...result, status: 'missing', started: false, summary: 'Native Claude baseline unavailable: this tag already has another unfinished measurement.', guidance: 'Finish the original report or use a new unique --tag. The existing baseline was preserved.' }
      try {
        await atomicJson(baselineFile, { schemaVersion: 1, project: hash(root), sessionKey: hash(resolved.session), markerKey, startedAt: new Date().toISOString(), messages: snapshot.messages, scanComplete: snapshot.scanComplete })
      } catch { return { ...result, status: 'missing', started: false, summary: 'Native Claude baseline unavailable: local runtime write failed.', guidance: 'Continue the task and report missing measurement; no run baseline was recorded.' } }
      return { ...result, summary: `Native Claude baseline recorded (${report.status}); report with vibe usage report --tag ${options.tag}.`, started: true, baseline: baselineFile }
    }
    return { ...result, started: false, guidance: 'Retry the same literal marker once after the tool-call log is flushed. Or use --session <exact-id>; never choose the latest session. No run baseline was recorded.' }
  }
  const stem = path.join(runtime, `${options.tag ?? hash(options.session).slice(0, 8)}.report`)
  const { jsonFile: artifact, ...completion } = await saveUsageReports(report, result.summary, `${stem}.json`, `${stem}.md`, injected)
  if (baseline && !completion.reportErrors.length) {
    try { await atomicJson(baselineFile, { ...baseline, finishedAt: report.period.finishedAt }) }
    catch { Object.assign(completion, usageReportCompletion(report, result.summary, completion.reportFile, ['baseline-close-failed'])) }
  }
  return { ...result, artifact, report, ...completion,
    ...(completion.reportErrors.length ? { guidance: 'Continue the task; report persistence was incomplete. Relay chatSummary and reportErrors to the user.' }
      : !resolved.session ? { guidance: 'Use vibe usage start --tag <tag> --session <exact-id> before work. vibe usage report --session <exact-id> reports entire recorded history, without a run baseline.' } : {}) }
}
