import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fixture, git, execute } from './helpers/vibe-fixture.mjs'
import { vibeBrief, vibeFormat, verificationTiers } from '../src/vibe-brief.mjs'
import { runVibeCheck } from '../src/vibe-check.mjs'
import { readTimings, measured, timingKey } from '../src/check-cache.mjs'
import { vibeStatus } from '../src/vibe.mjs'
import { lintSpec } from '../src/spec-lint.mjs'
const cli = fileURLToPath(new URL('../bin/gusta.mjs', import.meta.url))

test('standalone brief contains exact cited blocks, freshness, touches and runnable tiers only', async (t) => {
  const { root, arch, initial } = await fixture(t)
  const brief = await vibeBrief({ targetRoot: root, task: 'T001' })
  // the cited block first; ARCH-2 rides along as a global rule (no cfg always ⇒ every ARCH decision)
  assert.deepEqual(brief.decisions.map((x) => [x.id, x.via[0].kind]), [['ARCH-1', 'cited'], ['ARCH-2', 'always']])
  assert.deepEqual(brief.touches, ['src/'])
  assert.deepEqual(brief.freshness, [{ domain: 'ARCH', base: 1, current: 1, stale: false }])
  assert.equal(brief.diffBase, initial)
  const tiers = verificationTiers(arch)
  assert.deepEqual(tiers.task, ['node --version'])
  assert.deepEqual(tiers.batch, ['node --version'])
  assert.deepEqual(tiers.ci, [])
  assert.ok(tiers.declared)
  const format = await vibeFormat({ section: 'task' })
  assert.ok(JSON.stringify(format).length < 9500)
  // SETTINGS has its own section: the state excerpt every STATE writer reads does not carry it
  const state = JSON.stringify(await vibeFormat({ section: 'state' }))
  assert.ok(state.length < 10500); assert.doesNotMatch(state, /permission-mode/)
  assert.match((await vibeFormat({ section: 'settings' })).sections[0].text, /permission-mode/)
  const result = await execute(process.execPath, [cli, 'vibe', 'brief', 'T001', '--target', root, '--json'])
  assert.equal(JSON.parse(result.stdout).taskId, 'T001')
})

test('task size and run: brief --json carries size.budget, status remaining and the board carry run', async (t) => {
  const { root } = await fixture(t, 2)
  const file = path.join(root, 'spec/tasks/T001.example.md')
  const six = 'src/a.ts src/b.ts src/c.ts src/d.ts src/e.ts src/f.ts test/a.test.ts'
  await writeFile(file, (await readFile(file, 'utf8')).replace('touches:src/', `touches:${six} | run:claude/sonnet@high`))
  const brief = await vibeBrief({ targetRoot: root, task: 'T001' })
  assert.deepEqual(brief.size.budget, { briefChars: brief.size.chars, touches: 6, limits: { briefChars: 40000, touches: 5 }, over: ['touches'] })
  assert.deepEqual((await vibeBrief({ targetRoot: root, task: 'T002' })).size.budget.over, [])
  const status = await vibeStatus({ targetRoot: root, fetch: false })
  assert.deepEqual(status.remaining.map((task) => [task.id, task.run]), [['T001', 'claude/sonnet@high'], ['T002', undefined]])
  const result = await execute(process.execPath, [fileURLToPath(new URL('../bin/gusta.mjs', import.meta.url)), 'board', '--target', root, '--json'])
  assert.deepEqual(JSON.parse(result.stdout).tasks.map((task) => [task.id, task.run]), [['T001', 'claude/sonnet@high'], ['T002', null]])
  // A malformed run is a board error too: the task is not dependency-ready until the line is fixed.
  await writeFile(file, (await readFile(file, 'utf8')).replace('run:claude/sonnet@high', 'run:sonnet'))
  const broken = await execute(process.execPath, [fileURLToPath(new URL('../bin/gusta.mjs', import.meta.url)), 'board', '--target', root, '--json']).catch((error) => error)
  assert.ok(JSON.parse(broken.stdout).errors.includes('T001.example.md: run 형식 오류: sonnet'))
})

test('conditional verification prose is preserved without executing backticked paths', () => {
  const arch = '## decisions\n- ARCH-3 [o] Verification runs in three tiers.\n  - task, before each done commit: `pnpm run typecheck`, `pnpm exec vitest run --changed "$GUSTA_DIFF_BASE" --passWithNoTests`.\n  - conditional browser coverage uses the `tests/e2e` specs: `PREVIEW_BUILD=1 pnpm exec playwright test --project=chromium` with spec paths at the batch gate.\n  - batch, once before a push (`work integrate --verify`): `pnpm run test:unit`, `pnpm run build`.\n  - CI, after code push: run the remote checks; `spec/`, `docs/` do not trigger them.\n'
  const v = verificationTiers(arch)
  assert.equal(v.task.length, 2); assert.equal(v.batch.length, 2)
  assert.deepEqual(v.ci, [])
  assert.ok(v.guidance.some((line) => line.includes('spec paths')))
  assert.ok(!v.task.some((line) => line.includes('playwright')))
})

test('check passes scope, bounds output, retains full log and includes scope in cached checks', async (t) => {
  const { root, initial } = await fixture(t)
  const command = 'node -e \'console.log(process.env.GUSTA_TIER,process.env.GUSTA_DIFF_BASE,process.env.GUSTA_TASK);console.log("x".repeat(50000));console.log("FAIL regression name");process.exit(2)\''
  const checked = await runVibeCheck({ targetRoot: root, diffBase: initial, task: 'T001' }, command)
  assert.equal(checked.ok, false); assert.equal(checked.exitCode, 2)
  assert.deepEqual(checked.failedTests, ['FAIL regression name'])
  assert.ok(JSON.stringify(checked).length < 6000)
  assert.match(await readFile(checked.log, 'utf8'), new RegExp(`task ${initial} T001`))
  assert.ok((await readFile(checked.log)).length > 50000)
  const cmd = 'node -e \'console.log(process.env.GUSTA_DIFF_BASE)\''
  const first = await runVibeCheck({ targetRoot: root, diffBase: initial }, cmd)
  assert.equal((await runVibeCheck({ targetRoot: root, diffBase: initial }, cmd)).cached, true)
  const second = await runVibeCheck({ targetRoot: root, diffBase: initial, tier: 'batch' }, cmd)
  assert.equal(second.cached, false)
  assert.equal(first.scope.TIER, 'task')
})

test('check timeout terminates the command group', async (t) => {
  const { root } = await fixture(t)
  const r = await runVibeCheck({ targetRoot: root, timeoutMs: 100 }, 'node -e "setTimeout(()=>{},10000)"')
  assert.equal(r.timedOut, true); assert.equal(r.ok, false)
})

test('legacy ARCH yields review hint, accepts lightweight fix log and status remains summarized', async (t) => {
  const { root } = await fixture(t)
  await writeFile(path.join(root, 'spec/ssot/ARCH.md'), '# ARCH Architecture\n> r1 | architecture\n\n## decisions\n- ARCH-1 [o] verification: `npm run verify`\n\n## chg\n- r1 261019 initial\n')
  const state = path.join(root, 'spec/STATE.md')
  await writeFile(state, (await readFile(state, 'utf8')).replace('## log', '## log\n- 261019 fix web: remove floating button gap'))
  const lint = await lintSpec({ targetRoot: root })
  assert.equal(lint.ok, true, lint.errors.join('\n'))
  assert.ok(lint.reviewHints.some((hint) => hint.includes('검증 단계')))
  const status = await vibeStatus({ targetRoot: root, tag: 't060', fetch: false })
  assert.equal(status.concurrency, 'solo'); assert.equal(status.counts.remaining, 3)
  assert.ok(status.next.length <= 3)
})

test('check defaults to the commit persisted by brief, even after a claim commit', async (t) => {
  const { root, initial } = await fixture(t)
  await vibeBrief({ targetRoot: root, task: 'T001' })
  const state = path.join(root, 'spec/STATE.md')
  await writeFile(state, (await readFile(state, 'utf8')).replace(/T001 \| example \| ARCH \| - \| todo/, 'T001 | example | ARCH | - | doing@261019.t060'))
  await git(root, 'add', 'spec/STATE.md'); await git(root, 'commit', '-q', '-m', 'claim')
  assert.notEqual(await git(root, 'rev-parse', 'HEAD'), initial)
  assert.equal((await vibeBrief({ targetRoot: root, task: 'T001' })).diffBase, initial)
  const result = await runVibeCheck({ targetRoot: root, task: 'T001' }, 'node --version')
  assert.equal(result.scope.DIFF_BASE, initial)
})

test('a cancelled heavy check does not wait behind a clone-wide lock', async (t) => {
  const { root } = await fixture(t)
  const controller = new AbortController(); controller.abort()
  await assert.rejects(runVibeCheck({ targetRoot: root, heavy: true, signal: controller.signal }, 'node --version'), /stopped/)
})

test('concurrent final checks share one run across linked worktrees without --heavy', async (t) => {
  const { root, temporary, initial } = await fixture(t)
  const other = path.join(temporary, 'other')
  await git(root, 'worktree', 'add', '--detach', other, initial)
  const counter = path.join(temporary, 'final-runs.txt')
  const command = 'node -e \'require("fs").appendFileSync(process.env.CHECK_COUNT,"x");setTimeout(()=>{},300)\''
  const results = await Promise.all([root, other].map((target) => execute(process.execPath,
    [cli, 'vibe', 'check', '--target', target, '--tier', 'batch', '--diff-base', initial, '--', command],
    { env: { ...process.env, CHECK_COUNT: counter } })))
  const checks = results.map((result) => JSON.parse(result.stdout))
  assert.equal(await readFile(counter, 'utf8'), 'x')
  assert.deepEqual(checks.map((check) => check.cached).sort(), [false, true])
  assert.ok(checks.every((check) => check.ok && check.commit === initial))
})

test('final verification rejects delegated sessions unless explicitly overridden', async (t) => {
  const { root } = await fixture(t)
  const runtime = path.join(root, '.git/gusta/v1')
  await mkdir(runtime, { recursive: true })
  for (const entry of [{ workspace: root }, { review: { workspace: root } }]) {
    await writeFile(path.join(runtime, 'state.json'), JSON.stringify({ schemaVersion: 1, groups: {}, attempts: { example: entry } }))
    await assert.rejects(runVibeCheck({ targetRoot: root, tier: 'batch' }, 'node --version'), /조정자\/호스트/)
    assert.equal((await runVibeCheck({ targetRoot: root, tier: 'task' }, 'node --version')).ok, true)
    assert.equal((await runVibeCheck({ targetRoot: root, tier: 'batch', allowFinal: true }, 'node --version')).ok, true)
  }
  await writeFile(path.join(runtime, 'state.json'), JSON.stringify({ schemaVersion: 1, groups: {}, attempts: {} }))
  await assert.rejects(runVibeCheck({ targetRoot: root, tier: 'group', env: { GUSTA_VIBE_UNIT: '1' } }, 'node --version'), /조정자\/호스트/)
})

test('the task tier refuses the ARCH batch suite; the coordinator runs it once at the batch tier', async (t) => {
  const { root, arch } = await fixture(t)
  // A tier-aware command declared for both tiers stays allowed (the fixture's node --version).
  await writeFile(path.join(root, 'spec/ssot/ARCH.md'), arch.replace('  - batch, before code push: `node --version`.', '  - batch, before code push: `node -e "0"`.'))
  await git(root, 'commit', '-qam', 'split tiers')
  await assert.rejects(runVibeCheck({ targetRoot: root, tier: 'task' }, '  node  -e "0" '), /최종 관문/)
  await assert.rejects(runVibeCheck({ targetRoot: root }, 'node -e "0"'), /최종 관문/)
  assert.equal((await runVibeCheck({ targetRoot: root, tier: 'task' }, 'node --version')).ok, true)
  assert.equal((await runVibeCheck({ targetRoot: root, tier: 'task', allowFinal: true }, 'node -e "0"')).ok, true)
  assert.equal((await runVibeCheck({ targetRoot: root, tier: 'batch' }, 'node -e "0"')).ok, true)
  // The real duration of a final-tier run sizes the next timed loop's closing reserve.
  assert.ok(measured(await readTimings(path.join(root, '.git/gusta/v1')), timingKey('final', 'node -e "0"')) >= 0)
})

test('a final check cannot pass on dirty input or code changed while it ran', async (t) => {
  const { root } = await fixture(t)
  const result = await runVibeCheck({ targetRoot: root, tier: 'batch' }, 'node -e \'require("fs").writeFileSync("app.js","changed")\'')
  assert.equal(result.ok, false)
  assert.equal(result.stale, true)
  assert.equal(result.exitCode, 1)
  await assert.rejects(runVibeCheck({ targetRoot: root, tier: 'batch' }, 'node --version'), /커밋하세요/)
})
