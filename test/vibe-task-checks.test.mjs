import test from 'node:test'
import { runVibeCheck, vibeLoop } from './helpers/unit-policy.mjs'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fixture, git, archiveTask } from './helpers/vibe-fixture.mjs'

import { readTimings, recordTiming, timingKey, taskCheckSummary, SLOW_TASK_CHECK_MS } from '../src/check-cache.mjs'
import { taskCheckLine } from '../src/loop-time.mjs'
import { vibeStatus } from '../src/vibe.mjs'

import { vibeInbox } from '../src/vibe-inbox.mjs'
import { readSessions } from '../src/coord-doc.mjs'

// Task-tier checks are timed per command so a check too slow for every task can be moved to the
// final gate — by a person: the CLI only reports it (status, loop report) and suggests it once.
const runtime = (root) => path.join(root, '.git/gusta/v1')
const samples = async (root, kind, command) => (await readTimings(runtime(root))).entries[timingKey(kind, command)]?.samples ?? []

test('a task check records its time per command; a cache hit, a refused batch command and a gate do not add task samples', async (t) => {
  const { root } = await fixture(t, 1)
  const command = 'node -e "setTimeout(()=>{},20)"'
  const first = await runVibeCheck({ targetRoot: root, tier: 'task' }, command)
  assert.equal(first.cached, false)
  assert.equal((await samples(root, 'task', command)).length, 1)
  assert.ok((await samples(root, 'task', command))[0] >= 20)
  assert.equal((await runVibeCheck({ targetRoot: root, tier: 'task' }, command)).cached, true)
  assert.equal((await samples(root, 'task', command)).length, 1, 'a cache hit ran nothing and is not a sample')
  await runVibeCheck({ targetRoot: root, tier: 'task', noCache: true }, `  ${command} `)
  assert.equal((await samples(root, 'task', command)).length, 2, 'whitespace does not split a command')
  // A command ARCH lists only under batch is refused at the task tier before it runs.
  const arch = path.join(root, 'spec/ssot/ARCH.md')
  await writeFile(arch, (await readFile(arch, 'utf8')).replace('batch, before code push: `node --version`', 'batch, before code push: `node -e "1"`'))
  await assert.rejects(runVibeCheck({ targetRoot: root, tier: 'task' }, 'node -e "1"'), /ARCH batch/)
  assert.deepEqual(await samples(root, 'task', 'node -e "1"'), [])
  await git(root, 'commit', '-qam', 'batch command')
  await runVibeCheck({ targetRoot: root, tier: 'batch' }, 'node -e "1"')
  assert.equal((await samples(root, 'final', 'node -e "1"')).length, 1)
  assert.deepEqual(await samples(root, 'task', 'node -e "1"'), [])
})

test('slow is an average over 60s in at least two runs; task timings keep ten samples and the newest commands', async (t) => {
  const summary = taskCheckSummary([{ command: 'one', ms: 130000 }, { command: 'tsc', ms: 61000 }, { command: ' tsc ', ms: 62000 }, { command: 'edge', runs: 2, ms: 2 * SLOW_TASK_CHECK_MS }, { command: 'unit', runs: 5, ms: 5000 }])
  assert.deepEqual(summary.slow, [{ command: 'tsc', runs: 2, avgMs: 61500 }])
  assert.equal(summary.runs, 10); assert.equal(summary.ms, 130000 + 123000 + 120000 + 5000)
  assert.equal(taskCheckLine(summary), '- task checks: 10 runs, 6m; avg over 60s: `tsc` avg 62s ×2 — suggested for the batch gate (inbox)')
  assert.equal(taskCheckLine(taskCheckSummary([{ command: 'unit', ms: 3000 }])), '- task checks: 1 runs, 0m')
  const { root } = await fixture(t, 1)
  for (let i = 0; i < 12; i++) await recordTiming(runtime(root), timingKey('task', 'tsc'), 1000 + i)
  assert.deepEqual(await samples(root, 'task', 'tsc'), [1002, 1003, 1004, 1005, 1006, 1007, 1008, 1009, 1010, 1011])
  for (let i = 0; i < 4; i++) await recordTiming(runtime(root), timingKey('final', 'suite'), i)
  assert.deepEqual(await samples(root, 'final', 'suite'), [1, 2, 3], 'the gate keeps its last three for the reserve')
  for (let i = 0; i < 101; i++) await recordTiming(runtime(root), timingKey('task', `test ${i}`), 1)
  const keys = Object.keys((await readTimings(runtime(root))).entries)
  assert.equal(keys.filter((key) => key.startsWith('task\u0000')).length, 100)
  assert.ok(!keys.includes(timingKey('task', 'tsc')), 'the oldest command goes first')
  assert.ok(keys.includes(timingKey('final', 'suite')), 'gate timings are never pruned with task ones')
})

test('vibe status shows recent task checks and leaves out a command ARCH moved to batch', async (t) => {
  const { root } = await fixture(t, 1)
  assert.equal((await vibeStatus({ targetRoot: root, tag: 't060', fetch: false })).taskChecks, undefined, 'no timings, no key')
  for (const ms of [80000, 82000]) await recordTiming(runtime(root), timingKey('task', 'pnpm run typecheck'), ms)
  for (const ms of [90000, 90000]) await recordTiming(runtime(root), timingKey('task', 'pnpm run build'), ms)
  await recordTiming(runtime(root), timingKey('task', 'node --version'), 1000)
  const arch = path.join(root, 'spec/ssot/ARCH.md')
  await writeFile(arch, (await readFile(arch, 'utf8')).replace('batch, before code push: `node --version`', 'batch, before code push: `node --version`, `pnpm run build`'))
  const status = await vibeStatus({ targetRoot: root, tag: 't060', fetch: false })
  assert.deepEqual(status.taskChecks, { runs: 3, ms: 163000, slow: [{ command: 'pnpm run typecheck', runs: 2, avgMs: 81000 }] })
})

test('a loop reports its task checks and suggests each slow one for the batch gate once', async (t) => {
  const { root } = await fixture(t, 2)
  // The owner already has a suggestion naming one of them: it is not added again.
  await vibeInbox({ targetRoot: root, step: 'add', kind: 'suggest', text: 'move task check `pnpm run build` to the final gate (ARCH batch): earlier run' })
  let units = 0
  const result = await vibeLoop({ targetRoot: root, tag: 'tc01', provider: 'codex', maxUnits: 2 }, {
    preflight: async () => ({ ok: true, checks: [] }),
    execute: async (_options, job) => {
      const id = job.brief.taskId
      await archiveTask(root, id)
      await writeFile(path.join(root, 'app.js'), `// ${++units}\n`)
      await git(root, 'add', 'spec', 'app.js'); await git(root, 'commit', '-qm', `${id} done`)
      return { exitCode: 0, result: { kind: 'task', id, outcome: 'completed', pushed: false, next: '' },
        checks: { runs: 4, cached: 1, ms: 172000, task: [{ command: 'pnpm run typecheck', runs: 1, ms: 80000 }, { command: 'pnpm run build', runs: 1, ms: 90000 }, { command: 'node --test test/a.test.mjs', runs: 1, ms: 2000 }] } }
    },
    check: async () => ({ ok: true }), push: async () => ({ ok: true, pushed: null }),
  })
  assert.equal(result.ok, true, result.error)
  assert.deepEqual(result.taskChecks.slow.map(({ command, runs, avgMs }) => [command, runs, avgMs]), [['pnpm run build', 2, 90000], ['pnpm run typecheck', 2, 80000]])
  const report = await readFile(path.join(root, result.report), 'utf8')
  assert.equal(report.match(/^- task checks: /gm)?.length, 1)
  assert.match(report, /^- task checks: 6 runs, 6m; avg over 60s: `pnpm run build` avg 90s ×2, `pnpm run typecheck` avg 80s ×2 — suggested for the batch gate \(inbox\)$/m)
  const inbox = readSessions(await git(root, 'show', 'gusta:SESSIONS.md')).inbox.filter((line) => / suggest /.test(line))
  assert.equal(inbox.filter((line) => line.includes('`pnpm run build`')).length, 1, 'already suggested: not added again')
  assert.deepEqual(inbox.filter((line) => line.includes('`pnpm run typecheck`')).map((line) => line.replace(/^- \d{6} /, '')),
    ['suggest ARCH-2: move task check `pnpm run typecheck` to the final gate (ARCH batch): it averaged 80s over 2 runs'])
  assert.ok(!inbox.some((line) => line.includes('test/a.test.mjs')), 'a fast check is never suggested')
})
