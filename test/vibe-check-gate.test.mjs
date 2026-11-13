import test from 'node:test'
import { runVibeCheck, vibeLoop } from './helpers/unit-policy.mjs'
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fixture, git, execute, archiveTask } from './helpers/vibe-fixture.mjs'
import { resetVibeGate } from '../src/vibe-check.mjs'
import { readGates, recordGateRun, addRun, gateCount, GATE_IDLE_MS } from '../src/gate-ledger.mjs'

const cli = fileURLToPath(new URL('../bin/gusta.mjs', import.meta.url))

// A failing gate that leaves evidence outside the checkout of every real run.
async function gate(t) {
  const context = await fixture(t)
  const runs = path.join(context.temporary, 'runs.txt')
  await writeFile(runs, '')
  const failing = 'node -e \'require("fs").appendFileSync(process.env.GATE_RUNS,"x");console.log("FAIL e2e checkout");process.exit(1)\''
  const check = (options = {}, command = failing) => runVibeCheck({ targetRoot: context.root, tier: 'batch', env: { GATE_RUNS: runs }, ...options }, command)
  const commit = async (content) => { await writeFile(path.join(context.root, 'app.js'), content); await git(context.root, 'add', 'app.js'); await git(context.root, 'commit', '-qm', content) }
  return { ...context, runs, failing, check, commit, count: async () => (await readFile(runs, 'utf8')).length }
}

test('rounds: commands on one tree share a round, a rerun or a new tree opens one, idle keys start over', () => {
  let entry = addRun(undefined, { tree: 'a', commit: 'c1', command: 'build', ok: false }, 0)
  entry = addRun(entry, { tree: 'a', commit: 'c1', command: 'e2e', ok: false }, 1)
  assert.deepEqual([entry.attempts, entry.failures], [1, 1])
  entry = addRun(entry, { tree: 'a', commit: 'c1', command: ' build ', ok: false }, 2)
  assert.deepEqual([entry.attempts, entry.failures], [2, 2])
  entry = addRun(entry, { tree: 'b', commit: 'c2', command: 'build', ok: true }, 3)
  entry = addRun(entry, { tree: 'b', commit: 'c2', command: 'e2e', ok: false }, 4)
  assert.deepEqual([entry.attempts, entry.failures], [3, 3])
  assert.deepEqual(gateCount(entry, 4 + GATE_IDLE_MS + 1), { attempts: 0, failures: 0, last: null })
})

test('a standalone gate is refused after three failed rounds without running the command', async (t) => {
  const { check, count, initial } = await gate(t)
  const first = await check()
  assert.equal(first.ok, false)
  assert.deepEqual(first.gate, { key: 'branch:main', attempts: 1, failures: 1, cap: 3, left: 2 })
  assert.match(first.next[0], /FAIL|failedTests/)
  assert.ok(first.next.some((line) => line.includes(`vibe check --tier task --diff-base ${initial}`)))
  assert.ok(first.next.some((line) => /2 failed round\(s\) left of 3/.test(line)))
  assert.ok(first.next.some((line) => /inbox add --kind suggest/.test(line)))
  await check()
  const third = await check()
  assert.equal(third.gate.left, 0)
  assert.ok(third.next.some((line) => /do not run the full gate again.*--kind parked/.test(line)))
  const refused = await check()
  assert.equal(await count(), 3, 'the fourth gate must not run')
  assert.equal(refused.refused, 'gate-cap'); assert.equal(refused.exitCode, 1); assert.equal(refused.ok, false)
  assert.deepEqual([refused.attempts, refused.failures, refused.cap], [3, 3, 3])
  assert.match(refused.next.join('\n'), /vibe inbox add --kind parked/)
  assert.ok(refused.lastFailure.failed.length)
  // Another command on the same capped key is refused too; the task tier is untouched.
  assert.equal((await check({}, 'node -e "0"')).refused, 'gate-cap')
  assert.equal((await check({ tier: 'task' }, 'node --version')).ok, true)
})

test('a success keeps the failures, a cache hit is no attempt, and session tags count apart', async (t) => {
  const { check, count, commit } = await gate(t)
  await check(); await check()
  await commit('export const fixed = 1\n')
  const passed = await check({}, 'node -e "0"')
  assert.deepEqual([passed.ok, passed.gate.attempts, passed.gate.failures], [true, 3, 2])
  const hit = await check({}, 'node -e "0"')
  assert.equal(hit.cached, true); assert.deepEqual([hit.gate.attempts, hit.gate.failures], [3, 2])
  await commit('export const broken = 1\n')
  assert.equal((await check()).gate.failures, 3)
  assert.equal((await check({ noCache: true }, 'node -e "0"')).refused, 'gate-cap')
  const tagged = await check({ tag: 'ab12' })
  assert.deepEqual([tagged.refused, tagged.gate.key, tagged.gate.failures], [undefined, 'tag:ab12', 1])
  assert.equal(await count(), 4)
  await assert.rejects(check({ tag: 'not valid!' }), /세션 tag/)
})

test('only --reset-gate lifts the cap, for its own key', async (t) => {
  const { root, check, count, runs, failing } = await gate(t)
  for (const tag of [undefined, 'ab12']) for (let i = 0; i < 3; i++) await check({ tag })
  const run = (args) => execute(process.execPath, [cli, 'vibe', 'check', '--target', root, ...args], { env: { ...process.env, GATE_RUNS: runs } }).then((r) => ({ code: 0, json: JSON.parse(r.stdout) }), (e) => ({ code: e.code, json: JSON.parse(e.stdout) }))
  const refused = await run(['--tier', 'batch', '--json', '--', failing])
  assert.deepEqual([refused.code, refused.json.refused], [1, 'gate-cap'])
  assert.equal(await count(), 6)
  await assert.rejects(resetVibeGate({ targetRoot: root }, 'node --version'), /검사 명령 없이/)
  const reset = await run(['--reset-gate', '--json'])
  assert.deepEqual([reset.code, reset.json.reset, reset.json.previous.failures], [0, 'branch:main', 3])
  const again = await run(['--tier', 'batch', '--', failing])
  assert.deepEqual([again.code, again.json.refused, again.json.gate.failures], [1, undefined, 1])
  assert.equal((await check({ tag: 'ab12' })).refused, 'gate-cap', 'the tag key keeps its cap')
})

test('the loop host records each round once and is never refused; design and delegated paths are unchanged', async (t) => {
  const { root, initial } = await fixture(t, 1)
  const runtime = path.join(root, '.git/gusta/v1')
  // An earlier standalone gate of the same session already reached the cap.
  for (const tree of ['a', 'b', 'c']) await recordGateRun(runtime, 'tag:loop01', { tree, commit: initial, command: 'x', ok: false })
  const seen = []
  const result = await vibeLoop({ targetRoot: root, tag: 'loop01', provider: 'codex', maxUnits: 1, verify: ['node --check app.js', 'node --version'] }, {
    preflight: async () => ({ ok: true, checks: [] }),
    execute: async () => {
      await archiveTask(root, 'T001')
      await writeFile(path.join(root, 'app.js'), 'export const =\n')
      await git(root, 'add', 'spec', 'app.js'); await git(root, 'commit', '-qm', 'broken implementation')
      return { exitCode: 0, result: { kind: 'task', id: 'T001', outcome: 'completed', pushed: false, next: '' } }
    },
    check: async (config, command) => { const checked = await runVibeCheck(config, command); seen.push({ config, checked }); return checked },
    push: () => assert.fail('a failed gate must not publish'),
  })
  assert.equal(result.ok, false)
  assert.deepEqual(seen.map(({ config }) => [config.tag, config.gateLedger]), [['loop01', 'record'], ['loop01', 'record']])
  assert.ok(seen.every(({ checked }) => !checked.refused && !checked.next), 'the loop decides and repairs with its own counter')
  assert.equal(result.gate.failures, 1)
  // Two commands on one tree, one failing: one round, one failure in the shared record.
  const entry = gateCount((await readGates(runtime)).entries['tag:loop01'])
  assert.deepEqual([entry.attempts, entry.failures], [4, 4])
  assert.equal((await runVibeCheck({ targetRoot: root, tier: 'batch', tag: 'loop01', noCache: true }, 'node --version')).refused, 'gate-cap')
  // Design verification is the person's run: it neither counts nor gets refused.
  const design = await runVibeCheck({ targetRoot: root, tier: 'batch', tag: 'loop01', gateLedger: false, uncommitted: true }, 'node -e "process.exit(1)"')
  assert.equal(design.refused, undefined); assert.equal(design.gate, undefined)
  // Workers and reviewers are still refused before any gate record is read or written.
  await mkdir(runtime, { recursive: true })
  await writeFile(path.join(runtime, 'state.json'), JSON.stringify({ schemaVersion: 1, groups: {}, attempts: { example: { workspace: root } } }))
  const before = await readFile(path.join(runtime, 'gates.json'), 'utf8')
  await assert.rejects(runVibeCheck({ targetRoot: root, tier: 'batch' }, 'node --version'), /조정자\/호스트/)
  await assert.rejects(runVibeCheck({ targetRoot: root, tier: 'group', env: { GUSTA_VIBE_UNIT: '1' } }, 'node --version'), /조정자\/호스트/)
  assert.equal(await readFile(path.join(runtime, 'gates.json'), 'utf8'), before)
})
