// Where a loop's wall-clock went, so the next speed-up is chosen from numbers instead of
// guesses. Pure: the loop passes its dispatch and batch records, nothing is read here.
// Task checks count only when they ran through `vibe check`; other commands inside a
// unit are part of its model time.
const KIND = { task: 'implementation', fix: 'implementation', planning: 'planning', inbox: 'inbox', none: 'none' }
const sum = (values) => values.reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0)

export function timeBreakdown({ dispatches = [], batches = [], totalMs = 0 }) {
  const units = {}
  for (const unit of dispatches) {
    const group = units[unit.result ? KIND[unit.result.kind] ?? unit.result.kind : 'failed'] ??= { units: 0, ms: 0, checkMs: 0, modelMs: 0 }
    group.units++
    group.ms += unit.ms ?? 0
    group.checkMs += unit.checks?.ms ?? 0
    group.modelMs = Math.max(0, group.ms - group.checkMs)
  }
  const gateMs = sum(batches.filter((entry) => !entry.ci).map((entry) => entry.ms))
  const ciMs = sum(batches.filter((entry) => entry.ci).map((entry) => entry.ci.ms))
  const unitMs = sum(Object.values(units).map((group) => group.ms))
  const used = dispatches.map((unit) => unit.usage).filter(Boolean)
  const tokens = used.length ? Object.fromEntries(['input', 'cacheWrite', 'cacheRead', 'output'].map((key) => [key, sum(used.map((usage) => usage[key]))])) : null
  const slowest = dispatches.filter((unit) => unit.result && unit.ms).sort((a, b) => b.ms - a.ms).slice(0, 3)
    .map((unit) => ({ unit: unit.unit, kind: unit.result.kind, id: unit.result.id, ms: unit.ms, checkMs: unit.checks?.ms ?? 0 }))
  return { totalMs, units, gateMs, ciMs, hostMs: Math.max(0, totalMs - unitMs - gateMs - ciMs), slowest, tokens }
}

export function duration(ms) {
  const minutes = Math.round((ms ?? 0) / 60000)
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m` : `${minutes}m`
}

// One report line under ## checks: totals first, then the slowest unit to look at.
export function timeLine(time) {
  const parts = Object.entries(time.units).map(([kind, group]) => `${kind} ${duration(group.ms)}/${group.units}${group.checkMs ? ` (model ${duration(group.modelMs)}, task checks ${duration(group.checkMs)})` : ''}`)
  parts.push(`gate ${duration(time.gateMs)}`, `CI ${duration(time.ciMs)}`, `host ${duration(time.hostMs)}`)
  const slow = time.slowest[0]
  return `- time: ${duration(time.totalMs)} — ${parts.join(', ')}${slow ? `; slowest ${slow.id || slow.kind} ${duration(slow.ms)}` : ''}`
}
