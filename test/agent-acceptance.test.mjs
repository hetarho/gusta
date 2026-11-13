import test from 'node:test'
import assert from 'node:assert/strict'
import { validateAgentResult, RESULT_SCHEMAS } from '../src/agent-adapter.mjs'
import { validateAgentAcceptance, mergeAgentAcceptance, renderAgentAcceptance, summarizeAgentAcceptance, validateAcceptanceAllocation } from '../src/agent-acceptance.mjs'

const candidate = 'a'.repeat(40)
const pending = (id = 'open-panel') => ({ id, scenario: 'Open a panel', steps: ['Open the application', 'Select the panel'], expected: 'The panel is visible', status: 'not-run', reason: 'Computer-use tool is unavailable', replaces: ['old-panel-e2e'] })
const passed = (id = 'open-panel') => ({ ...pending(id), status: 'pass', reason: '', observed: 'The panel appeared with the expected content', evidence: ['artifacts/panel.png'], candidate })

test('unit and worker results retain acceptance evidence while legacy results keep their shape', () => {
  const legacy = { kind: 'task', id: 'T001', outcome: 'completed', pushed: false, next: 'continue' }
  assert.deepEqual(validateAgentResult('unit', legacy), legacy)
  const unit = validateAgentResult('unit', { ...legacy, agentChecks: [pending()] })
  assert.equal(unit.agentChecks[0].status, 'not-run'); assert.equal(unit.agentChecks[0].owner, 'host'); assert.equal(unit.agentChecks[0].stage, 'integration')
  const worker = validateAgentResult('worker', { outcome: 'completed', summary: 'Scoped work is ready', agentChecks: [passed()] })
  assert.deepEqual(worker.agentChecks[0].evidence, ['artifacts/panel.png'])
  assert.ok(RESULT_SCHEMAS.unit.required.includes('agentChecks')); assert.ok(RESULT_SCHEMAS.worker.required.includes('agentChecks'))
})

test('pass/fail needs observations and evidence; a tool-less handoff is explicitly not-run', () => {
  for (const status of ['pass', 'fail']) assert.throws(() => validateAgentAcceptance([{ ...pending(), status }]), /관측과 증거/)
  assert.throws(() => validateAgentAcceptance([{ ...pending(), reason: '' }]), /사유/)
  const summary = summarizeAgentAcceptance([pending()], { candidate })
  assert.equal(summary.verified, false); assert.equal(summary.needsAgent, true); assert.equal(summary.notRun, 1)
  assert.throws(() => validateAgentAcceptance([pending(), pending()]), /중복/)
})

test('integration proof is tied to the actual candidate and unit debt stays separately scoped', () => {
  assert.equal(summarizeAgentAcceptance([passed()], { stage: 'integration', candidate }).verified, true)
  const stale = summarizeAgentAcceptance([passed()], { stage: 'integration', candidate: 'b'.repeat(40) })
  assert.equal(stale.verified, false); assert.equal(stale.stale, 1)
  assert.equal(summarizeAgentAcceptance([{ ...passed(), candidate: null }], { candidate }).verified, false)
  assert.equal(summarizeAgentAcceptance([pending()], { stage: 'unit' }).verified, true)
})

test('resuming a checklist updates the same acceptance ID without duplicating the cost or hiding evidence', () => {
  const checks = mergeAgentAcceptance([pending()], [{ ...passed(), owner: 'computer-use-host' }])
  assert.equal(checks.length, 1); assert.equal(checks[0].status, 'pass')
  assert.equal(checks[0].owner, 'computer-use-host')
  const text = renderAgentAcceptance([{ ...checks[0], observed: 'Visible | useful\nSecond line' }])
  assert.ok(text.includes('Visible \\| useful<br>Second line')); assert.ok(text.includes(candidate)); assert.ok(text.includes('replaces old-panel-e2e'))
  assert.ok(!text.includes('\n## ')); assert.ok(text.includes('review missing or incorrect criteria'))
})

test('an unrelated pass cannot erase required pending coverage through a shared ID', () => {
  const original = [{ ...pending('visible'), scenario: 'Open settings', steps: ['Open settings'], expected: 'Settings shown' }]
  const unrelated = { ...passed('visible'), scenario: 'Open search', steps: ['Open search'], expected: 'Search shown' }
  assert.throws(() => mergeAgentAcceptance(original, [unrelated]), /태스크·세션별 고유 ID.*visible/)
  const remaining = summarizeAgentAcceptance(original, { candidate })
  assert.equal(remaining.verified, false); assert.equal(remaining.notRun, 1)
  assert.equal(original[0].scenario, 'Open settings')
})

test('resumed observations cannot silently waive or reallocate the declared acceptance contract', () => {
  for (const changed of [
    { expected: 'A different result' }, { steps: ['A different action'] },
    { required: false }, { stage: 'unit' }, { replaces: [] },
    { duplicationReason: 'Authorize another automated run after the fact' },
  ]) assert.throws(() => mergeAgentAcceptance([pending()], [{ ...passed(), ...changed }]), /같은 ID/)
  const updatedCandidate = 'b'.repeat(40)
  const resumed = mergeAgentAcceptance([passed()], [{ ...passed(), candidate: updatedCandidate, observed: 'Observed on the new candidate', evidence: ['artifacts/new-panel.png'] }])
  assert.equal(summarizeAgentAcceptance(resumed, { candidate: updatedCandidate }).verified, true)
  assert.equal(summarizeAgentAcceptance(resumed, { candidate }).verified, false)
})

test('agent replacement cannot silently keep the same selected automated scenario', () => {
  assert.throws(() => validateAcceptanceAllocation([pending()], ['old-panel-e2e']), /함께 실행/)
  assert.equal(validateAcceptanceAllocation([pending()], ['other-invariant']).length, 1)
  assert.equal(validateAcceptanceAllocation([{ ...pending(), duplicationReason: 'Independent failure boundary; additional cost is 2 seconds' }], ['old-panel-e2e']).length, 1)
})
