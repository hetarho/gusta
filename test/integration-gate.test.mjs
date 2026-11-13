import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, readFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { machines, git } from './helpers/vibe-fixture.mjs'
import { inspectWorkspace } from '../src/workspace.mjs'
import { runtimeRoot } from '../src/work-runtime.mjs'
import { openIntegration } from '../src/integration-gate.mjs'
import { finalizeIntegration, vibeIntegration } from '../src/integration-run.mjs'
import { runVibeCheck } from '../src/vibe-check.mjs'

async function setup(t, { push = true } = {}) {
  const fixture = await machines(t)
  await git(fixture.a, 'branch', 'delivery')
  await git(fixture.a, 'push', '-q', 'origin', 'delivery')
  const roots = [fixture.a, fixture.b], contexts = [], stores = []
  for (const [index, root] of roots.entries()) {
    await git(root, 'switch', '-qc', `work-${index}`)
    await writeFile(path.join(root, `feature-${index}.js`), `export const value = ${index}\n`)
    await git(root, 'add', '-A'); await git(root, 'commit', '-qm', `feature ${index}`)
    const workspace = await inspectWorkspace({ targetRoot: root })
    const context = { root, branch: workspace.git.branch, workspace, runtime: runtimeRoot(workspace), remote: 'origin', branches: { coord: 'session-ledger', coordPush: true, land: 'delivery', push, via: 'merge' } }
    contexts.push(context); stores.push(await openIntegration(context))
  }
  return { ...fixture, contexts, stores }
}

test('two remote coordinators elect one owner only after every registered session is explicitly ready', async (t) => {
  const { stores: [first, second], contexts } = await setup(t)
  await first.register({ tag: 'same', host: 'same-host' })
  await second.register({ tag: 'same', host: 'same-host' })
  await second.ready({ tag: 'same', host: 'same-host' })
  assert.equal((await second.claim({ tag: 'same' })).reason, 'sessions-working')
  await first.ready({ tag: 'same', host: 'same-host' })
  const claims = await Promise.all([first.claim({ tag: 'same' }), second.claim({ tag: 'same' })])
  assert.equal(claims.filter((entry) => entry.ok).length, 1)
  assert.equal(claims.find((entry) => !entry.ok).reason, 'integration-owned')
  const gate = claims.find((entry) => entry.ok).value.gate
  assert.equal(gate.cohort.length, 2)
  await git(contexts[1].root, 'switch', '-qc', 'next-work')
  const next = await openIntegration({ ...contexts[1], branch: 'next-work' })
  await next.register({ tag: 'next' })
  assert.equal((await first.read()).state.gate.cohort.length, 2)
  assert.equal(Object.values((await first.read()).state.participants).filter((entry) => entry.status === 'working').length, 1)
})

test('same tag, hostname and branch in separate clones cannot overwrite participant identity', async (t) => {
  const { contexts } = await setup(t)
  const stores = []
  for (const context of contexts) {
    await git(context.root, 'branch', 'same-work')
    stores.push(await openIntegration({ ...context, branch: 'same-work' }))
  }
  await stores[0].register({ tag: 'same', host: 'same-host' })
  await stores[1].register({ tag: 'same', host: 'same-host' })
  const participants = Object.values((await stores[0].read()).state.participants)
  assert.equal(participants.length, 2)
  assert.notEqual(participants[0].owner, participants[1].owner)
})

test('old working presence and unavailable remote never become proof of all-ready', async (t) => {
  const { contexts: [context], stores: [store] } = await setup(t)
  const old = await openIntegration(context, { now: () => '2000-01-01T00:00:00Z' })
  await old.register({ tag: 'old' })
  assert.equal((await store.claim({ tag: 'later', active: [] })).reason, 'sessions-working')
  const unavailable = await openIntegration(context, { remote: async () => { throw new Error('network unavailable') } })
  const state = await unavailable.read()
  assert.equal(state.reason, 'coordination-unknown')
  assert.equal(state.scope, 'remote')
})

test('an authority branch with other files is refused without changing the remote', async (t) => {
  const { contexts: [context] } = await setup(t)
  const head = await git(context.root, 'rev-parse', 'HEAD')
  await git(context.root, 'push', '-q', 'origin', `HEAD:refs/heads/session-ledger-integration`)
  const store = await openIntegration(context)
  assert.equal((await store.ready({ tag: 'test' })).reason, 'coordination-unknown')
  assert.match(await git(context.root, 'ls-remote', '--heads', 'origin', 'session-ledger-integration'), new RegExp(`^${head}`))
})

test('candidate combines exact announced heads; a later branch tip is not substituted', async (t) => {
  const { stores: [first, second], contexts } = await setup(t)
  await first.ready({ tag: 'aaaa' }); await second.ready({ tag: 'bbbb' })
  const announced = await git(contexts[0].root, 'rev-parse', 'HEAD')
  await writeFile(path.join(contexts[0].root, 'later.js'), 'export const later = true\n')
  await git(contexts[0].root, 'add', 'later.js'); await git(contexts[0].root, 'commit', '-qm', 'later branch input')
  await git(contexts[0].root, 'push', '-q', 'origin', 'work-0')
  const claimed = await second.claim({ tag: 'bbbb' })
  assert.equal(claimed.ok, true)
  assert.ok(claimed.value.gate.cohort.some((entry) => entry.head === announced))
  const candidate = await second.candidate(claimed.value.gate.token)
  assert.equal(candidate.ok, true)
  assert.equal(await readFile(path.join(candidate.root, 'feature-0.js'), 'utf8'), 'export const value = 0\n')
  assert.equal(await readFile(path.join(candidate.root, 'feature-1.js'), 'utf8'), 'export const value = 1\n')
  await assert.rejects(readFile(path.join(candidate.root, 'later.js')), { code: 'ENOENT' })
  await second.checked(candidate.gate.token, [{ ok: true, command: 'deterministic gate' }])
  const completed = await second.complete({ token: candidate.gate.token, candidate: candidate.gate.candidate })
  assert.equal(completed.ok, true)
  assert.match(await git(contexts[0].root, 'ls-remote', '--heads', 'origin', 'delivery'), new RegExp(`^${candidate.gate.candidate}`))
  assert.equal((await first.read()).state.gate, null)
})

test('outside target movement refuses publication and keeps checked candidate without a second full run', async (t) => {
  const { stores: [first, second], contexts } = await setup(t)
  await first.ready({ tag: 'aaaa' }); await second.ready({ tag: 'bbbb' })
  const claimed = await first.claim({ tag: 'aaaa' }), candidate = await first.candidate(claimed.value.gate.token)
  await first.checked(candidate.gate.token, [{ ok: true, command: 'once' }])
  await git(contexts[1].root, 'push', '-q', 'origin', 'HEAD:delivery')
  const completed = await first.complete({ token: candidate.gate.token, candidate: candidate.gate.candidate })
  assert.equal(completed.reason, 'land-moved')
  assert.equal(completed.automaticRecheck, false)
  const after = await first.read()
  assert.equal(after.state.gate.phase, 'verified')
  assert.equal(after.state.gate.checks.length, 1)
})

test('full deterministic coverage is retained while exact-candidate computer-use acceptance is handed to a capable host', async (t) => {
  const { a, temporary } = await machines(t)
  await git(a, 'branch', 'delivery'); await git(a, 'push', '-q', 'origin', 'delivery')
  await git(a, 'switch', '-qc', 'work-acceptance')
  await writeFile(path.join(a, 'spec/SETTINGS.md'), '# SETTINGS\n- land: delivery\n- push: true\n- coord: session-ledger\n')
  await writeFile(path.join(a, 'spec/ssot/ARCH.md'), '# ARCH Architecture\n> r1 | Architecture\n\n## decisions\n- ARCH-1 [o] Verification.\n  - task: `node --version`.\n  - batch: `node --version`.\n  - CI: workflow.\n\n## chg\n- r1 261101 initial\n')
  await git(a, 'add', 'spec'); await git(a, 'commit', '-qm', 'verification policy')
  const checks = [{ id: 'primary-flow', scenario: 'Open the view', steps: ['Open the candidate'], expected: 'The view renders', status: 'not-run', reason: 'Requires a computer-use host', replaces: ['old-browser-flow'] }]
  let runs = 0
  const check = async (options, command) => { runs++; return runVibeCheck(options, command) }
  const waiting = await finalizeIntegration({ targetRoot: a, tag: 'agent001', agentChecks: checks }, { check })
  assert.equal(waiting.reason, 'waiting-agent')
  assert.equal(runs, 1)
  const evidence = waiting.gate.agentChecks.map((entry) => ({ ...entry, candidate: waiting.gate.candidate, status: 'pass', observed: 'The candidate view rendered', evidence: ['screenshot.png'], reason: '' }))
  const file = path.join(temporary, 'acceptance.json')
  await writeFile(file, JSON.stringify({ token: waiting.gate.token, candidate: waiting.gate.candidate, checks: evidence }))
  const accepted = await vibeIntegration({ targetRoot: a, step: 'accept', file })
  assert.equal(accepted.ok, true)
  const completed = await finalizeIntegration({ targetRoot: a, tag: 'agent001' }, { check })
  assert.equal(completed.ok, true)
  assert.equal(runs, 1)
})
