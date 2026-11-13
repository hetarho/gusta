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
