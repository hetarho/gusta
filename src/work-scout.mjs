import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { executeAgentAdapter, compactUsage } from './agent-adapter.mjs'
import { inspectProviders, availableProvider, providerFlags } from './work-providers.mjs'
import { SkillPackageError } from './errors.mjs'

// One read-only headless session that returns proposals only. Orchestrators that cannot
// start native subagents (autopilot, headless or Codex runs) delegate exploration here,
// so code and logs are read in a short-lived context instead of the orchestrator's.
export async function workScout(options = {}, injected = {}) {
  const deps = { inspect: inspectProviders, execute: executeAgentAdapter, flags: providerFlags, now: Date.now, ...injected }
  if (!options.promptFile) throw new SkillPackageError('--prompt-file이 필요합니다(채운 탐색 프롬프트).')
  const prompt = await readFile(path.resolve(options.promptFile), 'utf8')
  const timeoutMs = Number(options.timeoutMs ?? 900000)
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new SkillPackageError('timeout-ms는 양의 정수입니다.')
  const provider = await availableProvider(options, deps.inspect)
  const flags = await deps.flags(provider, { env: options.env ?? process.env })
  const started = deps.now()
  const job = { schemaVersion: 1, role: 'scout', workspace: path.resolve(options.targetRoot ?? process.cwd()), prompt, timeoutMs }
  let result
  // Provider progress stays out of the returned JSON; only a short failure tail is kept.
  try { result = await deps.execute({ provider, model: options.model, job, log: () => {}, flags }) } catch (error) {
    throw new SkillPackageError(error.message, (error.details ?? []).map((detail) => String(detail).slice(-2000)))
  }
  return { schemaVersion: 1, ok: true, provider, model: options.model ?? null, ms: deps.now() - started, summary: result.summary, proposals: result.proposals, usage: compactUsage(result.usage) }
}
