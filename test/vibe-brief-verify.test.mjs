import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fixture, git } from './helpers/vibe-fixture.mjs'
import { vibeBrief, verificationTiers } from '../src/vibe-brief.mjs'
import { renderBrief } from '../src/spec-context.mjs'

// ARCH with verification decisions but no task/batch/CI tier lines: a task-done condition, two
// before-push command lists, prose that keeps the full suite for push, and decisions that must
// stay out (not a check, open, rejected).
const UNDECLARED = `# ARCH Architecture
> r1 | Architecture

## decisions
- ARCH-1 [o] stack: web client and server API in one repository
- ARCH-2 [o] task done: acceptance plus relevant lint, formatter and build/type checks must pass; record the selected commands in the task result
- ARCH-3 [o] before push, web: \`fake web test\`, \`fake web lint\`, \`fake web build\`
- ARCH-4 [o] before push, server: \`fake fmt --check\`, \`fake vet\`, \`fake build\`, \`fake test ./...\`
- ARCH-5 [o] the full suite and the production build run once before push, not per task
  - a task runs the affected tests only
- ARCH-6 [o] rebase onto the target branch before push
- ARCH-7 [?] browser end-to-end checks before push or only in CI
- ARCH-8 [x] every task runs the full suite
- ARCH-9 [o] release flow: work lands on the target branch through review
  - the whole test suite and the build pass before merge

## chg
- r1 261101 initial
`
const GATES = ['- ARCH-3 [o] before push, web:', '- ARCH-4 [o] before push, server:', '- ARCH-5 [o] the full suite', '  - a task runs the affected tests only', '- ARCH-9 [o] release flow:', '  - the whole test suite and the build pass before merge']

test('undeclared tiers: the task condition carries every final-gate decision whole, and says what it left out', () => {
  const tiers = verificationTiers(UNDECLARED)
  assert.equal(tiers.declared, false); assert.equal(tiers.partial, false)
  assert.ok(tiers.guidance.some((line) => line.startsWith('- ARCH-2 [o] task done')))
  for (const gate of GATES) assert.ok(tiers.guidance.some((line) => line.startsWith(gate)), gate)
  // a gate block is prose: its backticked commands are not tier commands
  assert.deepEqual([tiers.task, tiers.batch, tiers.ci], [[], [], []])
  assert.ok(!tiers.guidance.some((line) => /ARCH-[168]\b/.test(line)))
  assert.deepEqual(tiers.excluded, [{ id: 'ARCH-7', reason: 'open' }, { id: 'ARCH-8', reason: 'rejected' }])
})

test('declared tiers keep the keyword scan: a before-push block outside it is not added', async (t) => {
  const { arch } = await fixture(t, 1)
  const tiers = verificationTiers(arch.replace('\n## chg', '- ARCH-3 [o] before push, web: `fake web build`\n\n## chg'))
  assert.equal(tiers.declared, true)
  assert.deepEqual([tiers.task, tiers.batch, tiers.ci], [['node --version'], ['node --version'], []])
  assert.deepEqual(tiers.guidance, ['- ARCH-2 [o] Verification runs in three tiers.', '  - UI changes additionally run only affected Chromium specs.', '  - CI, after push: GitHub Actions.'])
  assert.deepEqual(tiers.excluded, [])
})

async function undeclaredProject(t, cfg) {
  const { root } = await fixture(t, 1)
  await writeFile(path.join(root, 'spec/ssot/ARCH.md'), UNDECLARED)
  await writeFile(path.join(root, 'spec/ssot/WEB.md'), '# WEB web client\n> r1 | pages\n\n## decisions\n- WEB-1 [o] the home page lists recent items\n\n## chg\n- r1 261101 initial\n')
  await writeFile(path.join(root, 'spec/tasks/T001.example.md'), '# T001 Example\n> st:todo | ssot:WEB-1 | base:WEB@1 | dep:- | touches:src/\n\n## goal\nList items.\n\n## acceptance\n- [ ] Works with a regression test.\n\n## impl notes\n- -\n\n## result\n')
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { lint: 'fake lint', 'format:check': 'fake format', test: 'fake test' } }))
  const state = path.join(root, 'spec/STATE.md')
  if (cfg) await writeFile(state, (await readFile(state, 'utf8')).replace(/^- always: .*$/m, cfg))
  await git(root, 'add', '-A'); await git(root, 'commit', '-q', '-m', 'undeclared')
  return root
}

test('unit brief with narrowed global rules: gates ride in the guidance, inferred tiers and left-out decisions are named', async (t) => {
  const root = await undeclaredProject(t, '- always: ARCH-1 ARCH-2')
  const brief = await vibeBrief({ targetRoot: root, task: 'T001' })
  assert.deepEqual(brief.decisions.map((entry) => entry.id), ['WEB-1', 'ARCH-1', 'ARCH-2'])
  assert.deepEqual(brief.verify.inferred, ['task', 'batch'])
  const text = renderBrief(brief)
  const verify = text.slice(text.indexOf('\n## verify'))
  assert.match(verify, /\n- declared: no — task, batch inferred from package\.json scripts\n- task: `npm run lint` `npm run format:check`\n- batch: `npm run test`\n/)
  // the task condition is shown once (in decisions), each gate line once (in guidance)
  assert.equal(text.split('- ARCH-2 [o] task done').length, 2)
  for (const gate of GATES) assert.ok(verify.includes(`- guidance: ${gate.trim().replace(/^- /, '')}`), gate)
  assert.ok(!text.includes('rebase onto'))
  assert.match(verify, /\n- not in guidance: ARCH-7\(open\) ARCH-8\(rejected\)\n/)
  const summary = await vibeBrief({ targetRoot: root, task: 'T001', summary: true })
  assert.deepEqual([summary.verify.declared, summary.verify.inferred, summary.verify.excluded.map((entry) => entry.id)], [false, ['task', 'batch'], ['ARCH-7', 'ARCH-8']])
})

test('unit brief with the whole ARCH as global rules repeats no gate line in the guidance', async (t) => {
  const root = await undeclaredProject(t)
  const text = renderBrief(await vibeBrief({ targetRoot: root, task: 'T001' }))
  for (const gate of ['- ARCH-3 [o] before push, web:', '- ARCH-5 [o] the full suite']) assert.equal(text.split(gate).length, 2, gate)
  assert.ok(!text.includes('- guidance: ARCH-'))
  assert.match(text, /\n- declared: no — task, batch inferred from package\.json scripts\n/)
})
