import { SkillPackageError } from './errors.mjs'

const fail = (message, details = []) => { throw new SkillPackageError(message, details) }
const strings = (value) => Array.isArray(value) && value.every((entry) => typeof entry === 'string' && entry.trim())
const sha = (value) => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)
// What the host compares a candidate with: one exact commit, never an abbreviation.
export const CANDIDATE = 'Full 40- or 64-character lowercase hex SHA of the exact commit observed (git rev-parse HEAD), or null.'
const fields = ['id', 'scenario', 'steps', 'expected', 'observed', 'evidence', 'status', 'reason', 'replaces', 'stage', 'required', 'owner', 'candidate', 'duplicationReason']

export const AGENT_CHECK_SCHEMA = { type: 'array', items: { type: 'object', additionalProperties: false, required: fields,
  properties: { id: { type: 'string' }, scenario: { type: 'string' }, steps: { type: 'array', items: { type: 'string' }, description: 'At least one step.' }, expected: { type: 'string' }, observed: { type: 'string' },
    evidence: { type: 'array', items: { type: 'string' } }, status: { type: 'string', enum: ['pass', 'fail', 'not-run'] }, reason: { type: 'string' }, replaces: { type: 'array', items: { type: 'string' } },
    stage: { type: 'string', enum: ['unit', 'integration'] }, required: { type: 'boolean' }, owner: { type: 'string' }, candidate: { type: ['string', 'null'], description: CANDIDATE }, duplicationReason: { type: 'string' } } } }

export function validateAgentAcceptance(value = []) {
  if (!Array.isArray(value)) fail('agentChecks는 인수검증 목록이어야 합니다.')
  const ids = new Set()
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !['id', 'scenario', 'expected'].every((key) => typeof entry[key] === 'string' && entry[key].trim()) || !strings(entry.steps) || !entry.steps.length || !['pass', 'fail', 'not-run'].includes(entry.status)) fail('에이전트 인수검증의 id/scenario/steps/expected/status가 올바르지 않습니다.')
    if (ids.has(entry.id)) fail(`에이전트 인수검증 ID가 중복됩니다: ${entry.id}`)
    ids.add(entry.id)
    const stage = entry.stage ?? 'integration', required = entry.required ?? true, owner = entry.owner ?? 'host', candidate = entry.candidate ?? null
    const observed = entry.observed ?? '', evidence = entry.evidence ?? [], reason = entry.reason ?? '', replaces = entry.replaces ?? [], duplicationReason = entry.duplicationReason ?? ''
    // The field and the form it takes: a model can correct exactly that and nothing else.
    const wrong = [[!['unit', 'integration'].includes(stage), 'stage', 'unit|integration'], [typeof required !== 'boolean', 'required', 'boolean'],
      [typeof owner !== 'string' || !owner.trim(), 'owner', 'non-empty string'], [candidate !== null && !sha(candidate), 'candidate', CANDIDATE],
      [typeof observed !== 'string', 'observed', 'string'], [!strings(evidence), 'evidence', 'array of non-empty strings'], [typeof reason !== 'string', 'reason', 'string'],
      [!strings(replaces) || new Set(replaces).size !== replaces.length, 'replaces', 'array of distinct non-empty strings'], [typeof duplicationReason !== 'string', 'duplicationReason', 'string']].find(([bad]) => bad)
    if (wrong) fail(`에이전트 인수검증 ${entry.id}의 ${wrong[1]} 형식이 올바르지 않습니다: ${wrong[2]}`, [`${wrong[1]}: ${JSON.stringify(entry[wrong[1]] ?? null)}`])
    if (entry.status === 'not-run' ? !reason.trim() : !observed.trim() || !evidence.length) fail(`미실행에는 사유, 실행 결과에는 관측과 증거가 필요합니다: ${entry.id}`)
    return { id: entry.id, scenario: entry.scenario, steps: [...entry.steps], expected: entry.expected, observed, evidence: [...evidence], status: entry.status, reason, replaces: [...replaces], stage, required, owner, candidate, duplicationReason }
  })
}

// The parts of a check that define its criterion and allocated coverage.
const CONTRACT = ['scenario', 'steps', 'expected', 'stage', 'required', 'replaces', 'duplicationReason']
const contractOf = (entry) => CONTRACT.map((field) => JSON.stringify(field === 'replaces' ? [...entry.replaces].sort() : entry[field]))
export const contractChanges = (recorded, entry) => CONTRACT.filter((field, index) => contractOf(recorded)[index] !== contractOf(entry)[index])

// owned: IDs the incoming report's own source recorded before (the same attempt or task). Its
// latest report restates them, so a planning change to that criterion replaces the old definition.
export function mergeAgentAcceptance(previous = [], incoming = [], { owned = [] } = {}) {
  const entries = new Map(validateAgentAcceptance(previous).map((entry) => [entry.id, entry]))
  const own = new Set(owned)
  // Execution evidence and the acting owner can change; the criterion and its allocated
  // coverage cannot. Otherwise another task's pass could erase a required pending check.
  for (const entry of validateAgentAcceptance(incoming)) {
    const recorded = entries.get(entry.id), changed = recorded ? contractChanges(recorded, entry) : []
    if (changed.length && !own.has(entry.id)) fail(`서로 다른 인수검증 기준에 같은 ID를 쓸 수 없습니다: ${entry.id}. 같은 기준이면 기록된 정의(${changed.join('·')})를 그대로 쓰고 관측·증거·status만 갱신하세요. 다른 기준이면 태스크별 고유 ID(T###-AC<n>)를 쓰세요.`,
      changed.map((field) => `${field}: recorded ${JSON.stringify(recorded[field])} / new ${JSON.stringify(entry[field])}`))
    entries.set(entry.id, entry)
  }
  return [...entries.values()]
}

// After the session's one chance to correct its JSON: every valid check is kept, and an invalid one
// becomes a required not-run handoff naming the error — a pass it claimed is not trusted, and a
// required check never silently disappears. issues names what was converted.
export function salvageAgentChecks(value) {
  const checks = [], issues = [], ids = new Set()
  for (const entry of Array.isArray(value) ? value : []) {
    try {
      const [valid] = validateAgentAcceptance([entry])
      if (ids.has(valid.id)) fail(`에이전트 인수검증 ID가 중복됩니다: ${valid.id}`)
      ids.add(valid.id); checks.push(valid)
    } catch (error) {
      const id = typeof entry?.id === 'string' && entry.id.trim() && !ids.has(entry.id) ? entry.id : `invalid-${issues.length + 1}`
      const text = (key, fallback) => typeof entry?.[key] === 'string' && entry[key].trim() ? entry[key] : fallback
      ids.add(id); issues.push({ id, error: error.message })
      if (entry?.required === false) continue
      checks.push(...validateAgentAcceptance([{ id, scenario: text('scenario', `agent check ${id}`), steps: strings(entry?.steps) && entry.steps.length ? entry.steps : ['(steps missing in the unit report)'],
        expected: text('expected', '(expected result missing in the unit report)'), status: 'not-run', reason: `reported in an invalid form (${error.message}); a capable host must observe it`,
        replaces: strings(entry?.replaces) ? [...new Set(entry.replaces)] : [], stage: ['unit', 'integration'].includes(entry?.stage) ? entry.stage : 'integration', required: true, owner: 'host' }]))
    }
  }
  return { checks, issues }
}

// A model often copies the short SHA Git prints. resolve(prefix) answers the full commit SHA that
// prefix names in the workspace (or null); only an unambiguous commit replaces it.
export async function expandCandidates(checks, resolve) {
  if (!Array.isArray(checks)) return checks
  return Promise.all(checks.map(async (entry) => {
    const value = typeof entry?.candidate === 'string' ? entry.candidate.trim().toLowerCase() : null
    if (!value || /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value) || !/^[a-f0-9]{7,63}$/.test(value)) return entry
    const full = await resolve(value).catch(() => null)
    return full && full.startsWith(value) ? { ...entry, candidate: full } : entry
  }))
}

export function validateAcceptanceAllocation(checks, automatedIds = []) {
  const entries = validateAgentAcceptance(checks), selected = new Set(automatedIds)
  for (const entry of entries) if (entry.replaces.some((id) => selected.has(id))) fail(`agent로 대체한 자동 검사를 함께 실행할 수 없습니다. 중복 사유로 승인하지 말고 주 검증 방법에 맞춰 자동 실행 범위를 제거·축소하세요: ${entry.id}`)
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
