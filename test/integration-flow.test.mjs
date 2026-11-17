import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fixture, git, machines, execute } from './helpers/vibe-fixture.mjs'
import { finalizeIntegration, vibeIntegration, openSessionWorkspace } from '../src/integration-run.mjs'
import { openIntegration } from '../src/integration-gate.mjs'
import { vibeSession, vibeBeat, vibePush } from '../src/vibe.mjs'
import { validateAgentAcceptance } from '../src/agent-acceptance.mjs'
import { assertImplementationWorkspace, prepareSessionWorkspace } from '../src/session-workspace.mjs'
import { writeInteractive } from '../src/interactive-state.mjs'
import { inspectWorkspace } from '../src/workspace.mjs'
import { fileURLToPath } from 'node:url'
import { startWork, finishWork, inspectWork } from '../src/work-groups.mjs'
import { runWork } from '../src/work-runner.mjs'
import { vibeLoop } from '../src/vibe-loop.mjs'
import { vibeTask } from '../src/vibe-task.mjs'

const shell = (value) => `'${value.replaceAll("'", "'\\''")}'`
const node = (code) => `node -e ${shell(code)}`
async function project(t, { plan, version = false, count = 0 } = {}) {
  const value = await fixture(t, count), { root } = value
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

test('failed named check repairs reuse valid successes and keep the same token/base/deadline', async (t) => {
  const initial = await fixture(t, 0), counter = path.join(initial.temporary, 'counter')
  // Use the project helper's clean Git checkout while keeping the counter outside its tree.
  const plan = { schemaVersion: 1, checks: [
    { id: 'alpha', tier: 'batch', inputs: ['alpha.txt'], command: node(`require('node:fs').appendFileSync(${JSON.stringify(counter)},'A')`) },
    { id: 'beta', tier: 'batch', inputs: ['beta.txt'], command: node(`const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(counter)},'B');if(fs.readFileSync('beta.txt','utf8')!=='good')process.exit(1)`) },
  ] }
  const { root } = await project(t, { plan })
  await writeFile(path.join(root, 'alpha.txt'), 'stable'); await writeFile(path.join(root, 'beta.txt'), 'bad')
  await git(root, 'add', '.'); await git(root, 'commit', '-qm', 'verification inputs')
  const first = await finalizeIntegration({ targetRoot: root, tag: 'repair01' })
  assert.equal(first.reason, 'integration-failed')
  assert.equal(await readFile(counter, 'utf8'), 'AB')
  const gate = first.gate
  await writeFile(path.join(gate.path, 'beta.txt'), 'good')
  await git(gate.path, 'add', 'beta.txt'); await git(gate.path, 'commit', '-qm', 'repair beta only')
  const repaired = await finalizeIntegration({ targetRoot: gate.path, token: gate.token, repair: true })
  assert.equal(repaired.ok, true, JSON.stringify(repaired))
  assert.equal(await readFile(counter, 'utf8'), 'ABB')
  assert.equal(repaired.gate.token, gate.token); assert.equal(repaired.gate.base, gate.base); assert.equal(repaired.gate.deadline, gate.deadline)
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
  const unknown = { tag: participant.tag, branch: participant.branch, host: participant.host, commit: participant.head, doing: '-', at: new Date().toISOString().slice(0, 16) + 'Z' }
  const refused = await store.claim({ tag: 'owner001', active: [unknown] })
  assert.equal(refused.reason, 'unregistered-sessions')
  assert.deepEqual(refused.participants, [{ tag: participant.tag, branch: participant.branch, cause: 'no matching participant' }])
  assert.match(refused.nextAction, /vibe integration ready --tag <tag>/)
  assert.equal((await store.claim({ tag: 'owner001', active: [{ ...unknown, session: participant.id, doing: 'T001' }] })).participants[0].cause, 'doing T001')
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

test('two real session-open CLI calls announce work before any beat, and empty close unblocks the one fixed gate', async (t) => {
  const { a, b, temporary } = await machines(t), counter = path.join(temporary, 'opened-counter')
  await writeFile(path.join(a, 'spec/SETTINGS.md'), '# SETTINGS\n- land: delivery\n- push: true\n- coord: session-ledger\n')
  await writeFile(path.join(a, 'spec/ssot/ARCH.md'), '# ARCH Architecture\n> r1 | Architecture\n\n## decisions\n- ARCH-1 [o] Verification.\n  - task: `node --version`.\n  - batch: `' + node(`require('node:fs').appendFileSync(${JSON.stringify(counter)},'X')`) + '`.\n  - CI: workflow.\n\n## chg\n- r1 261101 initial\n')
  await git(a, 'add', '.'); await git(a, 'commit', '-qm', 'shared policy')
  await git(a, 'branch', 'delivery'); await git(a, 'push', '-q', 'origin', 'HEAD:main', 'delivery')
  await git(b, 'fetch', '-q', 'origin'); await git(b, 'merge', '--ff-only', '-q', 'origin/main')
  const cli = fileURLToPath(new URL('../bin/gusta.mjs', import.meta.url))
  const call = async (root, ...args) => JSON.parse((await execute(process.execPath, [cli, 'vibe', ...args, '--target', root], { encoding: 'utf8' })).stdout)
  const first = await call(a, 'session', 'open', '--kind', 'self-improve', '--tag', 'opened01')
  const second = await call(b, 'session', 'open', '--kind', 'self-improve', '--tag', 'opened02')
  const state = await (await openIntegration(await vibeSession({ targetRoot: first.root }))).read()
  assert.equal(Object.values(state.state.participants).filter((entry) => entry.status === 'working').length, 2)
  const blocked = await finalizeIntegration({ targetRoot: first.root, tag: 'opened01' })
  assert.equal(blocked.reason, 'sessions-working')
  await assert.rejects(readFile(counter), { code: 'ENOENT' })
  const closed = await call(second.root, 'integration', 'close', '--tag', 'opened02')
  assert.equal(closed.value.status, 'withdrawn')
  const completed = await finalizeIntegration({ targetRoot: first.root, tag: 'opened01' })
  assert.equal(completed.ok, true, JSON.stringify(completed))
  assert.equal(await readFile(counter, 'utf8'), 'X')
})

test('nested worker acceptance and required group commands are handed to the owning session without an extra full gate', async (t) => {
  const { root, temporary } = await project(t, { count: 1 }), counter = path.join(temporary, 'nested-counter')
  const parent = await openSessionWorkspace({ targetRoot: root, kind: 'self-improve', tag: 'parent01' })
  const command = node(`require('node:fs').appendFileSync(${JSON.stringify(counter)},'G')`)
  const group = await startWork({ targetRoot: parent.root, name: 'nested', groupVerify: [command] })
  const adapterFile = path.join(temporary, 'worker.mjs'), config = path.join(temporary, 'worker.json')
  await writeFile(adapterFile, `import fs from 'node:fs';import path from 'node:path';import {execFileSync} from 'node:child_process';
let input='';for await(const chunk of process.stdin)input+=chunk;const job=JSON.parse(input);
if(job.role==='worker'){
const name=fs.readdirSync('spec/tasks').find(name=>name.startsWith(job.taskId+'.'));
const file=path.join('spec/tasks',name);fs.writeFileSync(file,fs.readFileSync(file,'utf8').replaceAll('- [ ]','- [v]')+'- outcome: implemented\\n- at: -\\n- verified: affected checks\\n- limits: -\\n');
fs.mkdirSync('src',{recursive:true});fs.writeFileSync('src/result.txt','done');execFileSync('git',['add','.']);execFileSync('git',['commit','-qm','worker complete']);
console.log(JSON.stringify({outcome:'completed',summary:'done',agentChecks:[${JSON.stringify(agent())}]}));
}else console.log(JSON.stringify({verdict:'approved',summary:'reviewed',findings:[]}));`)
  await writeFile(config, JSON.stringify({ command: process.execPath, args: [adapterFile] }))
  const run = await runWork({ targetRoot: parent.root, work: group.id, adapter: config, verify: ['node --version'], groupVerify: [command] })
  assert.equal(run.outcome, 'completed', JSON.stringify(run))
  await assert.rejects(readFile(counter), { code: 'ENOENT' })
  const current = (await inspectWork({ targetRoot: parent.root })).groups.find((entry) => entry.id === group.id)
  assert.equal(current.agentChecks.length, 1)
  assert.equal(current.ready.verified, false)
  const store = await openIntegration(await vibeSession({ targetRoot: parent.root })), before = await store.read()
  assert.equal(Object.values(before.state.participants).length, 1)
  assert.equal(Object.values(before.state.participants)[0].status, 'working')
  assert.ok(Object.values(before.state.participants)[0].verificationCommands.includes(command))
  const final = await finalizeIntegration({ targetRoot: parent.root, tag: 'parent01' })
  assert.equal(final.reason, 'waiting-agent', JSON.stringify(final))
  assert.equal(final.gate.agentChecks.length, 1)
  assert.equal(await readFile(counter, 'utf8'), 'G')
})

for (const publication of [
  { push: true, via: 'merge', name: 'a PR-only participant cannot be directly landed by an ordinary merge coordinator' },
  { push: false, via: 'pr', name: 'configured PR strategy permits working branch publication with direct push disabled' },
]) test(`${publication.name}; post-merge reconciliation does not recheck`, async (t) => {
  const { root, temporary } = await project(t), remote = path.join(temporary, 'origin.git')
  await execute('git', ['init', '--bare', '-q', remote])
  await git(root, 'remote', 'add', 'origin', remote); await git(root, 'push', '-q', 'origin', 'delivery')
  await writeFile(path.join(root, 'spec/SETTINGS.md'), `# SETTINGS\n- land: delivery\n- push: ${publication.push}\n- land-via: ${publication.via}\n- coord: session-ledger\n`)
  await git(root, 'add', '.'); await git(root, 'commit', '-qm', 'published session policy')
  const original = (await git(root, 'ls-remote', '--heads', 'origin', 'delivery')).split(/\s/)[0]
  const proposal = await openSessionWorkspace({ targetRoot: root, kind: 'self-improve-remote', tag: 'remote01' })
  const ordinary = await openSessionWorkspace({ targetRoot: root, kind: 'start', tag: 'normal01' })
  await vibeIntegration({ targetRoot: proposal.root, step: 'ready', tag: 'remote01' })
  let prs = 0
  const pr = async () => { prs++; return { pr: 'https://example.invalid/pull/1' } }
  const waiting = await finalizeIntegration({ targetRoot: ordinary.root, tag: 'normal01' }, { pr })
  assert.equal(waiting.reason, 'waiting-pr', JSON.stringify(waiting)); assert.equal(waiting.gate.via, 'pr')
  assert.equal((await git(root, 'ls-remote', '--heads', 'origin', 'delivery')).split(/\s/)[0], original)
  const store = await openIntegration(await vibeSession({ targetRoot: ordinary.root }))
  assert.equal((await store.complete({ token: waiting.gate.token, candidate: waiting.gate.candidate })).reason, 'pr-required')
  await git(waiting.gate.path, 'push', '-q', 'origin', `${waiting.gate.candidate}:refs/heads/delivery`)
  const settled = await finalizeIntegration({ targetRoot: ordinary.root, tag: 'normal01' }, { pr })
  assert.equal(settled.ok, true, JSON.stringify(settled)); assert.equal(prs, 1)
  assert.equal(settled.gate.rounds.length, 1)
})

test('the default isolated loop observes its exact published CI failure once and reports pending repair', async (t) => {
  const { root, temporary } = await project(t, { count: 1 }), remote = path.join(temporary, 'ci-origin.git')
  await execute('git', ['init', '--bare', '-q', remote]); await git(root, 'remote', 'add', 'origin', remote)
  await git(root, 'push', '-q', 'origin', 'delivery')
  await writeFile(path.join(root, 'spec/SETTINGS.md'), '# SETTINGS\n- land: delivery\n- push: true\n- coord: session-ledger\n')
  await git(root, 'add', '.'); await git(root, 'commit', '-qm', 'CI publication')
  let calls = 0
  const result = await vibeLoop({ targetRoot: root, tag: 'cifail01', provider: 'codex', maxUnits: 1 }, {
    preflight: async () => ({ ok: true, checks: [] }),
    execute: async (options, job) => {
      const id = job.brief.taskId, source = options.targetRoot
      await vibeTask({ targetRoot: source, tag: options.tag, task: id, step: 'start' })
      const file = path.join(source, 'spec/tasks', `${id}.example.md`)
      await writeFile(file, (await readFile(file, 'utf8')).replaceAll('- [ ]', '- [v]').replace(/## result\n*$/, '## result\n- outcome: implemented\n- at: -\n- verified: affected check\n- limits: -\n'))
      await writeFile(path.join(source, 'feature.txt'), 'done')
      await vibeTask({ targetRoot: source, tag: options.tag, task: id, step: 'done' })
      await git(source, 'add', '.'); await git(source, 'commit', '-qm', 'implementation complete')
      return { exitCode: 0, result: { kind: 'task', id, outcome: 'completed', pushed: false, next: '' } }
    },
    ci: async (options) => {
      calls++; assert.equal(options.branch, 'delivery')
      assert.equal((await git(root, 'ls-remote', '--heads', 'origin', 'delivery')).split(/\s/)[0], options.commit)
      return { ok: false, outcome: 'failed', commit: options.commit, runUrl: 'https://example.invalid/check/1', jobs: [{ name: 'supported-browser', conclusion: 'failure' }], ms: 1 }
    },
  })
  assert.equal(calls, 1, JSON.stringify(result))
  assert.equal(result.ok, false); assert.equal(result.integration.ci.ok, false)
  assert.equal(result.integration.gate.rounds.length, 1)
  assert.ok(result.priorityTask)
  assert.match(await readFile(path.join(result.sessionWorkspace.root, result.report), 'utf8'), /CI .*failed/)
})

test('default vibe push --wait-ci cannot return success after the published candidate CI fails', async (t) => {
  const { root, temporary } = await project(t), remote = path.join(temporary, 'wait-origin.git')
  await execute('git', ['init', '--bare', '-q', remote]); await git(root, 'remote', 'add', 'origin', remote); await git(root, 'push', '-q', 'origin', 'delivery')
  await writeFile(path.join(root, 'spec/SETTINGS.md'), '# SETTINGS\n- land: delivery\n- push: true\n- coord: session-ledger\n')
  await git(root, 'add', '.'); await git(root, 'commit', '-qm', 'CI publication')
  let calls = 0
  const result = await vibePush({ targetRoot: root, waitCi: true }, { ci: async (options) => { calls++; return { ok: false, outcome: 'failed', commit: options.commit } } })
  assert.equal(calls, 1); assert.equal(result.ok, false); assert.equal(result.ci.ok, false)
})

test('a legacy CI-only command handed off by a group is deferred and remains a visible CI obligation', async (t) => {
  const { root, temporary } = await project(t), marker = path.join(temporary, 'ci-only-counter')
  const command = node(`require('node:fs').appendFileSync(${JSON.stringify(marker)},'X')`)
  const arch = path.join(root, 'spec/ssot/ARCH.md')
  await writeFile(arch, (await readFile(arch, 'utf8')).replace('  - CI: workflow.', `  - CI: remote checks.\n    - \`${command}\``))
  await git(root, 'add', '.'); await git(root, 'commit', '-qm', 'CI-only coverage')
  const result = await finalizeIntegration({ targetRoot: root, tag: 'cidefer1', verify: [command] })
  assert.equal(result.ok, true, JSON.stringify(result))
  await assert.rejects(readFile(marker), { code: 'ENOENT' })
  assert.ok(result.gate.ciCommands.includes(command))
  assert.equal(result.ci.outcome, 'pending')
})

test('an ended session never holds the gate: no work withdraws it, work defers it to a later integration it rejoins with ready', async (t) => {
  const { root } = await project(t)
  const open = (tag) => openSessionWorkspace({ targetRoot: root, kind: 'start', tag })
  const first = await open('first001'), second = await open('second01'), third = await open('third001')
  // Ending with nothing changed withdraws the participant (it used to stay working for good).
  assert.equal((await vibeBeat({ targetRoot: second.root, tag: 'second01', end: true })).integration.status, 'withdrawn')
  // Ending with work pauses it: it is deferred, not waited for, and keeps its branch.
  await writeFile(path.join(third.root, 'third.txt'), 'third\n'); await git(third.root, 'add', '.'); await git(third.root, 'commit', '-qm', 'third work')
  const thirdHead = (await git(third.root, 'rev-parse', 'HEAD')).trim()
  assert.equal((await vibeBeat({ targetRoot: third.root, tag: 'third001', end: true })).integration.status, 'paused')
  const landed = await finalizeIntegration({ targetRoot: first.root, tag: 'first001' })
  assert.equal(landed.ok, true, JSON.stringify(landed))
  assert.deepEqual(landed.gate.deferred.map((entry) => [entry.tag, entry.reason]), [['third001', 'session-ended']])
  assert.equal(landed.gate.cohort.some((entry) => entry.tag === 'third001'), false)
  assert.equal((await git(third.root, 'rev-parse', 'HEAD')).trim(), thirdHead)
  // The landed session stays live and idle: its row is not an unregistered session for the next gate.
  await vibeBeat({ targetRoot: first.root, tag: 'first001', mode: 'pair' })
  const rejoined = await vibeIntegration({ targetRoot: third.root, step: 'ready', tag: 'third001' })
  assert.equal(rejoined.ok, true, JSON.stringify(rejoined))
  const next = await finalizeIntegration({ targetRoot: third.root, tag: 'third001' })
  assert.equal(next.ok, true, JSON.stringify(next))
  assert.equal((await git(root, 'merge-base', '--is-ancestor', thirdHead, 'delivery').catch(() => 'no')), '')
})

test('a live working session is waited for; one with no signal for the stale window is deferred, and its owner can still withdraw it', async (t) => {
  const { root } = await project(t)
  const first = await openSessionWorkspace({ targetRoot: root, kind: 'start', tag: 'live0001' })
  const away = await openSessionWorkspace({ targetRoot: root, kind: 'start', tag: 'away0001' })
  const blocked = await finalizeIntegration({ targetRoot: first.root, tag: 'live0001' })
  assert.equal(blocked.reason, 'sessions-working')
  assert.deepEqual(blocked.participants.map((entry) => [entry.tag, entry.status]), [['away0001', 'working']])
  assert.match(blocked.nextAction, /vibe integration withdraw --participant <id>/)
  // The other device went to sleep: its record has not moved for longer than the stale window.
  const store = await openIntegration(await vibeSession({ targetRoot: root }))
  const id = Object.values((await store.read()).state.participants).find((entry) => entry.tag === 'away0001').id
  await store.transaction((state) => { state.participants[id].at = new Date(Date.now() - 3 * 3600000).toISOString(); return { id } })
  const landed = await finalizeIntegration({ targetRoot: first.root, tag: 'live0001' })
  assert.equal(landed.ok, true, JSON.stringify(landed))
  assert.deepEqual(landed.gate.deferred.map((entry) => [entry.tag, entry.reason]), [['away0001', 'no-signal']])
  assert.equal((await store.read()).state.participants[id].status, 'working')
  // Its recorded head is the shared start, which the landing carried: withdrawing records it landed, unverified.
  const withdrawn = await vibeIntegration({ targetRoot: root, step: 'withdraw', participant: id })
  assert.deepEqual([withdrawn.value.status, withdrawn.value.contained], ['landed', true])
})

test('withdrawing a participant whose head land already holds records it landed outside the gate, unverified', async (t) => {
  const { root } = await project(t)
  const session = await openSessionWorkspace({ targetRoot: root, kind: 'start', tag: 'outside1' })
  const head = (await git(session.root, 'rev-parse', 'HEAD')).trim()
  // Its work reached land without the gate (a direct fast-forward).
  await git(root, 'branch', '-f', 'delivery', head)
  const store = await openIntegration(await vibeSession({ targetRoot: root }))
  const id = Object.values((await store.read()).state.participants).find((entry) => entry.tag === 'outside1').id
  const result = await vibeIntegration({ targetRoot: root, step: 'withdraw', participant: id, reason: 'pushed directly' })
  assert.deepEqual([result.value.status, result.value.contained], ['landed', true])
  const entry = (await store.read()).state.participants[id]
  assert.deepEqual([entry.landed, entry.reconciled.verified, entry.reconciled.reason, entry.reconciled.from], [head, false, 'pushed directly', 'working'])
  assert.equal((await vibeIntegration({ targetRoot: root, step: 'withdraw', participant: 'f'.repeat(24) })).reason, 'participant-unknown')
})

test('vibe push in a session worktree submits under that session tag, not a second participant', async (t) => {
  const { root } = await project(t)
  const session = await openSessionWorkspace({ targetRoot: root, kind: 'start', tag: 'pushtag1' })
  let seen
  await vibePush({ targetRoot: session.root }, { integration: async (options) => { seen = options.tag; return { ok: true } }, assertWorkspace: async () => {} })
  assert.equal(seen, 'pushtag1')
})

test('the fixed candidate lives outside .git and is prepared (ARCH prepare) before its checks', async (t) => {
  const { root } = await project(t)
  await writeFile(path.join(root, '.gitignore'), 'deps/\n')
  const file = path.join(root, 'spec/ssot/ARCH.md')
  await writeFile(file, (await readFile(file, 'utf8')).replace('  - task: `node --version`.\n', '  - prepare: `' + node("require('fs').mkdirSync('deps',{recursive:true});require('fs').writeFileSync('deps/ready','x')") + '`.\n  - task: `node --version`.\n')
    .replace('batch: `node --version`', 'batch: `' + node("require('fs').accessSync('deps/ready')") + '`'))
  await git(root, 'add', '.'); await git(root, 'commit', '-qm', 'checks need prepared dependencies')
  const result = await finalizeIntegration({ targetRoot: root, tag: 'prep0001' })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.match(result.gate.path, /\.gusta-worktrees/); assert.doesNotMatch(result.gate.path, /[\\/]\.git[\\/]/)
})

test('a candidate that cannot be prepared fails as the environment, with no check run against it', async (t) => {
  const { root } = await project(t)
  const counter = path.join(root, '..', 'batch-runs')
  const file = path.join(root, 'spec/ssot/ARCH.md')
  await writeFile(file, (await readFile(file, 'utf8')).replace('  - task: `node --version`.\n', '  - prepare: `' + node('process.exit(4)') + '`.\n  - task: `node --version`.\n')
    .replace('batch: `node --version`', 'batch: `' + node(`require('fs').appendFileSync(${JSON.stringify(counter)},'X')`) + '`'))
  await git(root, 'add', '.'); await git(root, 'commit', '-qm', 'broken prepare')
  const failed = await finalizeIntegration({ targetRoot: root, tag: 'prep0002' })
  assert.equal(failed.reason, 'integration-failed')
  assert.deepEqual([failed.gate.checks[0].command, failed.gate.checks[0].environment, failed.gate.checks.length], ['workspace prepare', true, 1])
  assert.match(failed.nextAction, /ARCH prepare.*not the implementation/)
  await assert.rejects(readFile(counter), { code: 'ENOENT' })
})

test('landing through the shared gate clears the unlanded rows it carries and removes its own candidate', async (t) => {
  const { root } = await project(t, { count: 1 })
  const { readSessions } = await import('../src/coord-doc.mjs')
  const session = await openSessionWorkspace({ targetRoot: root, kind: 'start', tag: 'landed01' })
  await vibeTask({ targetRoot: session.root, tag: 'landed01', task: 'T001', step: 'start' })
  const file = path.join(session.root, 'spec/tasks/T001.example.md')
  await writeFile(file, (await readFile(file, 'utf8')).replaceAll('- [ ]', '- [v]').replace(/## result\n*$/, '## result\n- outcome: implemented\n- at: -\n- verified: affected check\n- limits: -\n'))
  await writeFile(path.join(session.root, 'feature.txt'), 'done\n')
  await vibeTask({ targetRoot: session.root, tag: 'landed01', task: 'T001', step: 'done' })
  await git(session.root, 'add', '.'); await git(session.root, 'commit', '-qm', 'T001 done')
  const unlanded = async () => readSessions(await git(root, 'show', 'session-ledger:SESSIONS.md')).unlanded.map((row) => row.id)
  assert.deepEqual(await unlanded(), ['T001'])
  const result = await finalizeIntegration({ targetRoot: session.root, tag: 'landed01' })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.deepEqual(await unlanded(), [])
  assert.deepEqual(result.coordination.landed, ['T001'])
  assert.ok(result.cleanup.pruned.includes(result.gate.path), JSON.stringify(result.cleanup))
  await assert.rejects(readFile(path.join(result.gate.path, 'feature.txt')), { code: 'ENOENT' })
  assert.equal((await git(root, 'branch', '--list', 'integration/*')).trim(), '')
  // The landed session's worktree and branch go with the next prune from another checkout; a session
  // with work land lacks stays, with the reason.
  const other = await openSessionWorkspace({ targetRoot: root, kind: 'start', tag: 'pending1' })
  await writeFile(path.join(other.root, 'more.txt'), 'more\n'); await git(other.root, 'add', '.'); await git(other.root, 'commit', '-qm', 'not landed')
  const { vibePrune } = await import('../src/prune.mjs')
  assert.ok((await vibePrune({ targetRoot: root })).kept.some((entry) => entry.branch === session.branch && /살아 있는 세션 행/.test(entry.reason)))
  await vibeBeat({ targetRoot: session.root, tag: 'landed01', end: true })
  const swept = await vibePrune({ targetRoot: root })
  assert.ok(swept.pruned.includes(session.root) && swept.pruned.includes(session.branch), JSON.stringify(swept))
  assert.ok(swept.kept.some((entry) => entry.branch === other.branch && /없는 커밋/.test(entry.reason)), JSON.stringify(swept.kept))
  await assert.rejects(readFile(path.join(session.root, 'feature.txt')), { code: 'ENOENT' })
})

test('a gate command the candidate does not have stops the gate as an environment failure', async (t) => {
  const { root } = await project(t)
  const counter = path.join(root, '..', 'later-runs')
  const file = path.join(root, 'spec/ssot/ARCH.md')
  await writeFile(file, (await readFile(file, 'utf8')).replace('  - batch: `node --version`.\n', '  - batch:\n    - `gusta-missing-tool-xyz --run`\n    - `' + node(`require('fs').appendFileSync(${JSON.stringify(counter)},'X')`) + '`\n'))
  await git(root, 'add', '.'); await git(root, 'commit', '-qm', 'tool missing')
  const failed = await finalizeIntegration({ targetRoot: root, tag: 'missing1' })
  assert.equal(failed.reason, 'integration-failed', JSON.stringify(failed))
  assert.deepEqual(failed.gate.checks.map((entry) => [entry.exitCode, entry.environment]), [[127, true]])
  assert.match(failed.nextAction, /command not found/)
  await assert.rejects(readFile(counter), { code: 'ENOENT' })
})

test('finish --no-push lands the verified candidate on the local land only; the next finish publishes it as verified', async (t) => {
  const { root, temporary } = await project(t), remote = path.join(temporary, 'held-origin.git')
  await execute('git', ['init', '--bare', '-q', remote]); await git(root, 'remote', 'add', 'origin', remote)
  await git(root, 'push', '-q', 'origin', 'delivery')
  await writeFile(path.join(root, 'spec/SETTINGS.md'), '# SETTINGS\n- land: delivery\n- push: true\n- coord: session-ledger\n')
  await git(root, 'add', '.'); await git(root, 'commit', '-qm', 'publish to origin')
  const session = await openSessionWorkspace({ targetRoot: root, kind: 'start', tag: 'hold0001' })
  await writeFile(path.join(session.root, 'held.txt'), 'held\n'); await git(session.root, 'add', '.'); await git(session.root, 'commit', '-qm', 'design result')
  const remoteTip = async () => (await git(root, 'ls-remote', '--heads', 'origin', 'delivery')).split(/\s/)[0]
  const before = await remoteTip()
  const held = await finalizeIntegration({ targetRoot: session.root, tag: 'hold0001', noPush: true })
  assert.equal(held.ok, true, JSON.stringify(held))
  assert.deepEqual([held.held, held.pushed, await remoteTip()], [true, null, before])
  assert.equal((await git(root, 'rev-parse', 'delivery')).trim(), held.landed)
  const published = await finalizeIntegration({ targetRoot: session.root, tag: 'hold0001' })
  assert.equal(published.ok, true, JSON.stringify(published))
  assert.equal(await remoteTip(), held.landed)
})

// Field report: an unattended run stuck behind a failed gate that the cohort could not fix.
const commitIn = async (root, file) => { await writeFile(path.join(root, file), `${file}\n`); await git(root, 'add', '.'); await git(root, 'commit', '-qm', file); return git(root, 'rev-parse', 'HEAD') }
const sessionStore = async (root) => openIntegration(await vibeSession({ targetRoot: root }))

test('a --verify command naming one device\'s paths is refused; one an older version recorded on another device is reported not run', async (t) => {
  const { root } = await project(t)
  const npx = 'node /home/someone/.npm/_npx/0a1b2c/node_modules/@haeram/gusta/bin/gusta.mjs lint'
  await assert.rejects(vibeIntegration({ targetRoot: root, step: 'ready', tag: 'local001', verify: [npx] }), (error) => /이 기기에만 있는 경로/.test(error.message) && error.details.includes('/home/someone/.npm/_npx/0a1b2c/node_modules/@haeram/gusta/bin/gusta.mjs'))
  await assert.rejects(vibeIntegration({ targetRoot: root, step: 'finish', tag: 'local001', verify: ['node --import tsx /tmp/check-script.mjs .'] }), /이 기기에만 있는 경로/)
  const away = await openSessionWorkspace({ targetRoot: root, kind: 'start', tag: 'away0001' }), local = await openSessionWorkspace({ targetRoot: root, kind: 'start', tag: 'local001' })
  await commitIn(away.root, 'away.txt'); await commitIn(local.root, 'local.txt')
  // ready --verify records a portable command.
  const recorded = await vibeIntegration({ targetRoot: local.root, step: 'ready', tag: 'local001', verify: ['node --version 2>/dev/null'] })
  assert.ok(recorded.state.participants[recorded.value.id].verificationCommands.includes('node --version 2>/dev/null'))
  // A display label (--host) on this device is not another device: its participant names this machine.
  const awayStore = await sessionStore(away.root), awayId = (await awayStore.ready({ tag: 'away0001', host: 'label-only' })).value.id
  assert.equal((await awayStore.read()).state.participants[awayId].host, 'label-only')
  // An older version on another device stored its own absolute path (its record has no device field).
  await awayStore.transaction((state) => { Object.assign(state.participants[awayId], { host: 'other-device', verificationCommands: [npx] }); delete state.participants[awayId].device; return {} })
  const landed = await finalizeIntegration({ targetRoot: local.root, tag: 'local001' })
  assert.equal(landed.ok, true, JSON.stringify(landed))
  assert.deepEqual(landed.notRun.map((entry) => [entry.command, entry.reason, entry.participants.map((owner) => [owner.tag, owner.device])]), [[npx, 'not-portable', [['away0001', 'other-device']]]])
  assert.deepEqual(landed.gate.cohort.map((entry) => entry.tag).sort(), ['away0001', 'local001'])
})

test('another ready session whose head land already holds is recorded landed before the cohort forms, and its commands do not run', async (t) => {
  const { root, temporary } = await project(t), counter = path.join(temporary, 'contained-runs')
  const done = await openSessionWorkspace({ targetRoot: root, kind: 'start', tag: 'done0001' })
  const doneHead = await commitIn(done.root, 'done.txt')
  await (await sessionStore(done.root)).ready({ tag: 'done0001', verificationCommands: [node(`require('node:fs').appendFileSync(${JSON.stringify(counter)},'X')`)] })
  // Its work reached land outside the gate (fast-forwarded by hand).
  await git(root, 'branch', '-f', 'delivery', doneHead)
  const next = await openSessionWorkspace({ targetRoot: root, kind: 'start', tag: 'next0001' })
  await commitIn(next.root, 'next.txt')
  const landed = await finalizeIntegration({ targetRoot: next.root, tag: 'next0001' })
  assert.equal(landed.ok, true, JSON.stringify(landed))
  assert.deepEqual(landed.gate.cohort.map((entry) => entry.tag), ['next0001'])
  assert.deepEqual(landed.gate.reconciled.map((entry) => [entry.tag, entry.head, entry.landed]), [['done0001', doneHead, doneHead]])
  await assert.rejects(readFile(counter), { code: 'ENOENT' })
  const entry = Object.values((await sessionStore(root).then((store) => store.read())).state.participants).find((item) => item.tag === 'done0001')
  assert.deepEqual([entry.status, entry.reconciled.reason, entry.reconciled.verified, entry.reconciled.from], ['landed', 'head-in-land', false, 'ready'])
  // Its own finish reports it landed, not verified by a gate.
  const own = await finalizeIntegration({ targetRoot: done.root, tag: 'done0001' })
  assert.deepEqual([own.ok, own.alreadyLanded, own.verified], [true, true, false])
})

test('a participant command whose own script is missing on the candidate fails as the environment, not the implementation', async (t) => {
  const { root } = await project(t)
  const failed = await finalizeIntegration({ targetRoot: root, tag: 'absent01', verify: ['node scripts/absent-check.mjs'] })
  assert.equal(failed.reason, 'integration-failed', JSON.stringify(failed))
  const entry = failed.gate.checks.find((check) => check.command === 'node scripts/absent-check.mjs')
  assert.deepEqual([entry.environment, entry.missingTarget], [true, path.join(failed.gate.path, 'scripts/absent-check.mjs')])
  assert.match(failed.nextAction, /missing script\/package.*not the implementation/)
  assert.match(failed.nextAction, new RegExp(`vibe integration abandon --token ${failed.gate.token}`))
})

async function failedCohort(t) {
  const { root } = await project(t)
  const away = await openSessionWorkspace({ targetRoot: root, kind: 'start', tag: 'away0002' }), owner = await openSessionWorkspace({ targetRoot: root, kind: 'start', tag: 'owner002' })
  await commitIn(away.root, 'away.txt'); await commitIn(owner.root, 'owner.txt')
  const awayStore = await sessionStore(away.root)
  const id = (await awayStore.ready({ tag: 'away0002', verificationCommands: [node('process.exit(3)')] })).value.id
  const failed = await finalizeIntegration({ targetRoot: owner.root, tag: 'owner002' })
  assert.equal(failed.reason, 'integration-failed', JSON.stringify(failed))
  const frozen = await vibeIntegration({ targetRoot: root, step: 'withdraw', participant: id })
  assert.equal(frozen.reason, 'candidate-frozen'); assert.match(frozen.nextAction, /vibe integration abandon --token/)
  return { root, owner, id, failed, store: awayStore }
}

test('the owner abandons a failed gate its cohort cannot fix; withdrawing the participant lets the next finish land', async (t) => {
  const { root, owner, id, failed, store } = await failedCohort(t)
  const released = await vibeIntegration({ targetRoot: root, step: 'abandon', token: failed.gate.token, reason: 'participant command fails here' })
  assert.deepEqual([released.ok, released.gate.phase, released.gate.from], [true, 'abandoned', 'failed'])
  assert.match(released.nextAction, /withdraw --participant/)
  assert.equal((await vibeIntegration({ targetRoot: root, step: 'abandon', token: failed.gate.token })).unchanged, true)
  const history = (await store.read()).state.history[0]
  assert.deepEqual([history.token, history.phase, history.checks.length], [failed.gate.token, 'abandoned', failed.gate.checks.length])
  assert.equal((await vibeIntegration({ targetRoot: root, step: 'withdraw', participant: id })).value.status, 'withdrawn')
  const landed = await finalizeIntegration({ targetRoot: owner.root, tag: 'owner002' })
  assert.equal(landed.ok, true, JSON.stringify(landed))
  assert.deepEqual(landed.gate.cohort.map((entry) => entry.tag), ['owner002'])
})

test('a failed gate past its deadline no longer freezes withdraw or finish: it moves to history as expired', async (t) => {
  const { root, owner, id, failed, store } = await failedCohort(t)
  await store.transaction((state) => { state.gate.deadline = new Date(Date.now() - 60000).toISOString(); return {} })
  const late = await finalizeIntegration({ targetRoot: owner.root, tag: 'owner002', token: failed.gate.token, repair: true })
  assert.equal(late.reason, 'integration-deadline'); assert.match(late.nextAction, /vibe integration finish moves this gate to history/)
  const withdrawn = await vibeIntegration({ targetRoot: root, step: 'withdraw', participant: id })
  assert.deepEqual([withdrawn.ok, withdrawn.value.status, withdrawn.value.expired], [true, 'withdrawn', failed.gate.token])
  const expired = (await store.read()).state.history[0]
  assert.deepEqual([expired.token, expired.phase, expired.from, expired.checks.length], [failed.gate.token, 'expired', 'failed', failed.gate.checks.length])
  const landed = await finalizeIntegration({ targetRoot: owner.root, tag: 'owner002' })
  assert.equal(landed.ok, true, JSON.stringify(landed))
  assert.notEqual(landed.gate.token, failed.gate.token)
})

test('finish itself moves an expired failed gate to history and claims a fresh candidate', async (t) => {
  const { owner, failed, store } = await failedCohort(t)
  await store.transaction((state) => { state.gate.deadline = new Date(Date.now() - 60000).toISOString(); return {} })
  // The participant's command still fails: a fresh gate with a new deadline, not the stuck one.
  const again = await finalizeIntegration({ targetRoot: owner.root, tag: 'owner002' })
  assert.equal(again.reason, 'integration-failed', JSON.stringify(again))
  assert.notEqual(again.gate.token, failed.gate.token)
  assert.deepEqual((await store.read()).state.history.map((entry) => [entry.token, entry.phase]), [[failed.gate.token, 'expired']])
})
