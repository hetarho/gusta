import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { git, inspectWorkspace } from '../src/workspace.mjs'
import { prepareSessionWorkspace, assertImplementationWorkspace, sessionWorkspacePolicy } from '../src/session-workspace.mjs'

async function fixture(t) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'gusta-session-'))), root = path.join(directory, 'project')
  await mkdir(root); await git(root, ['init', '-b', 'stable']); await git(root, ['config', 'user.name', 'Fixture']); await git(root, ['config', 'user.email', 'fixture@example.invalid'])
  await writeFile(path.join(root, 'source.txt'), 'initial\n'); await git(root, ['add', '.']); await git(root, ['commit', '-m', 'fixture'])
  await git(root, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/stable'])
  t.after(() => rm(directory, { recursive: true, force: true }))
  return { root, directory }
}

test('a session owns a child branch and linked checkout without moving the original index or HEAD', async (t) => {
  const { root } = await fixture(t), before = (await inspectWorkspace({ targetRoot: root })).git
  const index = await readFile(path.join(before.gitDir, 'index'))
  const prepared = await prepareSessionWorkspace({ targetRoot: root, kind: 'start', tag: 'aa' })
  assert.equal(prepared.created, true); assert.notEqual(prepared.root, root); assert.equal(prepared.sourceHead, before.head)
  const current = (await inspectWorkspace({ targetRoot: root })).git, child = (await inspectWorkspace({ targetRoot: prepared.root })).git
  assert.equal(current.head, before.head); assert.equal(current.branch, 'stable'); assert.deepEqual(await readFile(path.join(before.gitDir, 'index')), index)
  assert.equal(child.isLinkedWorktree, true); assert.equal(child.branch, prepared.branch)
  await assertImplementationWorkspace({ targetRoot: prepared.root, requireLinked: true })
  const repeated = await prepareSessionWorkspace({ targetRoot: prepared.root, kind: 'start', tag: 'aa' })
  assert.equal(repeated.created, false); assert.equal(repeated.root, prepared.root)
})

test('a dirty original checkout is retained verbatim and cannot be silently omitted from unattended work', async (t) => {
  const { root } = await fixture(t)
  await writeFile(path.join(root, 'source.txt'), 'user edit\n'); await writeFile(path.join(root, 'extra.txt'), 'untracked\n')
  const status = await git(root, ['status', '--porcelain=v1'])
  await assert.rejects(prepareSessionWorkspace({ targetRoot: root, tag: 'bb' }), /미커밋 변경/)
  assert.equal(await git(root, ['status', '--porcelain=v1']), status)
  assert.equal(await readFile(path.join(root, 'source.txt'), 'utf8'), 'user edit\n')
  assert.equal((await inspectWorkspace({ targetRoot: root })).git.worktrees.length, 1)
})

test('configured land, deployment, planning and repository default branches are protected by role rather than a fixed name', async (t) => {
  const { root } = await fixture(t)
  await mkdir(path.join(root, 'spec')); await writeFile(path.join(root, 'spec/SETTINGS.md'), '# SETTINGS\n- land: delivery\n- deploy: published\n- plan: planning\n- coord: coordination\n')
  const policy = await sessionWorkspacePolicy({ targetRoot: root })
  for (const branch of ['stable', 'delivery', 'published', 'planning', 'coordination', 'coordination-integration']) assert.ok(policy.protectedBranches.includes(branch))
  await assert.rejects(assertImplementationWorkspace({ targetRoot: root }), /하위 작업 브랜치/)
  await git(root, ['add', '.']); await git(root, ['commit', '-m', 'policy'])
  await assert.rejects(prepareSessionWorkspace({ targetRoot: root, branch: 'delivery', tag: 'cc' }), /보호 브랜치/)
  await git(root, ['switch', '-c', 'feature-work'])
  await assertImplementationWorkspace({ targetRoot: root })
  await assert.rejects(assertImplementationWorkspace({ targetRoot: root, requireLinked: true }), /전용 worktree/)
})

test('session kinds cannot adopt a different session or create nested checkouts inside source trees', async (t) => {
  const { root } = await fixture(t)
  const first = await prepareSessionWorkspace({ targetRoot: root, kind: 'start', tag: 'dd' })
  const other = await prepareSessionWorkspace({ targetRoot: first.root, kind: 'self-improve', tag: 'ee' })
  assert.equal(other.created, true); assert.notEqual(first.root, other.root)
  await assert.rejects(prepareSessionWorkspace({ targetRoot: root, tag: 'ff', path: path.join(root, 'nested') }), /기존 checkout/)
})

test('Gitless projects receive an actionable preflight instead of an unisolated writing session', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gusta-session-no-git-')); t.after(() => rm(root, { recursive: true, force: true }))
  await assert.rejects(prepareSessionWorkspace({ targetRoot: root, tag: 'gg' }), /커밋이 있는 Git 저장소/)
  assert.equal((await sessionWorkspacePolicy({ targetRoot: root })).reason, 'git-required')
})
