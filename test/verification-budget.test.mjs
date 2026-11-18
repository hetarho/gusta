import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fixture, execute } from './helpers/vibe-fixture.mjs'
import { runVibeCheck } from './helpers/unit-policy.mjs'
import { withHeavyLock } from '../src/check-cache.mjs'
import { prepareWorkspace, runCheckCommand } from '../src/workspace-prepare.mjs'

const shell = (value) => `'${value.replaceAll("'", "'\\''")}'`
const node = (code) => `${shell(process.execPath)} -e ${shell(code)}`

test('time spent waiting for the shared heavy lock does not grant a fresh check timeout', async (t) => {
  const { root, temporary } = await fixture(t)
  const marker = path.join(temporary, 'started')
  await writeFile(path.join(root, 'checks.json'), JSON.stringify({ schemaVersion: 1, checks: [
    { id: 'pending', tier: 'task', inputs: ['spec/STATE.md'], command: node(`require('fs').writeFileSync(${JSON.stringify(marker)},'started')`) },
  ] }))
  let now = 100
  const result = await runVibeCheck({ targetRoot: root, plan: 'checks.json', heavy: true, timeoutMs: 500 }, undefined, {
    now: () => now,
    withHeavyLock: async (runtime, label, perform) => { now += 501; return perform() },
  })
  assert.equal(result.ok, false)
  assert.equal(result.timedOut, true)
  assert.equal(result.checks[0].status, 'not-run')
  await assert.rejects(readFile(marker), { code: 'ENOENT' })
})

test('a heavy-lock wait respects a deadline shorter than its polling interval', async (t) => {
  const { temporary } = await fixture(t)
  let release, acquired
  const ready = new Promise((resolve) => { acquired = resolve })
  const holding = withHeavyLock(temporary, 'owner', () => new Promise((resolve) => { release = resolve; acquired() }))
  await ready
  const start = Date.now()
  try {
    await assert.rejects(withHeavyLock(temporary, 'waiting', () => assert.fail('the owner still holds the lock'), { timeoutMs: 50 }), /timed out|busy/)
    assert.ok(Date.now() - start < 1000, 'a 50 ms budget must not sleep for the 2 s polling interval')
  } finally { release(); await holding }
})

for (const externalDeadline of [false, true]) test(`prepare commands share ${externalDeadline ? 'the original integration deadline' : 'one invocation timeout'}`, async () => {
  let now = 1000
  const runs = []
  const prepared = await prepareWorkspace('/unused', ['first', 'second', 'pending'], {
    timeoutMs: externalDeadline ? 500 : 100,
    ...(externalDeadline ? { deadline: 1100 } : {}),
  }, {
    now: () => now,
    run: async (command, { timeout }) => { runs.push([command, timeout]); now += 70 },
  })
  assert.deepEqual(runs, [['first', 100], ['second', 30]])
  assert.equal(prepared.ok, false)
  assert.deepEqual(prepared.steps.map(({ command, ok, timedOut }) => [command, ok, timedOut]), [
    ['first', true, undefined], ['second', true, undefined], ['pending', false, true],
  ])
})

for (const code of [0, 4]) test(`shared checker cleans background children after ordinary ${code ? 'failure' : 'success'}`, { skip: process.platform === 'win32' }, async (t) => {
  const { root, temporary } = await fixture(t)
  const marker = path.join(temporary, 'child.pid')
  const command = node(`const child=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('fs').writeFileSync(${JSON.stringify(marker)},String(child.pid));child.unref();process.exit(${code})`)
  if (code) await assert.rejects(runCheckCommand(command, { cwd: root }), /exit 4/)
  else await runCheckCommand(command, { cwd: root })
  const pid = (await readFile(marker, 'utf8')).trim()
  const state = await execute('ps', ['-p', pid, '-o', 'stat=']).then(({ stdout }) => stdout.trim(), () => '')
  assert.ok(!state || state.startsWith('Z'), `owned child remains active: ${state}`)
})
