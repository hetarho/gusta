import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { EFFORTS } from './spec-format.mjs'
import { readSettings, agentList, AGENT_TOOLS } from './settings.mjs'

const execute = promisify(execFile)

// What each installed AI tool can run, read without a model call: login state, models, efforts.
// Planning (gusta-create-task) picks the cheapest sufficient option into a task's `run:`; runners
// dispatch it as written and fall back to the nearest score within SETTINGS `agents`.

// Capability tier per model family, aligned across tools by position: 1 small·fast, 2 balanced,
// 3 workhorse, 4 frontier. Claude aliases always name the family's latest model and Codex slugs
// carry the family word, so no version ID is written here. A model with no known family word gets
// UNKNOWN_TIER: it is never taken as capable, and a known model wins an equal slot.
export const TIERS = { claude: { haiku: 1, sonnet: 2, opus: 3, fable: 4 }, codex: { luna: 1, terra: 2, sol: 3, astra: 4 } }
export const UNKNOWN_TIER = 1
const effortRank = (effort) => EFFORTS.indexOf(effort) + 1
// score (capability): one tier step is worth three effort steps, so tiers overlap at their edges
// (sonnet@xhigh = opus@low). cost: an order, not a price — tier first, then effort, since a smaller
// model is cheaper per token than a larger one at any effort.
export const capability = (tier, effort) => 3 * (tier - 1) + effortRank(effort)
export const costOrder = (tier, effort) => 10 * tier + effortRank(effort)

// The family word a model name carries (opus, terra...), null when none is known.
export const modelFamily = (tool, model) => {
  const words = String(model ?? '').toLowerCase().split(/[^a-z0-9]+/)
  return Object.keys(TIERS[tool] ?? {}).find((name) => words.includes(name)) ?? null
}
export const familyTier = (tool, model) => {
  const family = modelFamily(tool, model)
  return family ? { tier: TIERS[tool][family], known: true } : { tier: UNKNOWN_TIER, known: false }
}

// `claude --help`: the --effort levels and the aliases quoted in --model's description.
export function parseClaudeHelp(text) {
  const block = (flag) => text.match(new RegExp(`\\n\\s*${flag}\\b[^\\n]*(?:\\n\\s{8,}[^\\n-][^\\n]*)*`))?.[0] ?? ''
  const efforts = (block('--effort').match(/\(([a-z, ]+)\)/)?.[1] ?? '').split(',').map((item) => item.trim()).filter((item) => EFFORTS.includes(item))
  const aliases = [...block('--model').matchAll(/'([a-z][a-z0-9-]*)'/g)].map((match) => match[1])
  return { efforts, aliases }
}

// `codex debug models --bundled`: the picker's models (hidden ones are specialty or internal).
// A model the catalog marks for upgrade is superseded: listed, never offered.
export function parseCodexModels(text) {
  const models = JSON.parse(text)?.models
  if (!Array.isArray(models)) throw new Error('no models array')
  return models.filter((entry) => typeof entry?.slug === 'string' && (entry.visibility ?? 'list') === 'list').map((entry) => ({
    model: entry.slug,
    efforts: (entry.supported_reasoning_levels ?? []).map((level) => typeof level === 'string' ? level : level?.effort).filter((effort) => typeof effort === 'string'),
    context: Number.isSafeInteger(entry.context_window) ? entry.context_window : null,
    priority: Number.isFinite(entry.priority) ? entry.priority : null,
    superseded: entry.upgrade?.model ?? null,
  }))
}

// Login without a model call. null = the answer could not be read (never guessed).
export function parseClaudeAuth(result) {
  try {
    const status = JSON.parse(result.stdout)
    return typeof status.loggedIn === 'boolean' ? { loggedIn: status.loggedIn, auth: typeof status.authMethod === 'string' ? status.authMethod : null } : { loggedIn: null }
  } catch { return { loggedIn: null } }
}
export function parseCodexLogin(result) {
  const text = `${result.stdout}\n${result.stderr}`
  if (/not logged in/i.test(text)) return { loggedIn: false }
  if (result.code === 0 && /logged in/i.test(text)) return { loggedIn: true, auth: text.match(/logged in using (?:an? )?([\w -]+?)\s*$/im)?.[1]?.trim() ?? null }
  return { loggedIn: null }
}

async function run(command, args, { env, cwd }) {
  const call = execute(command, args, { env, cwd, timeout: 10000, maxBuffer: 32 * 1024 * 1024 })
  call.child?.stdin?.end()
  try {
    const { stdout, stderr } = await call
    return { code: 0, stdout, stderr }
  } catch (error) {
    if (error.code === 'ENOENT') return { missing: true, code: null, stdout: '', stderr: '' }
    return { code: typeof error.code === 'number' ? error.code : 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '', timedOut: Boolean(error.killed) }
  }
}

const PROBES = {
  async claude(call) {
    const version = await call('claude', ['--version'])
    if (version.missing) return { installed: false }
    const [help, auth] = await Promise.all([call('claude', ['--help']), call('claude', ['auth', 'status', '--json'])])
    const parsed = help.code === 0 ? parseClaudeHelp(help.stdout) : { efforts: [], aliases: [] }
    const entry = { installed: true, version: version.stdout.trim() || null, ...parseClaudeAuth(auth) }
    if (!parsed.efforts.length) return { ...entry, error: 'help-unparsed', models: [] }
    const aliases = [...new Set([...Object.keys(TIERS.claude), ...parsed.aliases])]
    // Each alias takes every --effort level; a model below a level runs at its highest one (the CLI's rule).
    return { ...entry, models: aliases.map((model) => ({ model, efforts: parsed.efforts, context: null, inHelp: parsed.aliases.includes(model) })) }
  },
  async codex(call) {
    const version = await call('codex', ['--version'])
    if (version.missing) return { installed: false }
    const [models, login] = await Promise.all([call('codex', ['debug', 'models', '--bundled']), call('codex', ['login', 'status'])])
    const entry = { installed: true, version: version.stdout.trim() || null, ...parseCodexLogin(login) }
    try {
      if (models.code !== 0) throw new Error('exit')
      return { ...entry, models: parseCodexModels(models.stdout) }
    } catch { return { ...entry, error: 'models-unavailable', models: [] } }
  },
}

// The catalog from probe results. Options are offered models × known efforts, one per tool·tier·effort
// (a known model first, then the tool's own picker priority), cheapest first.
export function buildCatalog(probes, agents = null) {
  const order = (tool) => agents?.includes(tool) ? agents.indexOf(tool) : AGENT_TOOLS.length
  const tools = AGENT_TOOLS.map((tool) => {
    const probe = probes[tool] ?? { installed: false }
    const models = (probe.models ?? []).map((entry) => ({ ...entry, ...familyTier(tool, entry.model) }))
    const status = !probe.installed ? 'not-installed' : probe.error ? 'unknown' : 'ok'
    return { tool, installed: Boolean(probe.installed), version: probe.version ?? null, loggedIn: probe.installed ? probe.loggedIn ?? null : false,
      ...(probe.auth ? { auth: probe.auth } : {}), allowed: Boolean(agents?.includes(tool)), status, models, ...(probe.error ? { error: probe.error } : {}) }
  })
  const slots = new Map()
  for (const entry of tools.filter((item) => item.status === 'ok')) {
    for (const model of entry.models.filter((item) => !item.superseded)) {
      for (const effort of EFFORTS.filter((item) => model.efforts.includes(item))) {
        const key = `${entry.tool}\0${model.tier}\0${effort}`, held = slots.get(key)
        const better = !held || (model.known && !held.model.known) || (model.known === held.model.known && (model.priority ?? Infinity) < (held.model.priority ?? Infinity))
        if (better) slots.set(key, { tool: entry.tool, model, effort })
      }
    }
  }
  const options = [...slots.values()].map(({ tool, model, effort }) => ({ tool, model: model.model, effort, score: capability(model.tier, effort), cost: costOrder(model.tier, effort), allowed: Boolean(agents?.includes(tool)), ...(model.known ? {} : { known: false }) }))
    .sort((a, b) => a.cost - b.cost || b.score - a.score || order(a.tool) - order(b.tool) || a.tool.localeCompare(b.tool) || a.model.localeCompare(b.model))
  // The smallest context window among the models the allowed tools offer; a tool that cannot tell is listed.
  const offered = options.filter((option) => option.allowed)
  const contexts = offered.map((option) => ({ tool: option.tool, model: option.model, tokens: tools.find((entry) => entry.tool === option.tool).models.find((model) => model.model === option.model).context }))
  const minContext = contexts.filter((entry) => entry.tokens !== null).sort((a, b) => a.tokens - b.tokens)[0] ?? null
  const contextUnknown = [...new Set(contexts.filter((entry) => entry.tokens === null).map((entry) => entry.tool))]
  return { tools, options, minContext, contextUnknown }
}

// gusta agents [--json]. deps.call(command, args) replaces the CLI runner; deps.agents the SETTINGS list.
export async function agentCatalog(options = {}, deps = {}) {
  const env = options.env ?? process.env, cwd = options.targetRoot ?? process.cwd()
  const call = deps.call ?? ((command, args) => run(command, args, { env, cwd }))
  const value = deps.agents !== undefined ? deps.agents : (await readSettings(options)).values.agents
  const agents = agentList(value)
  const probes = Object.fromEntries(await Promise.all(AGENT_TOOLS.map(async (tool) => [tool, await PROBES[tool](call)])))
  return { schemaVersion: 1, modelRequests: 0, agents, unset: value === '?', ...buildCatalog(probes, agents) }
}
