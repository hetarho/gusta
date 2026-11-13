import assert from 'node:assert/strict'
import test from 'node:test'
import { buildCatalog } from '../src/agent-catalog.mjs'
import { routeAgent, routeRecord, routeLabel, runLabel, DEFAULT_SCORE } from '../src/agent-route.mjs'

// Two signed-in tools: Claude's aliases at low..max, a Codex catalog of four families at low..xhigh.
const CLAUDE = { installed: true, loggedIn: true, models: ['haiku', 'sonnet', 'opus', 'fable'].map((model) => ({ model, efforts: ['low', 'medium', 'high', 'xhigh', 'max'], context: null })) }
const CODEX = { installed: true, loggedIn: true, models: ['luna-mini', 'terra', 'sol', 'astra'].map((model, priority) => ({ model, efforts: ['low', 'medium', 'high', 'xhigh'], context: 272000, priority })) }
const catalog = (agents, probes = {}) => buildCatalog({ claude: CLAUDE, codex: CODEX, ...probes }, agents)
const BOTH = ['claude', 'codex']
const label = (route) => runLabel(route.chosen)

test('우선순위: 명시 지정 > 태스크 run: > 기본값, 명시 --provider는 그 도구로 고정한다', () => {
  const agents = BOTH
  const task = routeAgent({ agents, catalog: catalog(agents), recommended: 'codex/sol@high' })
  assert.deepEqual([label(task), task.source, task.recommended, task.score], ['codex/sol@high', 'task', 'codex/sol@high', 9])
  assert.deepEqual(routeRecord(task), { tool: 'codex', model: 'sol', effort: 'high', source: 'task', recommended: 'codex/sol@high' })
  // A pinned tool keeps the task's capability on that tool; a pinned model/effort overrides the field.
  const pinned = routeAgent({ agents, catalog: catalog(agents), recommended: 'codex/sol@high', explicit: { tool: 'claude' } })
  assert.deepEqual([label(pinned), pinned.source, pinned.skipped[0].reason], ['claude/opus@high', 'explicit', 'pinned-tool'])
  assert.ok(pinned.candidates.every((option) => option.tool === 'claude'))
  assert.equal(label(routeAgent({ agents, catalog: catalog(agents), recommended: 'codex/sol@high', explicit: { effort: 'low' } })), 'codex/sol@low')
  // A tool pinned outside agents still runs (the person named it).
  assert.equal(label(routeAgent({ agents: ['codex'], catalog: catalog(['codex']), explicit: { tool: 'claude', model: 'opus', effort: 'max' } })), 'claude/opus@max')
  // Without a catalog the pin or the task's run: is taken as written.
  const trusted = routeAgent({ recommended: 'claude/sonnet@high', explicit: { tool: 'claude' } })
  assert.deepEqual([label(trusted), trusted.source], ['claude/sonnet@high', 'explicit'])
  assert.deepEqual([label(routeAgent({ recommended: 'claude/sonnet@high' })), routeAgent({ recommended: 'claude/sonnet@high' }).source], ['claude/sonnet@high', 'task'])
  assert.deepEqual([label(routeAgent({ explicit: { tool: 'codex' }, recommended: 'claude/sonnet@high' })), routeAgent({}).source], ['codex', 'none'])
})

test('쓸 수 없는 추천은 score가 가장 가까운 allowed 조합으로 바꾸고, 같으면 싼 쪽·agents 순서다', () => {
  // Outside agents: the nearest score among the allowed tools.
  const outside = routeAgent({ agents: ['claude'], catalog: catalog(['claude']), recommended: 'codex/sol@high' })
  assert.deepEqual([label(outside), outside.source, outside.skipped[0]], ['claude/opus@high', 'nearest', { option: { tool: 'codex', model: 'sol', effort: 'high' }, reason: 'not-in-agents' }])
  // Not signed in: the tool is skipped as a whole.
  const signedOut = routeAgent({ agents: BOTH, catalog: catalog(BOTH, { codex: { ...CODEX, loggedIn: false } }), recommended: 'codex/terra@xhigh' })
  assert.deepEqual([label(signedOut), signedOut.skipped], ['claude/sonnet@xhigh', [{ option: { tool: 'codex', model: 'terra', effort: 'xhigh' }, reason: 'not-logged-in' }, { option: { tool: 'codex' }, reason: 'not-logged-in' }]])
  // An effort the model does not take (Claude has no ultra): the nearest score (sol@max = 11 = astra@medium).
  const effort = routeAgent({ agents: ['codex'], catalog: catalog(['codex']), recommended: 'codex/sol@max' })
  assert.deepEqual([label(effort), effort.skipped[0].reason], ['codex/astra@medium', 'effort-unsupported'])
  assert.equal(routeAgent({ agents: ['claude'], catalog: catalog(['claude']), recommended: 'claude/opus@ultra' }).skipped[0].reason, 'effort-unsupported')
  // A model the catalog does not list (a full model ID): its family's score.
  assert.equal(label(routeAgent({ agents: ['claude'], catalog: catalog(['claude']), recommended: 'claude/claude-opus-9@high' })), 'claude/opus@high')
  // Equal distance: cheaper first, then the agents order.
  assert.equal(label(routeAgent({ agents: ['codex', 'claude'], catalog: catalog(['codex', 'claude']), recommended: 'codex/unknown@low' })), 'codex/luna-mini@low')
  // candidates: every usable option nearest first, the fallback order (chosen first).
  const order = routeAgent({ agents: BOTH, catalog: catalog(BOTH), recommended: 'claude/sonnet@high' })
  assert.deepEqual(order.candidates.slice(0, 3).map(runLabel), ['claude/sonnet@high', 'codex/terra@high', 'claude/haiku@max'])
  assert.equal(order.candidates.length, 36)
  // blocked (a usage limit, U4) moves to the next candidate and says why.
  const blocked = routeAgent({ agents: BOTH, catalog: catalog(BOTH), recommended: 'claude/sonnet@high', blocked: [{ tool: 'claude', reason: 'usage-limit' }] })
  assert.deepEqual([label(blocked), blocked.source, blocked.skipped.map((entry) => entry.reason)], ['codex/terra@high', 'nearest', ['blocked', 'usage-limit']])
  const none = routeAgent({ agents: ['claude'], catalog: catalog(['claude']), blocked: [{ tool: 'claude' }] })
  assert.deepEqual([none.chosen, none.source, none.candidates], [null, 'none', []])
})

test('추천이 없으면 agents 첫 도구를 그 도구의 기본 설정(모델·에포트 미지정)으로; 폴백은 다른 도구의 기본 설정, 그다음 DEFAULT_SCORE에 가까운 조합', () => {
  const claude = routeAgent({ agents: ['claude'], catalog: catalog(['claude']) })
  assert.deepEqual([claude.chosen, claude.source, claude.score, claude.recommended], [{ tool: 'claude', model: null, effort: null }, 'default', null, null])
  assert.deepEqual(routeRecord(claude), { tool: 'claude', model: null, effort: null, source: 'default', recommended: null })
  assert.equal(label(routeAgent({ agents: ['codex', 'claude'], catalog: catalog(['codex', 'claude']) })), 'codex')
  assert.equal(label(routeAgent({ agents: BOTH, catalog: catalog(BOTH), recommended: '-' })), 'claude')
  // The mid score the fallbacks sit nearest: the balanced family at high effort.
  assert.equal(DEFAULT_SCORE, 6)
  assert.deepEqual(routeAgent({ agents: BOTH, catalog: catalog(BOTH) }).candidates.slice(0, 4).map(runLabel), ['claude', 'codex', 'claude/sonnet@high', 'codex/terra@high'])
  // Claude's session limit: Codex at its own setting. Only an Opus limit: the own setting may be Opus, so
  // a single-tool list takes the nearest non-Opus combination.
  const session = routeAgent({ agents: BOTH, catalog: catalog(BOTH), blocked: [{ tool: 'claude', reason: 'usage-limit' }] })
  assert.deepEqual([label(session), session.source, session.skipped.map((entry) => entry.reason)], ['codex', 'default', ['usage-limit']])
  const opus = routeAgent({ agents: ['claude'], catalog: catalog(['claude']), blocked: [{ tool: 'claude', family: 'opus', reason: 'usage-limit' }] })
  assert.deepEqual([label(opus), opus.skipped], ['claude/sonnet@high', [{ option: { tool: 'claude', family: 'opus' }, reason: 'usage-limit' }]])
  assert.ok(opus.candidates.every((option) => option.model && !option.model.includes('opus')))
  // A task's opus run: under that block, the nearest score off the family.
  assert.equal(label(routeAgent({ agents: ['claude'], catalog: catalog(['claude']), recommended: 'claude/opus@high', blocked: [{ tool: 'claude', family: 'opus', reason: 'usage-limit' }] })), 'claude/sonnet@max')
  // A pinned tool keeps its own setting; a pinned model runs at that tool's own effort.
  assert.equal(label(routeAgent({ agents: BOTH, catalog: catalog(BOTH), explicit: { tool: 'codex' } })), 'codex')
  assert.equal(label(routeAgent({ agents: BOTH, catalog: catalog(BOTH), explicit: { tool: 'claude', model: 'opus' } })), 'claude/opus')
  // A/B variants and scouts take the same default whatever they are handed, so variants compare.
  for (const role of ['variant', 'scout']) assert.equal(label(routeAgent({ role, agents: BOTH, catalog: catalog(BOTH), recommended: 'claude/fable@max' })), 'claude')
  // Without a catalog: the other allowed tools at their own setting follow, in agents order.
  assert.deepEqual([label(routeAgent({ agents: BOTH, blocked: [{ tool: 'claude', reason: 'usage-limit' }] })), routeAgent({ agents: BOTH }).source], ['codex', 'default'])
  const written = routeAgent({ agents: BOTH, recommended: 'claude/sonnet@high', blocked: [{ tool: 'claude', reason: 'usage-limit' }] })
  assert.deepEqual([label(written), written.source, written.skipped[0].reason], ['codex', 'nearest', 'usage-limit'])
})

test('리뷰어는 워커 능력 이상이고 agents에 도구가 둘 이상이면 다른 도구를 먼저 고른다', () => {
  const worker = { tool: 'claude', model: 'sonnet', effort: 'high' }
  const other = routeAgent({ role: 'reviewer', agents: BOTH, catalog: catalog(BOTH), recommended: 'claude/sonnet@high', worker })
  assert.deepEqual([label(other), other.score >= 6], ['codex/terra@high', true])
  // One tool: the same tool, never below the worker.
  const same = routeAgent({ role: 'reviewer', agents: ['claude'], catalog: catalog(['claude']), worker: { tool: 'claude', model: 'opus', effort: 'high' } })
  assert.deepEqual([label(same), same.score], ['claude/opus@high', 9])
  // The other tool cannot match the worker (codex tops out at astra@xhigh = 13): the same tool, at or above it.
  const strong = routeAgent({ role: 'reviewer', agents: BOTH, catalog: catalog(BOTH), worker: { tool: 'claude', model: 'fable', effort: 'max' } })
  assert.deepEqual([label(strong), strong.score], ['claude/fable@max', 14])
  // A worker on its tool's own setting (capability unknown): the other tool's own setting reviews.
  assert.equal(label(routeAgent({ role: 'reviewer', agents: BOTH, catalog: catalog(BOTH), worker: { tool: 'claude', model: null, effort: null } })), 'codex')
})

test('회복 단위는 원래 추천보다 낮아지지 않고, probe는 목록 첫 도구의 가장 싼 조합이다', () => {
  // Claude at low/medium only: opus@high (9) is unavailable; the nearest tie (opus@medium 8, fable@low 10)
  // goes to the cheaper, lower one, but a recovery unit never drops below the recommendation.
  const shallow = catalog(['claude'], { claude: { ...CLAUDE, models: CLAUDE.models.map((entry) => ({ ...entry, efforts: ['low', 'medium'] })) } })
  const ordinary = routeAgent({ agents: ['claude'], catalog: shallow, recommended: 'claude/opus@high' })
  const recovery = routeAgent({ agents: ['claude'], catalog: shallow, recommended: 'claude/opus@high', recovery: true })
  assert.deepEqual([label(ordinary), ordinary.score, label(recovery), recovery.score], ['claude/opus@medium', 8, 'claude/fable@low', 10])
  // A recovery with no run: the default, the tool's own setting.
  assert.deepEqual([label(routeAgent({ agents: BOTH, catalog: catalog(BOTH), recovery: true })), routeAgent({ agents: BOTH, catalog: catalog(BOTH), recovery: true }).source], ['claude', 'default'])
  // probe: the first tool of agents at its cheapest combination, the next tool when it cannot run.
  assert.equal(label(routeAgent({ role: 'probe', agents: ['codex', 'claude'], catalog: catalog(['codex', 'claude']), recommended: 'claude/fable@max' })), 'codex/luna-mini@low')
  assert.equal(label(routeAgent({ role: 'probe', agents: BOTH, catalog: catalog(BOTH, { claude: { installed: false } }) })), 'codex/luna-mini@low')
})

test('보고서 표시는 실제로 돌린 조합이고, 추천과 다르면 추천 → 실제다', () => {
  assert.equal(routeLabel({ tool: 'claude', model: 'opus', effort: 'high', recommended: 'codex/sol@high' }), 'codex/sol@high → claude/opus@high')
  assert.equal(routeLabel({ tool: 'codex', model: 'sol', effort: 'high', recommended: 'codex/sol@high' }), 'codex/sol@high')
  assert.equal(routeLabel({ tool: 'claude', model: null, effort: null, recommended: null }), 'claude')
  assert.throws(() => routeAgent({ role: 'planner' }), /unknown route role/)
})
