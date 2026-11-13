import { SkillPackageError } from './errors.mjs'

const fail = (message) => { throw new SkillPackageError(message) }
const strings = (value) => Array.isArray(value) && value.every((entry) => typeof entry === 'string' && entry.trim())
const sha = (value) => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)
const fields = ['id', 'scenario', 'steps', 'expected', 'observed', 'evidence', 'status', 'reason', 'replaces', 'stage', 'required', 'owner', 'candidate', 'duplicationReason']

export const AGENT_CHECK_SCHEMA = { type: 'array', items: { type: 'object', additionalProperties: false, required: fields,
  properties: { id: { type: 'string' }, scenario: { type: 'string' }, steps: { type: 'array', items: { type: 'string' } }, expected: { type: 'string' }, observed: { type: 'string' },
    evidence: { type: 'array', items: { type: 'string' } }, status: { type: 'string', enum: ['pass', 'fail', 'not-run'] }, reason: { type: 'string' }, replaces: { type: 'array', items: { type: 'string' } },
    stage: { type: 'string', enum: ['unit', 'integration'] }, required: { type: 'boolean' }, owner: { type: 'string' }, candidate: { type: ['string', 'null'] }, duplicationReason: { type: 'string' } } } }

export function validateAgentAcceptance(value = []) {
  if (!Array.isArray(value)) fail('agentChecks는 인수검증 목록이어야 합니다.')
  const ids = new Set()
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !['id', 'scenario', 'expected'].every((key) => typeof entry[key] === 'string' && entry[key].trim()) || !strings(entry.steps) || !entry.steps.length || !['pass', 'fail', 'not-run'].includes(entry.status)) fail('에이전트 인수검증의 id/scenario/steps/expected/status가 올바르지 않습니다.')
    if (ids.has(entry.id)) fail(`에이전트 인수검증 ID가 중복됩니다: ${entry.id}`)
    ids.add(entry.id)
    const stage = entry.stage ?? 'integration', required = entry.required ?? true, owner = entry.owner ?? 'host', candidate = entry.candidate ?? null
    const observed = entry.observed ?? '', evidence = entry.evidence ?? [], reason = entry.reason ?? '', replaces = entry.replaces ?? [], duplicationReason = entry.duplicationReason ?? ''
    if (!['unit', 'integration'].includes(stage) || typeof required !== 'boolean' || typeof owner !== 'string' || !owner.trim() || candidate !== null && !sha(candidate) || typeof observed !== 'string' || !strings(evidence) || typeof reason !== 'string' || !strings(replaces) || typeof duplicationReason !== 'string' || new Set(replaces).size !== replaces.length) fail(`에이전트 인수검증 메타데이터가 올바르지 않습니다: ${entry.id}`)
    if (entry.status === 'not-run' ? !reason.trim() : !observed.trim() || !evidence.length) fail(`미실행에는 사유, 실행 결과에는 관측과 증거가 필요합니다: ${entry.id}`)
    return { id: entry.id, scenario: entry.scenario, steps: [...entry.steps], expected: entry.expected, observed, evidence: [...evidence], status: entry.status, reason, replaces: [...replaces], stage, required, owner, candidate, duplicationReason }
  })
}

export function mergeAgentAcceptance(previous = [], incoming = []) {
  const entries = new Map(validateAgentAcceptance(previous).map((entry) => [entry.id, entry]))
  // Execution evidence and the acting owner can change; the criterion and its allocated
  // coverage cannot. Otherwise another task's pass could erase a required pending check.
  const contract = (entry) => JSON.stringify([entry.scenario, entry.steps, entry.expected, entry.stage, entry.required, [...entry.replaces].sort(), entry.duplicationReason])
  for (const entry of validateAgentAcceptance(incoming)) {
    const recorded = entries.get(entry.id)
    if (recorded && contract(recorded) !== contract(entry)) fail(`서로 다른 인수검증 기준에 같은 ID를 쓸 수 없습니다. 태스크·세션별 고유 ID를 사용하세요: ${entry.id}`)
    entries.set(entry.id, entry)
  }
  return [...entries.values()]
}

export function validateAcceptanceAllocation(checks, automatedIds = []) {
  const entries = validateAgentAcceptance(checks), selected = new Set(automatedIds)
  for (const entry of entries) if (entry.replaces.some((id) => selected.has(id)) && !entry.duplicationReason.trim()) fail(`agent로 대체한 자동 검사를 함께 실행할 수 없습니다. 범위를 줄이거나 중복 근거·비용을 기록하세요: ${entry.id}`)
  return entries
}

export function summarizeAgentAcceptance(checks = [], { stage, candidate } = {}) {
  const entries = validateAgentAcceptance(checks).filter((entry) => !stage || entry.stage === stage)
  const required = entries.filter((entry) => entry.required)
  const current = (entry) => entry.stage !== 'integration' || candidate !== undefined && entry.candidate === candidate
  const passed = entries.filter((entry) => entry.status === 'pass' && current(entry)).length
  const failed = entries.filter((entry) => entry.status === 'fail' && current(entry)).length
  const stale = entries.filter((entry) => entry.status !== 'not-run' && !current(entry)).length
  const notRun = entries.filter((entry) => entry.status === 'not-run').length
  return { total: entries.length, passed, failed, notRun, stale, needsAgent: required.some((entry) => entry.status === 'not-run' || !current(entry)),
    verified: required.every((entry) => entry.status === 'pass' && current(entry)) }
}

const cell = (value) => String(value ?? '').replaceAll('|', '\\|').replace(/\r?\n/g, '<br>')
export function renderAgentAcceptance(checks = []) {
  const entries = validateAgentAcceptance(checks)
  if (!entries.length) return ''
  const lines = ['Agent acceptance — review missing or incorrect criteria.', '', '| id / stage / owner | scenario | steps | expected | observed | evidence | status |', '| --- | --- | --- | --- | --- | --- | --- |']
  for (const entry of entries) lines.push(`| ${cell(`${entry.id} / ${entry.stage} / ${entry.owner}${entry.required ? ' (required)' : ''}`)} | ${cell(entry.scenario)} | ${cell(entry.steps.join('\n'))} | ${cell(entry.expected)} | ${cell(entry.observed || entry.reason)} | ${cell([...entry.evidence, ...(entry.candidate ? [`candidate ${entry.candidate}`] : []), ...(entry.replaces.length ? [`replaces ${entry.replaces.join(', ')}`] : []), ...(entry.duplicationReason ? [`duplication ${entry.duplicationReason}`] : [])].join('\n'))} | ${entry.status} |`)
  return lines.join('\n')
}
