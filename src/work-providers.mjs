import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import { SkillPackageError } from './errors.mjs'

const execute = promisify(execFile)
const adapter = fileURLToPath(new URL('../bin/haeram-agent-adapter.mjs', import.meta.url))
const supported = ['codex', 'claude']
const requiredFlags = {
  codex: ['--sandbox', '--output-schema', '--output-last-message', '--json'],
  claude: ['--print', '--output-format', '--json-schema', '--permission-mode', '--allowedTools', '--tools', '--permission-prompts'],
}

async function probe(provider, cwd, env) {
  try {
    const [{ stdout: version }, { stdout: help }] = await Promise.all([
      execute(provider, ['--version'], { cwd, env, timeout: 5000, maxBuffer: 1024 * 1024 }),
      execute(provider, provider === 'codex' ? ['exec', '--help'] : ['--help'], { cwd, env, timeout: 5000, maxBuffer: 1024 * 1024 }),
    ])
    const missing = requiredFlags[provider].filter((flag) => !help.includes(flag))
    return { provider, available: true, compatible: missing.length === 0, version: version.trim(), missing }
  } catch (error) {
    return { provider, available: error.code !== 'ENOENT', compatible: false, error: error.code === 'ENOENT' ? 'not-installed' : error.killed ? 'probe-timeout' : 'probe-failed' }
  }
}

export async function inspectProviders(options = {}) {
  const providers = await Promise.all(supported.map((provider) => probe(provider, options.targetRoot ?? process.cwd(), options.env ?? process.env)))
  const selected = providers.find((entry) => entry.compatible)?.provider ?? null
  return { schemaVersion: 1, providers, autoProvider: selected, authentication: 'not-checked', modelRequests: 0 }
}

export async function inspectOrca(options = {}) {
  const env = options.env ?? process.env
  const candidates = options.orcaCommand ? [options.orcaCommand] : env.ORCA_CLI_COMMAND ? [env.ORCA_CLI_COMMAND] : [
    'orca', 'orca-dev', 'orca-ide',
    ...(process.platform === 'darwin' ? ['/Applications/Orca.app/Contents/Resources/bin/orca', path.join(os.homedir(), 'Applications/Orca.app/Contents/Resources/bin/orca')] : []),
  ]
  for (const command of candidates) {
    let version
    try { version = (await execute(command, ['--version'], { env, cwd: options.targetRoot, timeout: 5000 })).stdout.trim() } catch { continue }
    let reachable = false, capabilities = [], error = null
    try {
      const receipt = JSON.parse((await execute(command, ['status', '--json'], { env, cwd: options.targetRoot, timeout: 5000, maxBuffer: 1024 * 1024 })).stdout)
      reachable = receipt.ok === true && receipt.result?.runtime?.reachable === true
      capabilities = (receipt.result?.runtime?.capabilities ?? []).filter((value) => value.startsWith('orchestration.'))
      if (!reachable) error = 'runtime-unavailable'
    } catch { error = 'runtime-unavailable' }
    return { available: true, command, version, reachable, capabilities, error, onPath: !path.isAbsolute(command) }
  }
  return { available: false, reachable: false, error: 'cli-not-found', registration: 'Settings → General → Orca CLI' }
}

// One provider name for a one-off headless session (scout, A/B variant): the requested one if
// its CLI is compatible, else the auto choice. No model call.
export async function availableProvider(options = {}, inspect = inspectProviders) {
  const requested = options.provider ?? 'auto'
  if (!['auto', ...supported].includes(requested)) throw new SkillPackageError(`지원하지 않는 실행기: ${requested}. auto, codex, claude 중 선택하세요.`)
  const inspection = await inspect(options)
  const provider = requested === 'auto' ? inspection.autoProvider : requested
  if (!inspection.providers.some((entry) => entry.provider === provider && entry.compatible)) throw new SkillPackageError(`사용 가능한 ${requested} CLI가 없습니다. work doctor로 설치/호환성을 확인하세요.`)
  return provider
}

export async function workDoctor(options = {}) {
  const [providers, orca] = await Promise.all([inspectProviders(options), inspectOrca(options)])
  return { ...providers, orca }
}

export async function builtInAdapter(options = {}) {
  if (options.provider !== undefined && (options.providers !== undefined || options.workers !== undefined)) throw new SkillPackageError('--provider와 혼합 워커 설정을 함께 지정할 수 없습니다.')
  if (options.providers !== undefined && options.workers !== undefined) throw new SkillPackageError('providers와 workers 설정 중 하나만 지정하세요.')
  let requests
  if (options.workers !== undefined) {
    if (!Array.isArray(options.workers) || !options.workers.length || options.workers.some((entry) => !entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.provider !== 'string')) throw new SkillPackageError('workers에는 provider와 선택적 model을 가진 객체 배열이 필요합니다.')
    if (options.model !== undefined) throw new SkillPackageError('workers 설정에서는 각 워커의 model을 지정하세요.')
    requests = options.workers
  } else if (options.providers !== undefined) {
    const providers = typeof options.providers === 'string' ? options.providers.split(',').map((value) => value.trim()) : options.providers
    if (!Array.isArray(providers) || !providers.length || providers.some((value) => !supported.includes(value))) throw new SkillPackageError('providers는 codex,claude 목록이어야 합니다. 같은 도구를 반복해 비율을 지정할 수 있습니다.')
    if (options.model !== undefined) throw new SkillPackageError('혼합 실행의 모델은 adapter 파일의 workers 항목별로 지정하세요.')
    requests = providers.map((provider) => ({ provider }))
  } else requests = [{ provider: options.provider ?? 'auto', model: options.model }]
  for (const value of [...requests.map((entry) => entry.provider), options.reviewerProvider ?? 'auto']) {
    if (!['auto', ...supported].includes(value)) throw new SkillPackageError(`지원하지 않는 실행기: ${value}. auto, codex, claude 중 선택하세요.`)
  }
  const inspection = await inspectProviders(options)
  const select = (requested) => {
    const provider = requested === 'auto' ? inspection.autoProvider : requested
    const entry = inspection.providers.find((item) => item.provider === provider && item.compatible)
    if (!entry) throw new SkillPackageError(`사용 가능한 ${requested} CLI가 없습니다. work doctor로 설치/호환성을 확인하세요.`, inspection.providers.map((item) => JSON.stringify(item)))
    return entry
  }
  const configure = (entry, model) => {
    if (model !== undefined && (typeof model !== 'string' || !model.trim())) throw new SkillPackageError('model은 비어 있지 않은 문자열이어야 합니다.')
    return { command: process.execPath, args: [adapter, '--provider', entry.provider, ...(model ? ['--model', model] : [])], provider: entry.provider, version: entry.version, model: model ?? null }
  }
  const workers = requests.map((entry) => configure(select(entry.provider), entry.model))
  const worker = workers[0]
  const reviewer = options.reviewerProvider ? select(options.reviewerProvider) : select(worker.provider)
  const roles = { worker, reviewer: configure(reviewer, options.reviewerModel ?? (workers.length === 1 && reviewer.provider === worker.provider ? requests[0].model : undefined)) }
  return { kind: 'builtin', roles, workers, ...Object.fromEntries(['timeoutMs', 'maxDispatches', 'maxTaskRuns'].filter((key) => options[key] !== undefined).map((key) => [key, Number(options[key])])) }
}
