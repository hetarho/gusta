import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { executeAgentAdapter, compactUsage } from './agent-adapter.mjs'
import { inspectProviders } from './work-providers.mjs'
import { SkillPackageError } from './errors.mjs'

// One read-only headless session that returns proposals only. Orchestrators that cannot
// start native subagents (autopilot, headless or Codex runs) delegate exploration here,
// so code and logs are read in a short-lived context instead of the orchestrator's.
export async function workScout(options = {}, injected = {}) {
  const deps = { inspect: inspectProviders, execute: executeAgentAdapter, now: Date.now, ...injected }
  if (!options.promptFile) throw new SkillPackageError('--prompt-file이 필요합니다(채운 탐색 프롬프트).')
  const prompt = await readFile(path.resolve(options.promptFile), 'utf8')
  const timeoutMs = Number(options.timeoutMs ?? 900000)
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new SkillPackageError('timeout-ms는 양의 정수입니다.')
  const requested = options.provider ?? 'auto'
  if (!['auto', 'codex', 'claude'].includes(requested)) throw new SkillPackageError(`지원하지 않는 실행기: ${requested}. auto, codex, claude 중 선택하세요.`)
  const inspection = await deps.inspect(options)
  const provider = requested === 'auto' ? inspection.autoProvider : requested
  if (!inspection.providers.some((entry) => entry.provider === provider && entry.compatible)) throw new SkillPackageError(`사용 가능한 ${requested} CLI가 없습니다. work doctor로 설치/호환성을 확인하세요.`)
  const started = deps.now()
  const job = { schemaVersion: 1, role: 'scout', workspace: path.resolve(options.targetRoot ?? process.cwd()), prompt, timeoutMs }
  let result
  // Provider progress stays out of the returned JSON; only a short failure tail is kept.
  try { result = await deps.execute({ provider, model: options.model, job, log: () => {} }) } catch (error) {
    throw new SkillPackageError(error.message, (error.details ?? []).map((detail) => String(detail).slice(-2000)))
  }
  return { schemaVersion: 1, ok: true, provider, model: options.model ?? null, ms: deps.now() - started, summary: result.summary, proposals: result.proposals, usage: compactUsage(result.usage) }
}
