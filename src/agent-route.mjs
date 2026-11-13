import { parseRun } from './spec-format.mjs'
import { capability, costOrder, familyTier, modelFamily } from './agent-catalog.mjs'
import { AGENT_TOOLS } from './settings.mjs'

// Which tool·model·effort a headless session runs on. The CLI decides it from the task's `run:`
// (planned with `gusta agents`) and SETTINGS `agents`, never the model of the session that starts it.
// Order: explicit --provider/--model/--effort > the task's run: > the default. No model call, no I/O:
// the caller hands in the catalog (agentCatalog) or null when it did not read one (then the explicit
// pin or the task's run: is taken as written).
export const ROUTE_ROLES = ['worker', 'reviewer', 'probe', 'variant', 'scout']
export const runLabel = (route) => route?.tool ? `${route.tool}${route.model ? `/${route.model}` : ''}${route.effort ? `@${route.effort}` : ''}` : '-'
// What a report shows: the combination that ran, after the recommendation when they differ.
export const routeLabel = (route) => route?.recommended && route.recommended !== runLabel(route) ? `${route.recommended} → ${runLabel(route)}` : runLabel(route)
// A session with no run: runs the first allowed tool at its own setting (the model and effort its user
// configured). Its fallbacks after the other tools' own settings sit nearest this score: the balanced
// family (tier 2) at high effort, the middle of both scales, so a limit hands over to a mid combination.
export const DEFAULT_SCORE = capability(2, 'high')

const scoreOf = ({ tool, model, effort }) => tool && model && effort ? capability(familyTier(tool, model).tier, effort) : null
const costOf = ({ tool, model, effort }) => costOrder(familyTier(tool, model).tier, effort)
const same = (a, b) => a.tool === b.tool && (a.model ?? null) === (b.model ?? null) && (a.effort ?? null) === (b.effort ?? null)
// A block names a tool, optionally one model family or one exact model·effort. A model-less option
// (the tool's own setting) may run any family, so every block on its tool covers it.
const matches = (pattern, option) => pattern.tool === option.tool && (!option.model || ((!pattern.model || pattern.model === option.model) &&
  (!pattern.effort || pattern.effort === option.effort) && (!pattern.family || modelFamily(option.tool, option.model) === pattern.family)))
// The lower median: the default sits mid-catalog and leans to the cheaper side of a tie.
const median = (scores) => scores.length ? [...scores].sort((a, b) => a - b)[Math.floor((scores.length - 1) / 2)] : null
const toolState = (entry) => !entry?.installed ? 'not-installed' : entry.loggedIn === false ? 'not-logged-in' : entry.status !== 'ok' ? 'unknown' : null
const named = (pattern) => Object.fromEntries(['tool', 'family', 'model', 'effort'].filter((key) => pattern[key]).map((key) => [key, pattern[key]]))

// role: worker (a loop unit or a work-group worker), reviewer, probe, variant, scout.
// recommended: the task's run: (string or parsed), recovery: a unit recovering that task (blocked,
// split, continuation, gate or CI repair) never drops below what it would get otherwise.
// agents: SETTINGS agents in fallback order; catalog: { tools, options } from agentCatalog or null.
// explicit: { tool, model, effort } the user pinned; blocked: [{ tool, family?, model?, effort?, reason? }]
// options this run must not take (a usage limit, a sign-in failure); worker: the reviewed worker's route.
// candidates: every usable option nearest first (chosen first) — the fallback order.
export function routeAgent({ role = 'worker', recommended = null, recovery = false, agents = null, catalog = null, explicit = {}, blocked = [], worker = null } = {}) {
  if (!ROUTE_ROLES.includes(role)) throw new Error(`unknown route role: ${role}`)
  const pin = { tool: explicit.tool ?? null, model: explicit.model ?? null, effort: explicit.effort ?? null }
  const pinned = Boolean(pin.tool || pin.model || pin.effort)
  const parsed = typeof recommended === 'string' ? parseRun(recommended) : recommended ?? null
  // A probe, a variant and a scout have no task: one default, so A/B variants stay comparable.
  const rec = ['worker', 'reviewer'].includes(role) ? parsed : null
  const label = rec ? runLabel(rec) : null
  const result = (chosen, source, candidates, skipped) => ({ role, chosen, source, recommended: label, score: chosen ? scoreOf(chosen) : null, candidates, skipped })
  const blockOf = (option) => blocked.find((pattern) => matches(pattern, option))
  const isBlocked = (option) => Boolean(blockOf(option))
  const withPin = (tool) => ({ tool, model: pin.model, effort: pin.effort })
  if (!catalog) {
    // Taken as written: the pin or the task's run:, then (unless a tool is pinned) the other allowed
    // tools at their own setting.
    const first = pin.tool ?? rec?.tool ?? null
    const own = rec?.tool === first ? rec : null
    const head = first ? [{ tool: first, model: pin.model ?? own?.model ?? null, effort: pin.effort ?? own?.effort ?? null }] : []
    const all = [...head, ...(pin.tool ? [] : (agents ?? []).filter((tool) => tool !== first).map(withPin))]
    if (!all.length) return result(null, 'none', [], [{ option: {}, reason: 'no-tool' }])
    const skipped = all.filter(isBlocked).map((option) => ({ option, reason: blockOf(option).reason ?? 'blocked' }))
    const candidates = all.filter((option) => !isBlocked(option)).map((option) => ({ ...option, score: scoreOf(option) }))
    if (!candidates.length) return result(null, 'none', [], skipped)
    const { score, ...chosen } = candidates[0]
    return result(chosen, pinned ? 'explicit' : own && same(chosen, head[0]) ? 'task' : rec ? 'nearest' : 'default', candidates, skipped)
  }
  const order = (tool) => agents?.includes(tool) ? agents.indexOf(tool) : AGENT_TOOLS.length
  const tools = new Map((catalog.tools ?? []).map((entry) => [entry.tool, entry]))
  const listed = (tool, model) => (tools.get(tool)?.models ?? []).find((entry) => entry.model === model && !entry.superseded)
  let scope = pin.tool ? [pin.tool] : [...(agents ?? [])]
  // A model pinned without its tool narrows the scope to the tools that list it.
  if (pin.model && !pin.tool && scope.some((tool) => listed(tool, pin.model))) scope = scope.filter((tool) => listed(tool, pin.model))
  const skipped = scope.filter((tool) => toolState(tools.get(tool))).map((tool) => ({ option: { tool }, reason: toolState(tools.get(tool)) }))
  const usable = (catalog.options ?? []).filter((option) => scope.includes(option.tool) && !toolState(tools.get(option.tool)))
  const ready = scope.filter((tool) => !toolState(tools.get(tool)))
  for (const pattern of blocked) if (usable.some((option) => matches(pattern, option)) || ready.some((tool) => matches(pattern, withPin(tool)))) skipped.push({ option: named(pattern), reason: pattern.reason ?? 'blocked' })
  const open = usable.filter((option) => !isBlocked(option))
  // The recommendation runs as written when its tool may run, is signed in and lists that model and effort.
  let available = null
  if (rec) {
    const model = listed(rec.tool, rec.model)
    const why = pin.tool && rec.tool !== pin.tool ? 'pinned-tool' : !pin.tool && !agents?.includes(rec.tool) ? 'not-in-agents'
      : toolState(tools.get(rec.tool)) ?? (!model ? 'model-unavailable' : !model.efforts.includes(rec.effort) ? 'effort-unsupported' : isBlocked(rec) ? 'blocked' : null)
    if (why) skipped.unshift({ option: rec, reason: why })
    else available = { ...rec, score: scoreOf(rec) }
  }
  const workerScore = role === 'reviewer' && worker ? worker.score ?? scoreOf(worker) : null
  const other = role === 'reviewer' && worker?.tool && scope.length > 1 ? (option) => option.tool !== worker.tool : () => false
  // No run: (and no worker capability to match): each ready tool at its own setting, in agents order
  // (a reviewer's other tool first), then explicit combinations nearest DEFAULT_SCORE for a limit
  // that blocks a family. The probe keeps its own rule below: the cheapest combination.
  const defaulted = !rec && role !== 'probe' && workerScore === null
  let target = defaulted ? DEFAULT_SCORE : rec ? scoreOf(rec) : median(usable.map((option) => option.score))
  let floor = -Infinity
  // A reviewer matches its worker's capability or more, on another tool first (an independent review).
  if (workerScore !== null) { target = workerScore; floor = workerScore }
  if (recovery && target !== null && !defaulted) floor = Math.max(floor, target)
  const preferRec = workerScore === null
  const meets = (option) => option.score >= floor
  const key = (option) => role === 'probe'
    ? [order(option.tool), option.cost, -option.score]
    : [meets(option) ? 0 : 1, other(option) ? 0 : 1, preferRec && available && same(option, available) ? 0 : 1,
        meets(option) ? Math.abs(option.score - (target ?? option.score)) : floor - option.score, option.cost, order(option.tool)]
  const compare = (a, b) => {
    const [x, y] = [key(a), key(b)]
    for (let index = 0; index < x.length; index++) if (x[index] !== y[index]) return x[index] - y[index]
    return a.tool.localeCompare(b.tool) || a.model.localeCompare(b.model)
  }
  // The recommended model may be one the catalog folded into another of its tier: it still runs as written.
  const pool = available && !open.some((option) => same(option, available)) ? [...open, { ...available, cost: costOf(available) }] : open
  const ordered = [...pool].sort(compare)
  const candidates = []
  if (defaulted) for (const tool of [...ready].sort((a, b) => (other({ tool: a }) ? 0 : 1) - (other({ tool: b }) ? 0 : 1))) {
    if (!isBlocked(withPin(tool))) candidates.push({ ...withPin(tool), score: scoreOf(withPin(tool)) })
  }
  for (const option of ordered) {
    const next = { tool: option.tool, model: pin.model ?? option.model, effort: pin.effort ?? option.effort }
    if (!candidates.some((entry) => same(entry, next))) candidates.push({ ...next, score: scoreOf(next) })
  }
  if (!candidates.length) return result(null, 'none', [], skipped)
  const { score, ...chosen } = candidates[0]
  const source = pinned ? 'explicit' : !rec ? 'default' : available && same(chosen, available) ? 'task' : 'nearest'
  return result(chosen, source, candidates, skipped)
}

// The route a dispatch record, manifest and job carry: what ran and why.
export const routeRecord = (route) => route.chosen ? { ...route.chosen, source: route.source, recommended: route.recommended } : null
