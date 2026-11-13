import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { executeAgentAdapter, compactUsage } from './agent-adapter.mjs'
import { inspectProviders, sessionRoute, providerFlags } from './work-providers.mjs'
import { SkillPackageError } from './errors.mjs'
import { readSettings } from './settings.mjs'
import { inspectWorkspace } from './workspace.mjs'
import { runtimeRoot } from './work-runtime.mjs'
import { usageRun, finishUsageRun } from './usage-measurement.mjs'

// One read-only headless session that returns proposals only. Orchestrators that cannot
// start native subagents (autopilot, headless or Codex runs) delegate exploration here,
// so code and logs are read in a short-lived context instead of the orchestrator's.
export async function workScout(options = {}, injected = {}) {
  const deps = { inspect: inspectProviders, execute: executeAgentAdapter, flags: providerFlags, now: Date.now, ...injected }
  if (!options.promptFile) throw new SkillPackageError('--prompt-file이 필요합니다(채운 탐색 프롬프트).')
  const prompt = await readFile(path.resolve(options.promptFile), 'utf8')
  const timeoutMs = Number(options.timeoutMs ?? 900000)
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new SkillPackageError('timeout-ms는 양의 정수입니다.')
  const started = deps.now()
  const workspace = path.resolve(options.targetRoot ?? process.cwd())
  const settings = (await readSettings({ targetRoot: workspace })).values
  const inspected = await inspectWorkspace({ targetRoot: workspace })
  // The CLI assigns the tool·model·effort within SETTINGS agents (--provider only when the person names one).
  const route = await sessionRoute(options, 'scout', { root: workspace, runtime: inspected.git ? runtimeRoot(inspected) : null, inspect: deps.inspect, ...(deps.catalog ? { catalog: deps.catalog } : {}), now: deps.now })
  const provider = route.tool
  const flags = await deps.flags(provider, { env: options.env ?? process.env })
  const measuredWorkspace = settings['usage-measurement'] ? inspected : null
  const measurementRun = measuredWorkspace ? usageRun(true, measuredWorkspace.git ? runtimeRoot(measuredWorkspace) : path.join(workspace, '.tmp/gusta/v1')) : null
  const job = { schemaVersion: 1, role: 'scout', workspace, prompt, timeoutMs, headlessMcp: settings['headless-mcp'], ...(measurementRun ? { usageMeasurement: measurementRun } : {}) }
  let result, failure
  let measurement
  // Provider progress stays out of the returned JSON; only a short failure tail is kept.
  try { result = await deps.execute({ provider, model: route.model ?? undefined, effort: route.effort ?? null, job, env: options.env, log: () => {}, flags }) } catch (error) {
    failure = new SkillPackageError(error.message, (error.details ?? []).map((detail) => String(detail).slice(-2000)))
  } finally {
    if (measurementRun) {
      try { measurement = await finishUsageRun(measurementRun, 1) }
      catch (error) { measurement = { status: 'unavailable', error: error.message }; process.stderr.write(`Usage measurement unavailable: ${error.message}\n`) }
    }
  }
  if (failure) {
    if (measurement) { failure.measurement = measurement; failure.details.push(measurement.chatSummary) }
    throw failure
  }
  return { schemaVersion: 1, ok: true, provider, model: route.model ?? null, ...(route.effort ? { effort: route.effort } : {}), ms: deps.now() - started, summary: result.summary, proposals: result.proposals, usage: compactUsage(result.usage), ...(measurement ? { measurement } : {}) }
}
