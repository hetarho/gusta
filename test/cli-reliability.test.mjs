import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fixture, git, execute } from './helpers/vibe-fixture.mjs'
import { vibeCheckpoint, vibePreflight, probeFailureKind } from '../src/vibe.mjs'
import { vibeBrief } from '../src/vibe-brief.mjs'
import { workStatus, inspectWork } from '../src/work-groups.mjs'
import { runtimeRoot } from '../src/work-runtime.mjs'
import { inspectWorkspace } from '../src/workspace.mjs'
const cli = fileURLToPath(new URL('../bin/gusta.mjs', import.meta.url))

test('explicit handoff preserves unverified WIP remotely when final push is disabled and retries unchanged snapshots', async (t) => {
  const { root, temporary, initial } = await fixture(t)
  const remote = path.join(temporary, 'remote.git')
  await execute('git', ['init', '--bare', '-q', remote])
  await git(root, 'remote', 'add', 'origin', remote)
  await writeFile(path.join(root, 'unfinished.txt'), 'still fails verification\n')
  const index = await git(root, 'write-tree')
  const local = await vibeCheckpoint({ targetRoot: root, tag: 'save' })
  assert.equal(local.pushed, false)
  const result = JSON.parse((await execute(process.execPath, [cli, 'vibe', 'checkpoint', '--target', root, '--tag', 'save', '--handoff', '--next', 'Resume the remaining repairs.'])).stdout)
  assert.equal(result.ok, true)
  assert.equal(result.changed, false)
  assert.equal(result.commit, local.commit)
  assert.equal(result.remoteBranch, 'origin/wip/save')
  assert.deepEqual(result.verification, { status: 'unverified', checksRun: false })
  assert.equal(result.next, 'Resume the remaining repairs.')
  assert.equal((await execute('git', ['--git-dir', remote, 'show', 'wip/save:unfinished.txt'])).stdout, 'still fails verification\n')
  assert.equal(await git(root, 'rev-parse', 'HEAD'), initial)
  assert.equal(await git(root, 'write-tree'), index)
  assert.equal((await vibeCheckpoint({ targetRoot: root, tag: 'save', handoff: true })).pushed, true)
})

test('failed handoff keeps a local snapshot and explicitly reports remote failure', async (t) => {
  const { root, temporary } = await fixture(t)
  await git(root, 'remote', 'add', 'origin', path.join(temporary, 'absent.git'))
  await writeFile(path.join(root, 'unfinished.txt'), 'preserve\n')
  const result = await vibeCheckpoint({ targetRoot: root, tag: 'save', handoff: true })
  assert.equal(result.ok, false)
  assert.equal(result.pushed, false)
  assert.ok(result.pushError)
  assert.equal(await git(root, 'show', `${result.commit}:unfinished.txt`), 'preserve')
})

test('unchanged handoff preserves remote-only and newer remote snapshots in the local source ref', async (t) => {
  const { root, temporary, initial } = await fixture(t)
  const remote = path.join(temporary, 'remote.git')
  await execute('git', ['init', '--bare', '-q', remote])
  await git(root, 'remote', 'add', 'origin', remote)
  const first = await vibeCheckpoint({ targetRoot: root, tag: 'save', handoff: true })
  await git(root, 'update-ref', '-d', 'refs/heads/wip/save')
  const restored = await vibeCheckpoint({ targetRoot: root, tag: 'save', handoff: true })
  assert.equal(restored.changed, false)
  assert.equal(restored.pushed, true)
  assert.equal(await git(root, 'rev-parse', 'refs/heads/wip/save'), first.commit)
  const tree = await git(root, 'rev-parse', `${first.commit}^{tree}`)
  const newer = await git(root, 'commit-tree', tree, '-p', first.commit, '-m', 'remote progress snapshot')
  await git(root, 'push', '-q', 'origin', `${newer}:refs/heads/wip/save`)
  assert.equal(await git(root, 'rev-parse', 'refs/heads/wip/save'), first.commit)
  const latest = await vibeCheckpoint({ targetRoot: root, tag: 'save', handoff: true })
  assert.equal(latest.commit, newer)
  assert.equal(latest.changed, false)
  assert.equal(latest.pushed, true)
  assert.equal(await git(root, 'rev-parse', 'refs/heads/wip/save'), newer)
  assert.equal(await git(root, 'rev-parse', 'HEAD'), initial)
})

test('default work status excludes nested execution history and completed groups; details preserve internal records', async (t) => {
  const { root } = await fixture(t)
  const runtime = runtimeRoot(await inspectWorkspace({ targetRoot: root }))
  await mkdir(runtime, { recursive: true })
  const large = 'saved execution material '.repeat(30000)
  const saved = { schemaVersion: 1, groups: { active: { id: 'active', branch: 'work/active', path: root, status: 'active', brief: large }, old: { id: 'old', status: 'complete', history: large } },
    attempts: { a: { id: 'a', group: 'active', taskId: 'T001', tasks: ['T001'], status: 'doing', owner: 'worker', tag: 'unit', reason: large, workspace: root, dispatch: { status: 'running', log: '/tmp/worker.log', brief: large }, reviewHistory: [{ summary: large }] } }, history: [{ note: large }] }
  await writeFile(path.join(runtime, 'state.json'), JSON.stringify(saved))
  const result = JSON.parse((await execute(process.execPath, [cli, 'work', 'status', '--target', root])).stdout)
  assert.equal(result.view, 'summary')
  assert.equal(result.currentAttempt.taskId, 'T001')
  assert.equal(result.currentAttempt.owner, 'worker')
  assert.equal(result.currentAttempt.tag, 'unit')
  assert.equal(result.currentAttempt.reasonTruncated, true)
  assert.equal(result.currentAttempt.dispatch.log, '/tmp/worker.log')
  assert.equal(result.currentAttempt.dispatch.brief, undefined)
  assert.equal(result.groups.length, 1)
  assert.equal(result.counts.groups, 2)
  assert.ok(JSON.stringify(result).length < 3000)
  assert.equal((await workStatus({ targetRoot: root, details: true })).attempts[0].dispatch.brief, large)
  assert.equal((await inspectWork({ targetRoot: root })).attempts[0].dispatch.brief, large)
})

test('brief discovery and stable pages preserve every whole decision and supporting section', async (t) => {
  const { root } = await fixture(t)
  const full = await vibeBrief({ targetRoot: root, task: 'T001' })
  const summary = await vibeBrief({ targetRoot: root, task: 'T001', summary: true, limit: 1 })
  assert.equal(summary.complete, false)
  assert.equal(summary.sourceComplete, true)
  assert.equal(summary.page.total, full.decisions.length)
  assert.equal(summary.page.returned, 1)
  assert.equal(summary.page.remaining, full.decisions.length - 1)
  assert.equal(summary.entries[0].text, undefined)
  assert.ok(JSON.stringify(summary).length < 4000)
  const decisions = []
  for (let offset = 0; offset < full.decisions.length; offset++) {
    const page = await vibeBrief({ targetRoot: root, task: 'T001', section: 'decisions', offset, limit: 1, snapshot: summary.snapshot })
    decisions.push(...page.entries)
  }
  assert.deepEqual(decisions, full.decisions)
  for (const section of ['tasks', 'sections', 'history', 'issues']) {
    const page = await vibeBrief({ targetRoot: root, task: 'T001', section, snapshot: summary.snapshot })
    assert.deepEqual(page.entries, full[section])
  }
  const output = await execute(process.execPath, [cli, 'vibe', 'brief', 'T001', '--target', root, '--summary'])
  assert.match(output.stdout, /readingComplete:no/)
  await writeFile(path.join(root, 'spec/ssot/ARCH.md'), `${await readFile(path.join(root, 'spec/ssot/ARCH.md'), 'utf8')}\n`)
  await assert.rejects(vibeBrief({ targetRoot: root, task: 'T001', section: 'decisions', snapshot: summary.snapshot }), /원본이 변경/)
  await assert.rejects(vibeBrief({ targetRoot: root, task: 'T001', summary: true, limit: 0 }), /1-100/)
})

test('current-checkout probe uses installed dependencies and returns distinct actionable failure categories', async (t) => {
  const { root, temporary } = await fixture(t)
  const bin = path.join(temporary, 'bin')
  await mkdir(bin)
  await mkdir(path.join(root, 'node_modules'), { recursive: true })
  await writeFile(path.join(root, 'node_modules/installed'), 'present')
  const fake = path.join(bin, 'claude')
  await writeFile(fake, `#!/usr/bin/env node\nif (process.argv.includes('--help')) { console.log('--strict-mcp-config'); process.exit(0) }\nconst installed = require('fs').existsSync('node_modules/installed')\nconst note = process.env.PROBE_NOTE || (installed ? 'ready' : 'MODULE_NOT_FOUND dependency')\nconst denied = note === 'permission denied'\nconsole.log(JSON.stringify({ structured_output: { ran: !denied, denied, exitCode: note === 'ready' ? 0 : 1, note } }))\n`)
  await chmod(fake, 0o755)
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` }
  const options = { targetRoot: root, probe: 'node --version', probeWorkspace: 'current', provider: 'claude', env }
  const first = (await vibePreflight(options)).checks.find((check) => check.name === 'worker-probe')
  assert.equal(first.ok, true)
  assert.equal(first.workspace, root)
  assert.equal(first.workspaceMode, 'current')
  assert.equal((await git(root, 'worktree', 'list', '--porcelain')).split('worktree ').length - 1, 1)
  for (const [note, kind] of [['MODULE_NOT_FOUND dependency', 'dependency'], ['fetch failed: ENOTFOUND', 'network'], ['permission denied', 'permission']]) {
    const probe = (await vibePreflight({ ...options, env: { ...env, PROBE_NOTE: note } })).checks.find((check) => check.name === 'worker-probe')
    assert.equal(probe.failureKind, kind)
    assert.equal(probe.ok, false)
    assert.equal(probe.workspace, root)
  }
  await assert.rejects(vibePreflight({ ...options, probeWorkspace: 'unknown' }), /current 또는 new/)
  assert.equal(probeFailureKind({ note: 'exit 1: assertion failed' }), 'command')
})

test('summary and pages alone preserve standalone verification instructions and the original task diff base', async (t) => {
  const { root, initial } = await fixture(t)
  const summary = await vibeBrief({ targetRoot: root, task: 'T001', summary: true })
  assert.equal(summary.diffBase, initial)
  assert.deepEqual(summary.verify.task, ['node --version'])
  assert.deepEqual(summary.touches, ['src/'])
  assert.equal(summary.freshness[0].stale, false)
  await writeFile(path.join(root, 'implementation.txt'), 'first change')
  await git(root, 'add', 'implementation.txt')
  await git(root, 'commit', '-q', '-m', 'implementation')
  assert.notEqual(await git(root, 'rev-parse', 'HEAD'), initial)
  const page = await vibeBrief({ targetRoot: root, task: 'T001', section: 'tasks' })
  assert.equal(page.diffBase, initial)
  assert.deepEqual(page.verify.batch, ['node --version'])
  assert.equal(JSON.parse(await readFile(path.join(root, '.git/gusta-task-start.json'), 'utf8')).diffBase, initial)
})

test('custom verification guidance is discoverable and fully readable through bounded snapshot pages', async (t) => {
  const { root } = await fixture(t)
  const full = await vibeBrief({ targetRoot: root, task: 'T001' })
  assert.ok(full.verify.guidance.some((line) => line.includes('affected Chromium specs')))
  const summary = await vibeBrief({ targetRoot: root, task: 'T001', summary: true })
  assert.equal(summary.verify.guidanceSection, 'guidance')
  assert.equal(summary.counts.guidance, full.verify.guidance.length)
  const guidance = []
  for (let offset = 0; offset < summary.counts.guidance; offset++) {
    const page = await vibeBrief({ targetRoot: root, task: 'T001', section: summary.verify.guidanceSection, offset, limit: 1, snapshot: summary.snapshot })
    assert.equal(page.page.returned, 1)
    assert.equal(page.page.remaining, summary.counts.guidance - offset - 1)
    guidance.push(...page.entries)
  }
  assert.deepEqual(guidance, full.verify.guidance)
  const result = JSON.parse((await execute(process.execPath, [cli, 'vibe', 'brief', 'T001', '--target', root, '--section', 'guidance', '--limit', '1', '--snapshot', summary.snapshot, '--json'])).stdout)
  assert.deepEqual(result.entries, full.verify.guidance.slice(0, 1))
})
