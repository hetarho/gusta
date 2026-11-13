import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fixture, git, execute, archiveTask } from './helpers/vibe-fixture.mjs'
import { runVibeCheck } from '../src/vibe-check.mjs'
import { readVerification, vibeBrief } from '../src/vibe-brief.mjs'
import { vibeLoop } from '../src/vibe-loop.mjs'
import { lintSpec } from '../src/spec-lint.mjs'
import { readGates, gateCount } from '../src/gate-ledger.mjs'
import { vibePush } from '../src/vibe.mjs'

const cli = fileURLToPath(new URL('../bin/gusta.mjs', import.meta.url))
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`
const node = (code) => `${quote(process.execPath)} -e ${quote(code)}`
const planFile = 'verification.json'

async function planned(t, checks) {
  const context = await fixture(t, 1)
  await writeFile(path.join(context.root, planFile), JSON.stringify({ schemaVersion: 1, checks }))
  await writeFile(path.join(context.root, 'spec/ssot/ARCH.md'), context.arch.replace(/  - task,[\s\S]*?(?=\n## chg)/, `  - plan: \`${planFile}\`.\n`))
  await git(context.root, 'add', '-A'); await git(context.root, 'commit', '-qm', 'declare check plan')
  return { ...context, revision: await git(context.root, 'rev-parse', 'HEAD') }
}

test('named checks persist successful siblings, resume in a fresh CLI and reuse explicit inputs after a docs-only commit', async (t) => {
  const { root, temporary, initial } = await planned(t, [
    { id: 'alpha', tier: 'batch', command: node('require("fs").appendFileSync(process.env.COUNTER,"alpha\\n")'), inputs: ['alpha.js'] },
    { id: 'beta', tier: 'batch', command: node('const fs=require("fs");fs.appendFileSync(process.env.COUNTER,"beta\\n");process.exit(fs.readFileSync("beta.js","utf8").includes("fixed")?0:1)'), inputs: ['beta.js'] },
    { id: 'remote', tier: 'ci', command: node('process.exit(90)') },
  ])
  const counter = path.join(temporary, 'runs.txt'), env = { COUNTER: counter }
  await writeFile(path.join(root, 'alpha.js'), 'export const alpha = true\n')
  await writeFile(path.join(root, 'beta.js'), 'broken\n')
  await git(root, 'add', '-A'); await git(root, 'commit', '-qm', 'candidate')
  const first = await runVibeCheck({ targetRoot: root, tier: 'batch', diffBase: initial, env })
  assert.equal(first.ok, false); assert.equal(first.failureSetComplete, true)
  assert.deepEqual(first.checks.map(({ id, status }) => [id, status]), [['alpha', 'passed'], ['beta', 'failed']])
  assert.deepEqual(first.failedCheckIds, ['beta'])
  assert.deepEqual([first.gate.attempts, first.gate.failures], [1, 1])
  await writeFile(path.join(root, 'beta.js'), 'fixed\n')
  await git(root, 'commit', '-qam', 'repair beta')
  // The same effective environment is passed to both API and a fresh process, so only the
  // failed check's changed file invalidates it. No project paths or tests are inferred.
  const second = JSON.parse((await execute(process.execPath, [cli, 'vibe', 'check', '--target', root, '--tier', 'batch', '--diff-base', initial, '--plan', planFile], { env: { ...process.env, ...env } })).stdout)
  assert.equal(second.ok, true)
  assert.deepEqual(second.checks.map(({ id, status }) => [id, status]), [['alpha', 'cached'], ['beta', 'passed']])
  assert.equal(await readFile(counter, 'utf8'), 'alpha\nbeta\nbeta\n')
  await writeFile(path.join(root, 'REPORT.md'), 'verification notes\n')
  await git(root, 'add', 'REPORT.md'); await git(root, 'commit', '-qm', 'document verification')
  const third = await runVibeCheck({ targetRoot: root, tier: 'batch', diffBase: initial, env })
  assert.equal(third.cached, true); assert.equal(third.failureSetComplete, true)
  assert.deepEqual([third.gate.attempts, third.gate.failures], [2, 1])
  assert.equal(await readFile(counter, 'utf8'), 'alpha\nbeta\nbeta\n')
})

test('plan failures are complete check identities, even when diagnostics have no test names', async (t) => {
  const { root } = await planned(t, [
    { id: 'first', tier: 'batch', command: node('process.exit(2)') },
    { id: 'second', tier: 'batch', command: node('process.exit(3)') },
  ])
  const checked = await runVibeCheck({ targetRoot: root, tier: 'batch' })
  assert.deepEqual(checked.failedTests, [])
  assert.deepEqual(checked.failedCheckIds, ['first', 'second'])
  assert.equal(checked.failureSetComplete, true)
  assert.deepEqual(checked.checks.map(({ exitCode }) => exitCode), [2, 3])
  assert.deepEqual([checked.gate.attempts, checked.gate.failures], [1, 1])
})

test('a generated later input is fingerprinted after the generator, rather than reusing an earlier pass', async (t) => {
  const { root, initial } = await planned(t, [
    { id: 'generate', tier: 'task', command: node('const fs=require("fs");fs.copyFileSync("trigger.txt","value.txt")'), inputs: ['trigger.txt'] },
    { id: 'verify', tier: 'task', command: node('process.exit(require("fs").readFileSync("value.txt","utf8")==="one"?0:7)'), inputs: ['value.txt'] },
  ])
  await writeFile(path.join(root, 'trigger.txt'), 'one'); await writeFile(path.join(root, 'value.txt'), 'one')
  const first = await runVibeCheck({ targetRoot: root, tier: 'task', diffBase: initial })
  assert.equal(first.ok, true)
  await writeFile(path.join(root, 'trigger.txt'), 'two')
  const second = await runVibeCheck({ targetRoot: root, tier: 'task', diffBase: initial })
  assert.equal(second.ok, false)
  assert.deepEqual(second.checks.map(({ status }) => status), ['passed', 'failed'])
  assert.equal(second.checks[1].exitCode, 7)
  assert.equal(await readFile(path.join(root, 'value.txt'), 'utf8'), 'two')
})

test('a later check changing an earlier checked input invalidates the plan receipt', async (t) => {
  const { root, initial } = await planned(t, [
    { id: 'verify', tier: 'task', command: node('process.exit(require("fs").readFileSync("value.txt","utf8")==="one"?0:7)'), inputs: ['value.txt'] },
    { id: 'generate', tier: 'task', command: node('require("fs").writeFileSync("value.txt","two")'), inputs: ['trigger.txt'] },
  ])
  await writeFile(path.join(root, 'trigger.txt'), 'one'); await writeFile(path.join(root, 'value.txt'), 'one')
  const checked = await runVibeCheck({ targetRoot: root, tier: 'task', diffBase: initial })
  assert.equal(checked.ok, false); assert.equal(checked.stale, true)
  assert.equal(checked.checks[0].stale, true); assert.equal(checked.failureSetComplete, false)
})

test('rewriting a sibling plan definition cannot return a pass for the superseded command', async (t) => {
  const rewrite = node(`const fs=require('fs');const plan=JSON.parse(fs.readFileSync('${planFile}','utf8'));plan.checks[1].command='node -e "process.exit(7)"';fs.writeFileSync('${planFile}',JSON.stringify(plan))`)
  const { root, initial } = await planned(t, [
    { id: 'rewrite', tier: 'task', command: rewrite, inputs: ['trigger.txt'] },
    { id: 'verify', tier: 'task', command: node('process.exit(0)'), inputs: ['value.txt'] },
  ])
  const checked = await runVibeCheck({ targetRoot: root, tier: 'task', diffBase: initial })
  assert.equal(checked.ok, false); assert.equal(checked.stale, true)
  assert.equal(checked.failureSetComplete, false)
  assert.equal(checked.checks[1].reason, 'plan-changed')
})

test('cancelling an owned plan stops the active process and explicitly leaves the later check unrun', async (t) => {
  const { root, temporary } = await planned(t, [
    { id: 'active', tier: 'batch', command: node('require("fs").writeFileSync(process.env.STARTED,String(process.pid));setInterval(()=>{},1000)') },
    { id: 'later', tier: 'batch', command: node('require("fs").writeFileSync(process.env.LATER,"ran")') },
  ])
  const controller = new AbortController(), started = path.join(temporary, 'started'), later = path.join(temporary, 'later')
  const checking = runVibeCheck({ targetRoot: root, tier: 'batch', env: { STARTED: started, LATER: later }, signal: controller.signal })
  let pid
  for (let n = 0; n < 200; n++) {
    pid = await readFile(started, 'utf8').catch(() => null)
    if (pid) break
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.ok(pid, 'the command must start before cancellation')
  controller.abort()
  const receipt = await checking
  assert.equal(receipt.cancelled, true); assert.equal(receipt.failureSetComplete, false)
  assert.deepEqual(receipt.checks.map(({ status }) => status), ['failed', 'not-run'])
  assert.equal(receipt.checks[1].cancelled, true)
  assert.equal(await readFile(later, 'utf8').catch(() => null), null)
  assert.equal(receipt.gate, undefined, 'user cancellation is not a failed gate attempt')
  assert.throws(() => process.kill(Number(pid), 0), /ESRCH/)
})

test('a plan timeout never reports pending checks as successful', async (t) => {
  const { root } = await planned(t, [
    { id: 'slow', tier: 'batch', command: node('setTimeout(()=>{},10000)') },
    { id: 'pending', tier: 'batch', command: node('process.exit(0)') },
  ])
  const receipt = await runVibeCheck({ targetRoot: root, tier: 'batch', timeoutMs: 100 })
  assert.equal(receipt.timedOut, true); assert.equal(receipt.ok, false)
  assert.equal(receipt.failureSetComplete, false)
  assert.deepEqual(receipt.checks.map(({ status }) => status), ['failed', 'not-run'])
})

for (const exitCode of [0, 1]) test(`a command's ordinary ${exitCode ? 'failure' : 'success'} cleans background descendants`, { skip: process.platform === 'win32' }, async (t) => {
  const { root, temporary } = await fixture(t)
  const pidFile = path.join(temporary, 'descendant.pid')
  const background = 'setInterval(()=>{},1000)'
  const command = node(`const child=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(background)}],{stdio:'ignore'});require('fs').writeFileSync(process.env.PID_FILE,String(child.pid));child.unref();process.exit(${exitCode})`)
  const receipt = await runVibeCheck({ targetRoot: root, env: { PID_FILE: pidFile } }, command)
  assert.equal(receipt.exitCode, exitCode)
  const pid = (await readFile(pidFile, 'utf8')).trim()
  const state = await execute('ps', ['-p', pid, '-o', 'stat=']).then(({ stdout }) => stdout.trim(), () => '')
  assert.ok(!state || state.startsWith('Z'), `background child remains active: ${state}`)
  assert.equal(receipt.cleanup.scope, 'process-group')
})

test('ARCH plan declaration loads exact tiers, lint checks links and ref briefs keep one revision source', async (t) => {
  const { root, revision } = await planned(t, [
    { id: 'local', tier: 'batch', command: 'node --version' },
    { id: 'remote', tier: 'ci', command: 'remote-checks' },
  ])
  const verification = await readVerification(root)
  assert.equal(verification.declared, true); assert.equal(verification.partial, false)
  assert.deepEqual(verification.task, []); assert.deepEqual(verification.batch, ['node --version'])
  assert.deepEqual(verification.ci, ['remote-checks'])
  assert.equal((await lintSpec({ targetRoot: root })).ok, true)
  await writeFile(path.join(root, planFile), '{broken')
  const lint = await lintSpec({ targetRoot: root })
  assert.equal(lint.ok, false); assert.ok(lint.errors.some((line) => line.includes('verification plan')))
  const brief = await vibeBrief({ targetRoot: root, task: 'T001', ref: revision })
  assert.deepEqual(brief.verify.batch, ['node --version'])
  await assert.rejects(runVibeCheck({ targetRoot: root, tier: 'batch' }), /verification plan/)
  await assert.rejects(runVibeCheck({ targetRoot: root, plan: planFile }, 'node --version'), /함께 쓰지/)
})

test('the loop executes one structured round and keeps stable check IDs as failure evidence', async (t) => {
  const { root } = await planned(t, [
    { id: 'syntax', tier: 'batch', command: node('process.exit(1)'), inputs: ['app.js'] },
    { id: 'contracts', tier: 'batch', command: node('process.exit(2)'), inputs: ['app.js'] },
  ])
  let checks = 0
  const result = await vibeLoop({ targetRoot: root, tag: 'plan01', provider: 'codex', maxUnits: 1 }, {
    preflight: async () => ({ ok: true, checks: [] }),
    execute: async () => {
      await archiveTask(root, 'T001')
      await writeFile(path.join(root, 'app.js'), 'export const value = 1\n')
      await git(root, 'add', 'spec', 'app.js'); await git(root, 'commit', '-qm', 'implement candidate')
      return { exitCode: 0, result: { kind: 'task', id: 'T001', outcome: 'completed', pushed: false, next: '' } }
    },
    check: async (config, command) => { checks++; assert.equal(config.plan, planFile); assert.equal(command, undefined); return runVibeCheck(config, command) },
    push: () => assert.fail('failed checks cannot publish'),
  })
  assert.equal(checks, 1, 'one plan invocation must not be followed by duplicate legacy commands')
  assert.equal(result.ok, false)
  assert.equal(result.gate.evidence, 'checks'); assert.equal(result.gate.failureSetComplete, true)
  assert.deepEqual(result.gate.failedCommands.map(({ id }) => id), ['syntax', 'contracts'])
  const stored = gateCount((await readGates(path.join(root, '.git/gusta/v1'))).entries['tag:plan01'])
  assert.deepEqual([stored.attempts, stored.failures], [1, 1])
})

test('a docs-only change still runs the plan check that explicitly consumes it', async (t) => {
  const { root } = await planned(t, [
    { id: 'docs', tier: 'batch', command: node('process.exit(require("fs").readFileSync("docs/contract.md","utf8")==="good"?0:7)'), inputs: ['docs/contract.md'] },
  ])
  await mkdir(path.join(root, 'docs')); await writeFile(path.join(root, 'docs/contract.md'), 'good')
  await git(root, 'add', 'docs'); await git(root, 'commit', '-qm', 'initial documentation')
  let checks = 0
  const result = await vibeLoop({ targetRoot: root, tag: 'docs01', provider: 'codex', maxUnits: 1 }, {
    preflight: async () => ({ ok: true, checks: [] }),
    execute: async () => {
      await archiveTask(root, 'T001'); await writeFile(path.join(root, 'docs/contract.md'), 'bad')
      await git(root, 'add', 'spec', 'docs'); await git(root, 'commit', '-qm', 'revise documentation')
      return { exitCode: 0, result: { kind: 'task', id: 'T001', outcome: 'completed', pushed: false, next: '' } }
    },
    check: async (config, command) => { checks++; return runVibeCheck(config, command) },
    push: () => assert.fail('a changed declared documentation input must be checked'),
  })
  assert.equal(checks, 1); assert.equal(result.ok, false)
  assert.deepEqual(result.gate.failedCommands.map(({ id }) => id), ['docs'])
})

test('post-gate report changes to declared inputs refuse publication once instead of silently passing or looping', async (t) => {
  const { root } = await planned(t, [{ id: 'reports', tier: 'batch', command: 'node --version', inputs: ['spec/reports/**'] }])
  let checks = 0
  const result = await vibeLoop({ targetRoot: root, tag: 'report01', provider: 'codex', maxUnits: 1 }, {
    preflight: async () => ({ ok: true, checks: [] }),
    execute: async () => {
      await archiveTask(root, 'T001')
      await git(root, 'add', 'spec'); await git(root, 'commit', '-qm', 'close task')
      return { exitCode: 0, result: { kind: 'task', id: 'T001', outcome: 'completed', pushed: false, next: '' } }
    },
    check: async (config, command) => { checks++; return runVibeCheck(config, command) },
    push: () => assert.fail('the final report changed a declared input after its check'),
  })
  assert.equal(result.ok, false); assert.equal(checks, 1)
  assert.match(result.error, /검증 후 검사 계획의 입력 또는 정의가 변경/)
})

test('plan inputs excluding generated reports allow the checked candidate to publish', async (t) => {
  const { root } = await planned(t, [{ id: 'syntax', tier: 'batch', command: 'node --check app.js', inputs: ['app.js'] }])
  let pushes = 0
  const result = await vibeLoop({ targetRoot: root, tag: 'clean01', provider: 'codex', maxUnits: 1 }, {
    preflight: async () => ({ ok: true, checks: [] }),
    execute: async () => {
      await archiveTask(root, 'T001'); await writeFile(path.join(root, 'app.js'), 'export const value = 1\n')
      await git(root, 'add', 'spec', 'app.js'); await git(root, 'commit', '-qm', 'implement candidate')
      return { exitCode: 0, result: { kind: 'task', id: 'T001', outcome: 'completed', pushed: false, next: '' } }
    },
    push: async () => { pushes++; return { ok: true, pushed: null } },
  })
  assert.equal(result.ok, true, result.error); assert.equal(pushes, 1)
})

test('publication lint resolves the plan from the exact committed candidate, even outside spec Markdown', async (t) => {
  const { root } = await planned(t, [{ id: 'local', tier: 'batch', command: 'node --version', inputs: ['app.js'] }])
  await git(root, 'branch', 'integration')
  await writeFile(path.join(root, 'spec/SETTINGS.md'), '# SETTINGS\n- land: integration\n- push: false\n')
  await archiveTask(root, 'T001')
  await git(root, 'add', 'spec'); await git(root, 'commit', '-qm', 'close candidate')
  const result = await vibePush({ targetRoot: root, verifiedCommit: await git(root, 'rev-parse', 'HEAD') })
  assert.equal(result.ok, true)
  assert.equal(result.landed, await git(root, 'rev-parse', 'integration'))
})

for (const consumesState of [false, true]) test(`verified publication ${consumesState ? 'rejects' : 'permits'} later bookkeeping according to the selected plan inputs`, async (t) => {
  const { root } = await planned(t, [{ id: 'local', tier: 'batch', command: 'node --version', inputs: [consumesState ? 'spec/STATE.md' : 'app.js'] }])
  await git(root, 'branch', 'integration')
  await writeFile(path.join(root, 'spec/SETTINGS.md'), '# SETTINGS\n- land: integration\n- push: false\n')
  await writeFile(path.join(root, 'app.js'), 'export const value = 1\n')
  await archiveTask(root, 'T001')
  await git(root, 'add', 'spec', 'app.js'); await git(root, 'commit', '-qm', 'candidate')
  const verified = await git(root, 'rev-parse', 'HEAD')
  const state = path.join(root, 'spec/STATE.md')
  await writeFile(state, (await readFile(state, 'utf8')).replace('- lang: ko', '- lang: en'))
  await git(root, 'commit', '-qam', 'bookkeeping')
  if (consumesState) {
    await assert.rejects(vibePush({ targetRoot: root, verifiedCommit: verified }), /최종 검증 이후 검사 계획의 실제 입력/)
    assert.notEqual(await git(root, 'rev-parse', 'integration'), await git(root, 'rev-parse', 'HEAD'))
  } else {
    const landed = await vibePush({ targetRoot: root, verifiedCommit: verified })
    assert.equal(landed.ok, true)
    assert.equal(await git(root, 'rev-parse', 'integration'), await git(root, 'rev-parse', 'HEAD'))
  }
})
