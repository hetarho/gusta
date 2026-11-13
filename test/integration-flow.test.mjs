import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fixture, git } from './helpers/vibe-fixture.mjs'
import { finalizeIntegration, vibeIntegration } from '../src/integration-run.mjs'
import { openIntegration } from '../src/integration-gate.mjs'
import { vibeSession, vibeBeat } from '../src/vibe.mjs'
import { validateAgentAcceptance } from '../src/agent-acceptance.mjs'
import { assertImplementationWorkspace, prepareSessionWorkspace } from '../src/session-workspace.mjs'
import { writeInteractive } from '../src/interactive-state.mjs'
import { inspectWorkspace } from '../src/workspace.mjs'

const shell = (value) => `'${value.replaceAll("'", "'\\''")}'`
const node = (code) => `node -e ${shell(code)}`
async function project(t, { plan, version = false } = {}) {
  const value = await fixture(t, 0), { root } = value
  if (version) {
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'verification-fixture', version: '1.0.0' }))
    await git(root, 'add', '.'); await git(root, 'commit', '-qm', 'version baseline')
  }
  await git(root, 'branch', 'delivery'); await git(root, 'switch', '-qc', 'feature-work')
  await writeFile(path.join(root, 'spec/SETTINGS.md'), `# SETTINGS\n- land: delivery\n- push: false\n- coord: session-ledger\n${version ? '- version: auto\n' : ''}`)
  await writeFile(path.join(root, 'spec/ssot/ARCH.md'), '# ARCH Architecture\n> r1 | Architecture\n\n## decisions\n- ARCH-1 [o] Verification.\n' + (plan ? '  - plan: `checks.json`\n' : '  - task: `node --version`.\n  - batch: `node --version`.\n  - CI: workflow.\n') + '\n## chg\n- r1 261101 initial\n')
  if (plan) await writeFile(path.join(root, 'checks.json'), JSON.stringify(plan))
  if (version) await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'verification-fixture', version: '1.0.0' }))
  await git(root, 'add', '-A'); await git(root, 'commit', '-qm', 'project verification')
  return value
}
const agent = (extra = {}) => ({ id: 'view-flow', scenario: 'Open the view', steps: ['Open candidate view'], expected: 'The view renders', status: 'not-run', reason: 'No computer-use tool in this worker', ...extra })

test('failed named check repairs reuse valid successes, same token/base/deadline and original attempt cap', async (t) => {
  const initial = await fixture(t, 0), counter = path.join(initial.temporary, 'counter')
  // Use the project helper's clean Git checkout while keeping the counter outside its tree.
  const plan = { schemaVersion: 1, checks: [
    { id: 'alpha', tier: 'batch', inputs: ['alpha.txt'], command: node(`require('node:fs').appendFileSync(${JSON.stringify(counter)},'A')`) },
    { id: 'beta', tier: 'batch', inputs: ['beta.txt'], command: node(`const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(counter)},'B');if(fs.readFileSync('beta.txt','utf8')!=='good')process.exit(1)`) },
  ] }
  const { root } = await project(t, { plan })
  await writeFile(path.join(root, 'alpha.txt'), 'stable'); await writeFile(path.join(root, 'beta.txt'), 'bad')
  await git(root, 'add', '.'); await git(root, 'commit', '-qm', 'verification inputs')
  const first = await finalizeIntegration({ targetRoot: root, tag: 'repair01', maxGateAttempts: 2 })
  assert.equal(first.reason, 'integration-failed')
  assert.equal(await readFile(counter, 'utf8'), 'AB')
  const gate = first.gate
  await writeFile(path.join(gate.path, 'beta.txt'), 'good')
  await git(gate.path, 'add', 'beta.txt'); await git(gate.path, 'commit', '-qm', 'repair beta only')
  const repaired = await finalizeIntegration({ targetRoot: gate.path, token: gate.token, repair: true })
  assert.equal(repaired.ok, true, JSON.stringify(repaired))
  assert.equal(await readFile(counter, 'utf8'), 'ABB')
  assert.equal(repaired.gate.token, gate.token); assert.equal(repaired.gate.base, gate.base); assert.equal(repaired.gate.deadline, gate.deadline)
  assert.equal(repaired.gate.attempts, 2); assert.equal(repaired.gate.maxAttempts, 2)
  assert.deepEqual(repaired.gate.checks[0].checks.map(({ id, status }) => [id, status]), [['alpha', 'cached'], ['beta', 'passed']])
})

test('required unit acceptance is not silently dropped or turned into integration-stage success', async (t) => {
  const { root } = await project(t)
  const result = await finalizeIntegration({ targetRoot: root, tag: 'unitac01', agentChecks: [agent({ stage: 'unit', required: true })] })
  assert.equal(result.reason, 'waiting-unit-agent')
  const state = await (await openIntegration(await vibeSession({ targetRoot: root }))).read()
  assert.equal(state.state.gate, null)
  assert.equal(Object.values(state.state.participants)[0].status, 'working')
  assert.equal(await git(root, 'show', 'delivery:spec/SETTINGS.md').catch(() => ''), '')
})

test('CI-only explicit plan has no synthesized local batch or browser execution', async (t) => {
  const { root } = await project(t, { plan: { schemaVersion: 1, checks: [{ id: 'compatibility', tier: 'ci', command: 'node --version' }] } })
  const result = await finalizeIntegration({ targetRoot: root, tag: 'cionly01' })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.deepEqual(result.gate.checks, [])
})

test('candidate spec structure and open design still prevent actual default landing', async (t) => {
  const { root } = await project(t)
  await writeFile(path.join(root, 'spec/STATE.md'), '# invalid state\n')
  await git(root, 'add', 'spec/STATE.md'); await git(root, 'commit', '-qm', 'invalid state')
  const before = await git(root, 'rev-parse', 'delivery')
  const result = await finalizeIntegration({ targetRoot: root, tag: 'specfail' })
  assert.equal(result.reason, 'integration-failed')
  assert.equal(result.gate.checks[0].command, 'spec close')
  assert.equal(await git(root, 'rev-parse', 'delivery'), before)
  const other = await project(t)
  await writeInteractive(await inspectWorkspace({ targetRoot: other.root }), { design: { tag: 'design01' } })
  await assert.rejects(finalizeIntegration({ targetRoot: other.root, tag: 'design01' }), /디자인/)
})

test('old candidate observations cannot be relabeled as the current candidate even through the primitive API', async (t) => {
  const { root } = await project(t)
  const waiting = await finalizeIntegration({ targetRoot: root, tag: 'agent001', agentChecks: [agent()] })
  assert.equal(waiting.reason, 'waiting-agent')
  const store = await openIntegration(await vibeSession({ targetRoot: root }))
  const stale = waiting.gate.agentChecks.map((entry) => ({ ...entry, status: 'pass', candidate: 'b'.repeat(40), observed: 'Old view', evidence: ['old.png'], reason: '' }))
  assert.equal((await store.accept({ token: waiting.gate.token, candidate: waiting.gate.candidate, checks: stale })).reason, 'acceptance-candidate-mismatch')
  assert.equal((await store.read()).state.gate.phase, 'waiting-agent')
})

test('active idle display fields cannot impersonate the durable ready participant identity', async (t) => {
  const { root } = await project(t), context = await vibeSession({ targetRoot: root }), store = await openIntegration(context)
  const ready = await store.ready({ tag: 'owner001', host: 'same-host' }), participant = ready.state.participants[ready.value.id]
  const unknown = { tag: participant.tag, branch: participant.branch, host: participant.host, commit: participant.head, doing: '-' }
  assert.equal((await store.claim({ tag: 'owner001', active: [unknown] })).reason, 'unregistered-sessions')
  const claimed = await store.claim({ tag: 'owner001', active: [{ ...unknown, session: participant.id }] })
  assert.equal(claimed.ok, true)
})

test('upgraded presence carries the exact participant ID through beat and ready mapping', async (t) => {
  const { root } = await project(t)
  const beat = await vibeBeat({ targetRoot: root, tag: 'owner001', mode: 'pair' })
  assert.match(beat.row.session, /^[a-f0-9]{24}$/)
  const result = await finalizeIntegration({ targetRoot: root, tag: 'owner001' })
  assert.equal(result.ok, true, JSON.stringify(result))
})

test('fixed land permits an ordinary child; ambiguous commit-only default requires an owned linked session', async (t) => {
  const { root } = await project(t)
  await assertImplementationWorkspace({ targetRoot: root })
  await writeFile(path.join(root, 'spec/SETTINGS.md'), '# SETTINGS\n- land: current\n- plan: planning\n')
  await git(root, 'add', '.'); await git(root, 'commit', '-qm', 'commit-only planning')
  await assert.rejects(assertImplementationWorkspace({ targetRoot: root }), /하위 작업 브랜치/)
  const child = await prepareSessionWorkspace({ targetRoot: root, tag: 'owned001' })
  await assertImplementationWorkspace({ targetRoot: child.root, requireLinked: true })
})

test('version auto is prepared on the fixed candidate before its one actual command and returned to the caller', async (t) => {
  const { root } = await project(t, { version: true })
  const file = path.join(root, 'spec/ssot/ARCH.md')
  await writeFile(file, (await readFile(file, 'utf8')).replace('batch: `node --version`', 'batch: `' + node("if(require('./package.json').version!=='1.0.1')process.exit(1)") + '`'))
  await git(root, 'add', '.'); await git(root, 'commit', '-qm', 'check bumped candidate')
  const result = await finalizeIntegration({ targetRoot: root, tag: 'version1' })
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.version.to, '1.0.1')
  assert.equal(JSON.parse(await git(root, 'show', 'delivery:package.json')).version, '1.0.1')
  assert.equal((await finalizeIntegration({ targetRoot: root, tag: 'version1' })).alreadyLanded, true)
})
