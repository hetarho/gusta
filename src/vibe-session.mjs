// The context every session tool starts from: the checkout, its STATE, its SETTINGS and the
// branches they name. Its own module so that coordination, briefs and work groups can build it
// without importing the vibe commands (which import them).
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { inspectWorkspace, git } from './workspace.mjs'
import { runtimeRoot } from './work-runtime.mjs'
import { readSettings, branchPlan, defaultBranch } from './settings.mjs'
import { SkillPackageError } from './errors.mjs'

const fail = (message, details = []) => { throw new SkillPackageError(message, details) }

// Where finished work goes, from spec/SETTINGS.md (legacy STATE cfg push/plan as fallback):
// target is the branch `vibe push` publishes (push: true), land the branch work lands on.
// Unset or push: false commits only. inspection: a workspace the caller already inspected.
// unborn: also a Git repository without a commit yet (branch is the unborn branch's name). Session
// coordination needs no commit — its branch is an orphan — so its commands pass true; everything
// that moves code needs HEAD and keeps the default.
export async function vibeSession(options = {}, { unborn = false } = {}) {
  const workspace = options.inspection ?? await inspectWorkspace(options)
  if (!workspace.git || (!workspace.git.head && !unborn)) fail('커밋이 있는 Git checkout이 필요합니다.')
  const root = workspace.git.root
  const state = await readFile(path.join(root, 'spec/STATE.md'), 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  const settings = await readSettings({ root })
  const remotes = (await git(root, ['remote'])).split('\n').map((line) => line.trim()).filter(Boolean)
  const remote = options.remote ?? (remotes.includes('origin') ? 'origin' : remotes[0] ?? null)
  if (options.remote && !remotes.includes(options.remote)) fail(`원격이 없습니다: ${options.remote}`)
  const branches = branchPlan(settings.values, { branch: workspace.git.branch, defaultBranch: await defaultBranch(root) })
  const target = branches.pushTarget
  return { workspace, root, state, settings, branches, push: target ?? '-', remote, target, branch: workspace.git.branch, runtime: runtimeRoot(workspace) }
}
