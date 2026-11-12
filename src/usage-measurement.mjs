import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { saveUsageReports } from './usage-report.mjs'

const FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite', 'processedInput']
const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null
const blank = () => Object.fromEntries(FIELDS.map((key) => [key, null]))
const add = (values) => values.length && values.every((value) => value !== null) ? values.reduce((a, b) => a + b, 0) : null
const tokens = (usage, provider) => {
  if (!usage || typeof usage !== 'object') return blank()
  const input = count(usage.input_tokens), output = count(usage.output_tokens)
  const read = count(provider === 'codex' ? usage.cached_input_tokens : usage.cache_read_input_tokens)
  const cacheRead = provider === 'codex' && input !== null && read > input ? null : read
  const cacheWrite = count(provider === 'codex' ? usage.cache_write_input_tokens : usage.cache_creation_input_tokens)
  return provider === 'codex'
    ? { input: input !== null && cacheRead !== null && cacheRead <= input ? input - cacheRead : null, output, cacheRead, cacheWrite, processedInput: input }
    : { input, output, cacheRead, cacheWrite, processedInput: add([input, cacheRead, cacheWrite]) }
}
const merge = (entries) => Object.fromEntries(FIELDS.map((key) => {
  const values = entries.map((entry) => entry[key]).filter((value) => value !== null)
  return [key, values.length ? values.reduce((a, b) => a + b, 0) : null]
}))

// A bounded stream observer; no transcript or content field is retained. Disabled adapters
// never instantiate it. Terminal totals replace message/cumulative snapshots, never add to them.
export function usageCollector(provider, model = null) {
  let partial = '', malformed = false, terminal = null, cumulative = null, lastTurn = null
  let completed = false, streamEnded = false
  const messages = new Map(), models = new Set()
  let terminalTurn = null
  const observe = (line) => {
    if (!line.trim()) return
    let event
    try { event = JSON.parse(line) } catch { malformed = true; return }
    if (!event || typeof event !== 'object') { malformed = true; return }
    if (event.parent_tool_use_id) return
    if (typeof event.model === 'string') models.add(event.model)
    if (provider === 'claude') {
      if (typeof event.message?.model === 'string') models.add(event.message.model)
      if (event.type === 'result' || (event.type === undefined && event.usage)) {
        terminal = event
        if (event.subtype !== undefined && typeof event.subtype !== 'string') malformed = true
        completed = !event.is_error && !(typeof event.subtype === 'string' && event.subtype.startsWith('error'))
      } else if (event.type === 'assistant' && event.message?.usage && typeof event.message.id === 'string') {
        const snapshot = tokens(event.message.usage, provider), previous = messages.get(event.message.id)
        messages.set(event.message.id, previous ? Object.fromEntries(FIELDS.map((key) => [key, snapshot[key] === null ? previous[key] : previous[key] === null ? snapshot[key] : Math.max(previous[key], snapshot[key])])) : snapshot)
      }
      return
    }
    if (event.type === 'turn.completed' && event.usage) {
      terminalTurn = tokens(event.usage, provider)
      completed = true
    }
    if (event.type === 'turn.failed' || event.type === 'error') { completed = false; malformed = true }
    if (event.type === 'event_msg' && event.payload?.type === 'token_count') {
      const info = event.payload.info
      if (info?.total_token_usage) cumulative = tokens(info.total_token_usage, provider)
      if (info?.last_token_usage) lastTurn = tokens(info.last_token_usage, provider)
    }
  }
  return {
    push(chunk) {
      const lines = (partial + chunk).split('\n')
      partial = lines.pop()
      for (const line of lines) observe(line)
      if (partial.length > 8 * 1024 * 1024) { partial = ''; malformed = true }
    },
    finish({ ok = false, resumed = false } = {}) {
      if (!streamEnded) { observe(partial); partial = ''; streamEnded = true }
      const zeroedCrash = terminal?.subtype === 'error_during_execution' && terminal.usage && Object.values(tokens(terminal.usage, provider)).every((value) => value === null || value === 0)
      const hasTerminalUsage = terminal?.usage && !zeroedCrash
      const source = provider === 'claude' ? hasTerminalUsage ? 'result.usage' : messages.size ? 'assistant.usage' : 'missing'
        : terminalTurn ? 'turn.completed' : cumulative ? 'token_count.total' : lastTurn ? 'token_count.last' : 'missing'
      let measured = provider === 'claude' ? hasTerminalUsage ? tokens(terminal.usage, provider) : messages.size ? { ...merge([...messages.values()]), output: null } : blank()
        : terminalTurn ?? cumulative ?? lastTurn ?? blank()
      const recoverInput = provider === 'claude' && terminal && !completed && messages.size
      if (recoverInput) {
        const observed = merge([...messages.values()])
        for (const key of ['input', 'cacheRead', 'cacheWrite']) measured[key] = measured[key] === null ? observed[key] : observed[key] === null ? measured[key] : Math.max(measured[key], observed[key])
        measured.processedInput = add([measured.input, measured.cacheRead, measured.cacheWrite])
      }
      // Cumulative resumed counters have an unknown starting baseline. Preserve that limitation
      // without treating all prior turns as usage of this invocation.
      const cumulativeTokens = provider === 'codex' && ['turn.completed', 'token_count.total'].includes(source) ? measured : null
      if (resumed && cumulativeTokens) measured = blank()
      const reported = terminal?.total_cost_usd
      const reportedUsd = typeof reported === 'number' && Number.isFinite(reported) && reported >= 0 ? reported : null
      const known = FIELDS.some((key) => measured[key] !== null)
      const peaks = [...messages.values()].map((message) => message.processedInput).filter((value) => value !== null)
      return { tokens: measured, source, models: [...models], status: !known ? 'missing' : ok && completed && !malformed && !['assistant.usage', 'token_count.total', 'token_count.last'].includes(source) ? 'complete' : 'partial',
        requests: { observed: messages.size || null, peakProcessedInput: peaks.length ? Math.max(...peaks) : null, scope: 'observed main-loop assistant message IDs; not inferred from totals' },
        reportedUsd, usdScope: reportedUsd === null ? 'unreported' : resumed ? 'session-cumulative-unknown-baseline' : 'provider-reported',
        tokenScope: provider === 'claude' ? 'main-loop' : cumulativeTokens ? 'session-cumulative' : 'last-provider-turn', malformed, streamComplete: ok && completed && !malformed,
        ...(cumulativeTokens ? { cumulativeTokens } : {}),
        ...(source === 'assistant.usage' ? { limitation: 'streamed output tokens are placeholders; terminal output total unavailable' } : {}),
        ...(recoverInput && hasTerminalUsage ? { limitation: 'error totals may omit a response; input/cache retain maximum available terminal or deduplicated assistant evidence' } : {}),
        ...(resumed && cumulativeTokens ? { limitation: 'resumed cumulative tokens need a same-run session baseline' } : {}) }
    },
  }
}

export function usageRun(enabled, runtime, id) {
  if (!enabled) return null
  id ??= randomUUID()
  return { directory: path.join(runtime, 'usage', id), id, startedAt: new Date().toISOString() }
}

export async function persistUsage(run, measurement, { provider, model, job, session, invocation = randomUUID() }, injected = {}) {
  const deps = { mkdir, writeFile, readdir, readFile, ...injected }
  const alias = createHash('sha256').update(`${run.id}\0${provider}\0${session ?? invocation}`).digest('hex').slice(0, 16)
  let previous = null, sessionSequence = 0
  if (measurement.cumulativeTokens) {
    const files = await deps.readdir(run.directory).catch((error) => { if (error.code === 'ENOENT') return []; throw error })
    for (const file of files.filter((file) => file.endsWith('.json') && file !== 'run.json')) {
      let entry
      try { entry = JSON.parse(await deps.readFile(path.join(run.directory, file), 'utf8')) } catch { continue }
      if (entry.session === alias && entry.cumulativeTokens && entry.sessionSequence >= sessionSequence) { previous = entry; sessionSequence = entry.sessionSequence }
    }
    if (job.resume && previous) {
      const delta = Object.fromEntries(FIELDS.map((key) => {
        const current = measurement.cumulativeTokens[key], baseline = previous.cumulativeTokens[key]
        return [key, current !== null && baseline !== null && current >= baseline ? current - baseline : null]
      }))
      if (delta.cacheRead !== null && delta.processedInput !== null && delta.cacheRead > delta.processedInput) { delta.cacheRead = null; delta.input = null }
      measurement = { ...measurement, tokens: delta, status: measurement.streamComplete ? 'complete' : 'partial', limitation: 'session-cumulative counters minus previous same-run snapshot; reset/unreported fields unknown' }
    }
  }
  const record = { schemaVersion: 1, invocation, session: alias, provider, requestedModel: model ?? null,
    role: job.role, ...(job.taskId ? { task: job.taskId } : {}), ...(job.unit !== undefined ? { unit: job.unit } : {}),
    ...measurement, ...(measurement.cumulativeTokens ? { sessionSequence: sessionSequence + 1 } : {}) }
  await deps.mkdir(run.directory, { recursive: true })
  await deps.writeFile(path.join(run.directory, `${invocation}.json`), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
  return record
}

export function aggregateUsage(records, expectedInvocations) {
  const unique = [...new Map(records.map((record) => [record.invocation, record])).values()]
  expectedInvocations = Math.max(expectedInvocations ?? unique.length, unique.length)
  const totals = Object.fromEntries(FIELDS.map((key) => {
    const values = unique.map((record) => record.tokens[key]).filter((value) => value !== null)
    return [key, { known: values.length ? values.reduce((a, b) => a + b, 0) : null, reported: values.length, expected: expectedInvocations }]
  }))
  const groups = new Map()
  for (const record of unique) {
    const model = record.models.join(' + ') || (record.requestedModel ? `requested:${record.requestedModel} (actual unknown)` : 'unknown')
    const key = `${record.provider}/${model}`
    const group = groups.get(key) ?? { provider: record.provider, model, records: [] }
    group.records.push(record); groups.set(key, group)
  }
  const sessions = new Set(unique.map((record) => record.session)).size
  const requestCounts = unique.map((record) => record.requests?.observed).filter((value) => count(value) !== null)
  const peaks = unique.map((record) => record.requests?.peakProcessedInput).filter((value) => count(value) !== null)
  const cost = unique.filter((record) => record.usdScope === 'provider-reported')
  const completeInput = totals.processedInput.reported === expectedInvocations && totals.cacheRead.reported === expectedInvocations && unique.every((record) => record.status === 'complete')
  return { schemaVersion: 1, scope: 'CLI shared adapter only; excludes host/native sessions, custom adapters and preflight probes',
    invocations: expectedInvocations, recordedInvocations: unique.length, missingInvocations: Math.max(0, expectedInvocations - unique.length), sessions,
    status: unique.length === expectedInvocations && unique.every((record) => record.status === 'complete' && FIELDS.every((key) => record.tokens[key] !== null)) ? 'complete' : 'partial', totals,
    requests: { observed: requestCounts.length ? requestCounts.reduce((a, b) => a + b, 0) : null, reportedInvocations: requestCounts.length,
      peakProcessedInput: peaks.length ? Math.max(...peaks) : null, scope: 'observed main-loop assistant messages only; unavailable for unsupported streams' },
    sessionBreakdown: [...new Set(unique.map((record) => record.session))].map((session) => {
      const entries = unique.filter((record) => record.session === session)
      return { session, provider: entries[0].provider, invocations: entries.length, roles: [...new Set(entries.map((entry) => entry.role))],
        totals: Object.fromEntries(FIELDS.map((key) => {
          const values = entries.map((entry) => entry.tokens[key]).filter((value) => value !== null)
          return [key, { known: values.length ? values.reduce((a, b) => a + b, 0) : null, reported: values.length, expected: entries.length }]
        })) }
    }),
    cacheReadShare: completeInput && totals.processedInput.known > 0 ? totals.cacheRead.known / totals.processedInput.known : null,
    reportedUsd: { known: cost.length ? cost.reduce((sum, record) => sum + record.reportedUsd, 0) : null, reported: cost.length, expected: expectedInvocations, excludesCumulativeWithoutBaseline: unique.filter((record) => record.usdScope === 'session-cumulative-unknown-baseline').length },
    models: [...groups.values()].map(({ records: entries, ...group }) => ({ ...group, invocations: entries.length, sessions: new Set(entries.map((record) => record.session)).size,
      totals: Object.fromEntries(FIELDS.map((key) => [key, { known: entries.some((entry) => entry.tokens[key] !== null) ? entries.reduce((sum, entry) => sum + (entry.tokens[key] ?? 0), 0) : null,
        reported: entries.filter((entry) => entry.tokens[key] !== null).length, expected: entries.length }])) })),
    caveat: 'Cache hits do not prove savings; controlled baseline required. Provider USD is not subscription quota.' }
}

export function usageSummary(report) {
  const value = (key) => {
    const field = report.totals[key]
    return field.known === null ? 'unknown' : `${field.known}${field.reported < field.expected ? ` (${field.reported}/${field.expected} reported)` : ''}`
  }
  return `Usage (${report.status}, CLI adapter only): ${report.sessions} sessions / ${report.recordedInvocations}/${report.invocations} invocations; processed input ${value('processedInput')}, output ${value('output')}, cache read ${value('cacheRead')}, cache creation ${value('cacheWrite')}; cache read / processed input ${report.cacheReadShare === null ? 'unknown' : `${(report.cacheReadShare * 100).toFixed(1)}%`}; USD ${report.reportedUsd.known === null ? 'unknown' : `${report.reportedUsd.known} (${report.reportedUsd.reported}/${report.invocations} reported)`}. Models: ${report.models.map((model) => `${model.provider}/${model.model} ${model.sessions}`).join(', ') || 'unknown'}. Host/native excluded; no savings or quota inference.`
}

export async function finishUsageRun(run, expectedInvocations, injected = {}) {
  if (!run) return undefined
  const deps = { readdir, readFile, now: Date.now, report: (line) => process.stderr.write(`${line}\n`), ...injected }
  const coverageIssues = []
  const files = await deps.readdir(run.directory).catch((error) => { if (error.code !== 'ENOENT') coverageIssues.push('unreadable-record-directory'); return [] })
  const records = []
  for (const file of files.filter((file) => file.endsWith('.json') && file !== 'run.json')) {
    try {
      const record = JSON.parse(await deps.readFile(path.join(run.directory, file), 'utf8'))
      if (record.schemaVersion === 1 && typeof record.invocation === 'string' && typeof record.session === 'string' && Array.isArray(record.models) && record.tokens && FIELDS.every((key) => record.tokens[key] === null || count(record.tokens[key]) !== null)) records.push(record)
      else coverageIssues.push('invalid-record')
    } catch { coverageIssues.push('unreadable-record') }
  }
  const result = aggregateUsage(records, expectedInvocations ?? records.length)
  if (coverageIssues.length) result.status = 'partial'
  result.coverageIssues = [...new Set(coverageIssues)]
  result.period = { startedAt: run.startedAt ?? null, finishedAt: new Date(deps.now()).toISOString() }
  const summary = usageSummary(result)
  const { jsonFile: report, ...completion } = await saveUsageReports(result, summary, path.join(run.directory, 'run.json'), path.join(run.directory, 'report.md'), injected)
  deps.report(`${summary}\n${completion.reportLink ?? 'Human-readable usage report unavailable.'}${completion.reportErrors.length ? ` (${completion.reportErrors.join(', ')})` : ''}`)
  return { ...result, summary, report, ...completion }
}
