import { mkdir, writeFile, rename, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

const labels = { input: 'Input (excluding cache read)', output: 'Output', cacheRead: 'Cache read', cacheWrite: 'Cache creation/write', processedInput: 'Processed input' }
const cell = (value) => String(value).replace(/[\r\n]+/g, ' ').replace(/\|/g, '\\|').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const value = (field, unknownEmpty = false) => !field || field.known === null || (field.expected > 0 && !field.reported) || (unknownEmpty && !field.expected) ? 'unknown'
  : `${field.known}${field.reported < field.expected ? ' + unknown' : ''}`
const native = (report) => report.scope === 'native-claude-recorded-logs'

export function usageReportMarkdown(report, summary) {
  const isNative = native(report), fields = isNative ? report.tokens : report.totals
  const unknownEmpty = isNative && report.status !== 'recorded'
  const period = report.period ?? {}, coverage = isNative ? report.coverage.issues : report.coverageIssues ?? []
  const lines = ['# Usage report', '', `- Status: ${report.status}`, `- Scope: ${cell(report.scope)}`,
    `- Period: ${period.startedAt ?? 'unknown'} to ${period.finishedAt ?? 'unknown'} (report snapshot)`,
    `- Baseline: ${isNative ? `${report.boundary}; complete: ${report.coverage.baselineComplete ?? 'unknown'}` : 'per-invocation counters; resumed cumulative counters require a previous same-run snapshot'}`,
    `- Sessions: ${isNative ? `${report.sessions.orchestrator} orchestrator + ${report.sessions.nativeChildren} native children; unobserved unknown` : report.sessions}`,
    `- Observations: ${isNative ? `${report.messages} messages` : `${report.recordedInvocations}/${report.invocations} invocations; ${report.missingInvocations} missing`}`,
    '', '| Counter | Known tokens | Reported / expected observations |', '| --- | ---: | ---: |']
  for (const [key, label] of Object.entries(labels)) lines.push(`| ${label} | ${value(fields[key], unknownEmpty)} | ${fields[key].reported} / ${fields[key].expected} |`)
  const usd = isNative ? null : report.reportedUsd
  lines.push('', `- USD: ${usd ? `${value(usd)} (${usd.reported}/${usd.expected} invocations reported); ${usd.excludesCumulativeWithoutBaseline} cumulative amounts excluded without a baseline` : 'unknown (native logs do not report run cost)'}`,
    '- USD values are provider-reported estimates when available, not invoiced cost or subscription quota. No price, savings or quota estimate is inferred.',
    `- Cache read / processed input: ${report.cacheReadShare === null ? 'unknown' : `${(report.cacheReadShare * 100).toFixed(1)}%`}`,
    `- Coverage: ${coverage.length ? coverage.map(cell).join(', ') : 'recorded observations only; unrecorded usage unknown'}`,
    '', '## Models', '', '| Provider/model | Observations | Input | Output | Cache read | Cache creation/write |', '| --- | ---: | ---: | ---: | ---: | ---: |')
  for (const model of report.models) {
    const fields = isNative ? model.tokens : model.totals
    lines.push(`| ${cell(isNative ? `claude/${model.model}` : `${model.provider}/${model.model}`)} | ${model.messages ?? model.invocations} | ${['input', 'output', 'cacheRead', 'cacheWrite'].map((key) => value(fields[key], unknownEmpty)).join(' | ')} |`)
  }
  if (!report.models.length) lines.push('| unknown | 0 | unknown | unknown | unknown | unknown |')
  lines.push('', '## Limits', '', isNative ? report.limits : report.caveat,
    'Native and CLI adapter scopes are separate and must not be added. Missing or unsupported counters are unknown, not zero.', '', cell(summary), '')
  return lines.join('\n')
}

export function usageReportCompletion(report, summary, reportFile, reportErrors = []) {
  const reportLink = reportFile ? `[Usage report](<${reportFile.replace(/</g, '%3C').replace(/>/g, '%3E')}>)` : null
  const fields = report && (native(report) ? report.tokens : report.totals)
  const unknownEmpty = report && native(report) && report.status !== 'recorded'
  const brief = fields ? `Usage (${report.status}, ${native(report) ? 'native Claude' : 'CLI adapter'}): input ${value(fields.input, unknownEmpty)}, output ${value(fields.output, unknownEmpty)}, cache read ${value(fields.cacheRead, unknownEmpty)}, cache creation/write ${value(fields.cacheWrite, unknownEmpty)}.` : summary
  return { reportFile, reportLink, reportStatus: reportErrors.length ? reportFile ? 'partial' : 'unavailable' : 'saved', reportErrors,
    chatSummary: `${brief} ${reportLink ?? 'Human-readable usage report unavailable.'}${reportErrors.length && reportFile ? ' Report persistence was incomplete.' : ''}` }
}

async function atomicText(file, text, deps) {
  await deps.mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    await deps.writeFile(temporary, text, { mode: 0o600, flag: 'wx' })
    await deps.rename(temporary, file)
  } finally { await deps.rm(temporary, { force: true }).catch(() => {}) }
}

// Saving a report must never replace the task outcome with a measurement I/O error.
export async function saveUsageReports(report, summary, jsonFile, markdownFile, injected = {}) {
  const deps = { mkdir, writeFile, rename, rm, ...injected }, errors = []
  let savedJson = null, savedMarkdown = null
  try { await atomicText(jsonFile, `${JSON.stringify({ ...report, summary }, null, 2)}\n`, deps); savedJson = jsonFile }
  catch { errors.push('json-write-failed') }
  try { await atomicText(markdownFile, usageReportMarkdown(report, summary), deps); savedMarkdown = markdownFile }
  catch { errors.push('markdown-write-failed') }
  return { jsonFile: savedJson, ...usageReportCompletion(report, summary, savedMarkdown, errors) }
}
