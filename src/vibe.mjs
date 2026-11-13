import { readFile, writeFile, readdir, mkdir, mkdtemp, rm, access, realpath } from 'node:fs/promises'
import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { inspectWorkspace, git, batchShow } from './workspace.mjs'
import { sections, tableRows, quoteLine, quoteFields, exploreValue, runValue, SESSION_TAG, TASK_ID, TASK_ST } from './spec-format.mjs'
import { activeRows, upsertActive, mergeState } from './state-doc.mjs'
import { inboxEntries, STALE_MINUTES } from './coord-doc.mjs'
import { coordView, beatSession, claimSession, recordLanded, recordCheckpoint, assertCoordinator, assertSessionTag, isDelegated, commitOnRemote, wipTime, hostName } from './vibe-coord.mjs'
import { designOf } from './interactive-state.mjs'
import { workingTree, checkKey, cachedPass, recordPass, withHeavyLock, readTimings, taskTimingRows, taskCheckSummary } from './check-cache.mjs'
import { runtimeRoot } from './work-runtime.mjs'
import { lintSpec } from './spec-lint.mjs'
import { workInternals } from './work-groups.mjs'
import { stateMergeArgs } from './git-merge.mjs'
import { SkillPackageError } from './errors.mjs'
import { readSettings, readSetting, permissionMode, agentList } from './settings.mjs'
import { vibeSession } from './vibe-session.mjs'
import { runVibeCheck, resetVibeGate } from './vibe-check.mjs'
import { readVerification } from './vibe-brief.mjs'
import { vibeCIWait, githubRepository } from './vibe-ci.mjs'
import { providerFlags } from './work-providers.mjs'
import { claudeOptionalFlags, claudeEffort, providerEnvironment } from './agent-adapter.mjs'
import { agentCatalog } from './agent-catalog.mjs'
import { routeAgent, runLabel } from './agent-route.mjs'
import { loopHint } from './loop-control.mjs'
import { BOOKKEEPING, bumpGate, versionBump, beyondVersion } from './version-bump.mjs'
import { fingerprintVerificationCheck } from './verification-plan.mjs'

export { vibeSession }
const execute = promisify(execFile)
const fail = (message, details = []) => { throw new SkillPackageError(message, details) }
export const minuteNow = () => `${new Date().toISOString().slice(0, 16)}Z`

export function cfgOf(text) {
  const map = new Map()
  for (const line of sections(text).get('cfg') ?? []) {
    const match = line.match(/^-\s+([\w-]+):\s*([^#]*)/)
    if (match) map.set(match[1], match[2].trim())
  }
  return map
}

async function readOptional(file) {
  try { return await readFile(file, 'utf8') } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

export const exists = async (root, ref) => Boolean((await git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], [1]))?.trim())
export const sha = async (root, ref) => (await git(root, ['rev-parse', '--verify', `${ref}^{commit}`])).trim()
export const ancestor = async (root, older, newer) => (await git(root, ['merge-base', '--is-ancestor', older, newer], [1])) !== null

// Fetch one branch; a branch the remote does not have is an answer, a network failure is not.
export async function fetchBranch(root, remote, source, target) {
  try {
    await execute('git', ['-C', root, 'fetch', '--quiet', remote, `+${source}:${target}`], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } })
    return true
  } catch (error) {
    if (/couldn't find remote ref|no such ref/i.test(error.stderr ?? '')) return false
    return fail(`원격 ${remote}에서 가져오지 못했습니다.`, [(error.stderr || error.message).trim()])
  }
}

// Move a local branch forward to commit: only a fast-forward and, where the branch is checked
// out, only in a clean checkout (merged there with --ff-only).
export async function advanceBranch(context, branch, commit) {
  const { root } = context
  const ref = `refs/heads/${branch}`
  if (!(await exists(root, ref))) return 'absent'
  const old = await sha(root, ref)
  if (old === commit) return 'current'
  if (!(await ancestor(root, old, commit))) return 'diverged'
  const holder = context.workspace.git.worktrees.find((tree) => tree.branch === branch)
  if (holder && await realpath(holder.path).catch(() => holder.path) === root) return 'self'
  try {
    if (!holder) await git(root, ['update-ref', ref, commit, old])
    else if ((await git(holder.path, ['status', '--porcelain', '--untracked-files=no'])).trim()) return 'dirty'
    else await git(holder.path, ['merge', '--ff-only', '--quiet', commit])
    return 'ff'
  } catch { return 'moved' }
}

// Code that changed after the final gate is not what was verified (spec bookkeeping aside, and
// with SETTINGS version auto the version value the CLI itself raised on top of the verified commit).
async function assertVerified(context, verifiedCommit, commit) {
  if (!verifiedCommit) return
  const { root } = context
  const verified = await sha(root, verifiedCommit)
  if (verified === commit) return
  const files = (await git(root, ['diff', '--name-only', verified, commit])).trim().split('\n').filter(Boolean)
  let changed = files.filter((file) => !BOOKKEEPING.test(file))
  if (changed.length && context.settings.values.version === 'auto') changed = await beyondVersion(root, verified, commit, changed)
  if (changed.length) fail('최종 검증 이후 코드가 변경됐습니다. 합친 현재 결과를 다시 검증한 뒤 반영하세요.', changed)
  if (!files.some((file) => BOOKKEEPING.test(file))) return
  // Bookkeeping is normally exempt, but a structured check may explicitly consume it (or all
  // inputs). Compare the same committed input boundary rather than waiving it by file category.
  const verificationAt = async (ref) => readVerification(root, await git(root, ['show', `${ref}:spec/ssot/ARCH.md`], [128]) ?? '', {
    readSource: (file) => git(root, ['show', `${ref}:${file}`], [128]),
  })
  const [before, after] = await Promise.all([verificationAt(verified), verificationAt(commit)])
  if (!before.plan && !after.plan) return
  const oldChecks = before.plan?.checks.filter((check) => check.tier === 'batch')
  const checks = after.plan?.checks.filter((check) => check.tier === 'batch')
  if (!before.plan || !after.plan || before.plan.source !== after.plan.source || JSON.stringify(oldChecks) !== JSON.stringify(checks)) fail('최종 검증 이후 검사 계획의 정의가 변경됐습니다. 현재 후보를 다시 검증하세요.')
  for (const [index, check] of checks.entries()) {
    const [was, now] = await Promise.all([
      fingerprintVerificationCheck(root, before.plan, oldChecks[index], { ref: verified, scope: {}, env: {} }),
      fingerprintVerificationCheck(root, after.plan, check, { ref: commit, scope: {}, env: {} }),
    ])
    if (!was.verifiable || !now.verifiable || was.inputFingerprint !== now.inputFingerprint) fail('최종 검증 이후 검사 계획의 실제 입력이 변경됐거나 이전 입력을 확인할 수 없습니다. 현재 후보를 다시 검증하세요.', [check.id])
  }
}

// The version commit this landing owes (SETTINGS version), built on head: { commit, version }.
// Nothing points at the commit until the caller lands it, so a failed landing leaves no trace.
async function bumpFor(context, command, base, head) {
  const skipped = bumpGate(context.settings.values, context.branches, command)
  return skipped ? { commit: null, version: { skipped } } : versionBump(context.root, { base, head })
}

// Bring this checkout onto the bump it just landed. One that cannot take it (uncommitted manifest
// edits) stays behind and receives it with the next sync.
const adoptBump = (root, bump) => !bump.commit ? bump.version
  : git(root, ['merge', '--ff-only', '--quiet', bump.commit]).then(() => bump.version, () => ({ ...bump.version, checkout: 'behind' }))

// advanceBranch, also where this checkout holds the branch (a fast-forward merge here).
async function forwardBranch(context, branch, commit) {
  const moved = await advanceBranch(context, branch, commit)
  return moved !== 'self' ? moved : git(context.root, ['merge', '--ff-only', '--quiet', commit]).then(() => 'ff', () => 'dirty')
}

async function unmerged(root) {
  return (await git(root, ['diff', '--name-only', '--diff-filter=U'], [128]) ?? '').split('\n').filter(Boolean)
}

export async function vibeMergeState([base, ours, theirs]) {
  if (!base || !ours || !theirs) fail('merge-state <base> <ours> <theirs>')
  const result = mergeState(await readFile(base, 'utf8'), await readFile(ours, 'utf8'), await readFile(theirs, 'utf8'))
  await writeFile(ours, result.text)
  return result
}

// Bring the remote push branch into HEAD: fast-forward, or replay local commits on top
// (rebase on the push branch itself, merge on any other branch). STATE merges by section.
export async function vibeSync(options = {}) {
  const context = await vibeSession(options)
  if (!context.remote) return { schemaVersion: 1, ok: true, action: 'none', reason: 'no-remote' }
  if (!context.target) return { schemaVersion: 1, ok: true, action: 'none', reason: 'push-disabled' }
  const { root, remote, target } = context
  if (!(await fetchBranch(root, remote, `refs/heads/${target}`, `refs/remotes/${remote}/${target}`))) {
    return { schemaVersion: 1, ok: true, action: 'none', reason: 'remote-branch-missing', target }
  }
  const upstream = `refs/remotes/${remote}/${target}`
  const head = await sha(root, 'HEAD')
  const theirs = await sha(root, upstream)
  if (await ancestor(root, theirs, head)) return { schemaVersion: 1, ok: true, action: 'none', head, target }
  if ((await git(root, ['status', '--porcelain', '--untracked-files=no'])).trim()) fail('커밋하지 않은 변경이 있어 원격을 가져올 수 없습니다. 먼저 커밋하세요.')
  if (await ancestor(root, head, theirs)) {
    if (!context.branch) fail('detached HEAD는 fast-forward할 수 없습니다.')
    await git(root, ['merge', '--ff-only', '--quiet', upstream])
    return { schemaVersion: 1, ok: true, action: 'ff', head: await sha(root, 'HEAD'), target }
  }
  const action = context.branch === target ? 'rebase' : 'merge'
  try {
    await git(root, [...await stateMergeArgs(context.root, context.runtime), ...(action === 'rebase' ? ['rebase', '--quiet', upstream] : ['merge', '--no-edit', '--quiet', upstream])])
  } catch (error) {
    const conflicts = await unmerged(root)
    await git(root, [action, '--abort'], [1, 128])
    fail(`원격 ${target}과 충돌했습니다. 직접 ${action}해 충돌을 해결하세요.`, conflicts.length ? conflicts : [error.stderr || error.message])
  }
  return { schemaVersion: 1, ok: true, action, head: await sha(root, 'HEAD'), target }
}

// Final integration uses the candidate after sync/merge. A project without spec/ stays supported;
// an existing but incomplete spec is an error. WIP checkpoint/handoff does not call this gate.
async function assertSpecClose(root, commit) {
  const spec = await git(root, ['ls-tree', '-z', commit, '--', 'spec'])
  if (!spec) return
  if (!spec.startsWith('040000 tree ')) fail('spec lint 실패: spec/은 디렉터리여야 합니다.')
  const entries = (await git(root, ['ls-tree', '--name-only', '-z', `${commit}:spec`])).split('\0').filter(Boolean)
  // SETTINGS alone configures branch movement without bootstrapping a spec document tree.
  if (entries.every((name) => name === 'SETTINGS.md')) return
  // Publication sends this commit, not the index or working tree. Snapshot only Markdown spec
  // inputs so unrelated dirty files remain supported and an unstaged repair cannot mask HEAD.
  const files = (await git(root, ['ls-tree', '-r', '--name-only', '-z', commit, '--', 'spec'])).split('\0').filter((file) => file.endsWith('.md'))
  const candidate = await mkdtemp(path.join(os.tmpdir(), 'gusta-spec-close-'))
  try {
    const specs = files.map((file) => `${commit}:${file}`)
    const contents = await batchShow(root, specs)
    await Promise.all(files.map(async (file, index) => {
      const destination = path.join(candidate, file)
      await mkdir(path.dirname(destination), { recursive: true })
      await writeFile(destination, contents[index] ?? await git(root, ['show', specs[index]]))
    }))
    const { errors } = await lintSpec({ targetRoot: candidate, readSource: (file) => git(root, ['show', `${commit}:${file}`], [128]) })
    const issues = await specCloseIssues(candidate)
    if (errors.length || issues.length) fail(`${errors.length ? 'spec lint' : 'spec close'} 실패: 문서 구조와 마감 상태를 고친 뒤 최종 반영하세요. 원격 인계는 vibe checkpoint --handoff를 사용하세요.`, [...errors, ...issues.map((issue) => `${issue.where} ${issue.id}: ${issue.reason ?? `invalid st:${issue.st ?? '(none)'}`}`)].slice(0, 10))
  } finally { await rm(candidate, { recursive: true, force: true }) }
}

// The land branch holds `commit` now: the finished tasks in its tree leave the coordination
// branch's unlanded table (result.coordination, only when some were waiting). The landing itself
// already succeeded, so a coordination failure is reported and never thrown.
async function settleLanded(context, result, commit) {
  const coordination = await recordLanded(context, commit).catch((error) => ({ error: error.message }))
  return coordination ? { ...result, coordination } : result
}

// Land HEAD the way SETTINGS says: land-via pr opens a PR into land; push: true publishes to the
// push branch (a rejection means someone pushed first — sync and retry); otherwise a land branch
// other than this one takes the work as a local merge. Nothing to do is not an error.
// version auto adds the bump on top of the verified HEAD when land is the release branch; every
// retry syncs and decides again from the new remote tip, so a version never rises twice.
export async function vibePush(options = {}) {
  const context = await vibeSession(options)
  const { branches } = context
  if (!context.target && !branches.landTarget) {
    // Land is this branch and nothing is pushed: what is committed here has landed. An undecided
    // land commits on the current branch too (gusta-start), so it lands the same way — or its
    // finished tasks would wait in unlanded for good.
    return settleLanded(context, { schemaVersion: 1, ok: true, pushed: null, reason: branches.unset ? 'land-unset' : 'push-disabled' }, 'HEAD')
  }
  if (await designOf(context.workspace)) fail('이 checkout은 디자인 중입니다(vibe design). 사용자에게 디자인이 끝났는지 확인하고 gusta-design-mode 마감(vibe design verify → end → 커밋) 뒤 push하세요.')
  if (branches.via === 'pr' && branches.landTarget) return landByPR(context, options)
  if (!context.target) return landLocal(context, options)
  if (!context.remote) fail('push할 원격이 없습니다. spec/SETTINGS.md push를 false로 두거나 원격을 추가하세요.')
  let last
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const synced = await vibeSync(options)
    const head = await sha(context.root, 'HEAD')
    await assertVerified(context, options.verifiedCommit, head)
    await assertSpecClose(context.root, head)
    const tracking = `refs/remotes/${context.remote}/${context.target}`
    const tip = await exists(context.root, tracking) ? await sha(context.root, tracking) : undefined
    const bump = await bumpFor(context, 'push', synced.reason === 'remote-branch-missing' ? null : tip, head)
    const pushed = bump.commit ?? head
    try {
      const diffBase = options.diffBase ?? tip
      await git(context.root, ['push', '--quiet', context.remote, `${pushed}:refs/heads/${context.target}`])
      const result = await settleLanded(context, { schemaVersion: 1, ok: true, pushed, diffBase, target: context.target, remote: context.remote, attempts: attempt, sync: synced.action, version: await adoptBump(context.root, bump) }, pushed)
      if (options.waitCi) {
        try { result.ci = await vibeCIWait({ ...options, diffBase, commit: pushed, branch: context.target }); result.ok = result.ci.ok }
        catch (error) { result.ok = false; result.ci = { ok: false, outcome: 'error', error: error.message } }
      }
      return result
    } catch (error) {
      last = error.stderr || error.message
      if (!/rejected|non-fast-forward|fetch first|stale info/i.test(last)) break
    }
  }
  return fail('push하지 못했습니다.', [last])
}

// push: false with land on another branch: take land in first (STATE by section) so land itself
// only fast-forwards, then move the local land branch to HEAD.
async function landLocal(context, options) {
  const { root } = context
  const land = context.branches.landTarget
  const ref = `refs/heads/${land}`
  if (!(await exists(root, ref))) fail(`land 브랜치 ${land}가 없습니다. 브랜치를 만들거나 /gusta-preference로 land를 고치세요.`)
  if ((await git(root, ['status', '--porcelain', '--untracked-files=no'])).trim()) fail('커밋하지 않은 변경이 있습니다. 먼저 커밋하세요.')
  let merged = false
  if (!(await ancestor(root, ref, 'HEAD'))) {
    try { await git(root, [...await stateMergeArgs(root, context.runtime), 'merge', '--no-edit', '--quiet', ref]); merged = true } catch (error) {
      const conflicts = await unmerged(root)
      await git(root, ['merge', '--abort'], [1, 128])
      fail(`${land}과 충돌했습니다. 직접 merge해 충돌을 해결한 뒤 다시 반영하세요.`, conflicts.length ? conflicts : [error.stderr || error.message])
    }
  }
  const head = await sha(root, 'HEAD')
  await assertVerified(context, options.verifiedCommit, head)
  await assertSpecClose(root, head)
  const bump = await bumpFor(context, 'push', await sha(root, ref), head)
  const landed = bump.commit ?? head
  const moved = await advanceBranch(context, land, landed)
  if (['dirty', 'diverged', 'moved'].includes(moved)) fail(`${land}에 반영하지 못했습니다(${moved === 'dirty' ? '그 브랜치 checkout에 커밋하지 않은 변경' : '그 사이 브랜치가 움직임'}). 다시 실행하세요.`, [landed])
  return settleLanded(context, { schemaVersion: 1, ok: true, pushed: null, landed, target: land, mode: 'local', merged, local: moved, version: await adoptBump(root, bump) }, landed)
}

// land-via pr: publish this branch and open a PR into land (gh when available; otherwise the
// caller opens it from base/head).
async function landByPR(context, options) {
  const { root, remote, branch } = context
  const land = context.branches.landTarget
  if (!remote) fail('PR을 올릴 원격이 없습니다.')
  if (!branch) fail('detached HEAD는 PR로 올릴 수 없습니다. 브랜치를 만든 뒤 다시 실행하세요.')
  if ((await git(root, ['status', '--porcelain', '--untracked-files=no'])).trim()) fail('커밋하지 않은 변경이 있습니다. 먼저 커밋하세요.')
  const head = await sha(root, 'HEAD')
  await assertVerified(context, options.verifiedCommit, head)
  await assertSpecClose(root, head)
  await git(root, ['push', '--quiet', remote, `${head}:refs/heads/${branch}`])
  const gh = (args) => execute('gh', args, { cwd: root, encoding: 'utf8', timeout: 60000, env: { ...process.env, GH_PROMPT_DISABLED: '1' } }).then((result) => result.stdout.trim())
  let pr = null, prError = null
  try { pr = (await gh(['pr', 'create', '--base', land, '--head', branch, '--fill'])).split('\n').pop() } catch (error) {
    pr = await gh(['pr', 'view', branch, '--json', 'url', '--jq', '.url']).catch(() => null)
    if (!pr) prError = (error.stderr || error.message || '').trim().slice(-500)
  }
  const result = { schemaVersion: 1, ok: true, pushed: head, target: branch, mode: 'pr', base: land, pr, prError, version: { skipped: bumpGate(context.settings.values, context.branches, 'push') } }
  // The PR has not merged: only what land already holds (as last fetched) has landed.
  const tracking = `refs/remotes/${remote}/${land}`
  return await exists(root, tracking) ? settleLanded(context, result, tracking) : result
}

// vibe deploy: fast-forward the deploy branch to land — the commit the final gate verified when
// it landed. A deploy branch with commits land lacks is refused: merge it into land and verify first.
// version auto puts the bump on land first (pushed before deploy moves): a deploy branch holding a
// commit land lacks would be refused by every other clone.
export async function vibeDeploy(options = {}) {
  const context = await vibeSession(options)
  const { root, remote, branches } = context
  if (!branches.deploy) fail('deploy 브랜치가 정해지지 않았습니다. /gusta-preference deploy <branch>로 정하세요.')
  const source = branches.land ?? context.branch
  if (!source) fail('배포할 land 브랜치가 정해지지 않았습니다. /gusta-init으로 정하세요.')
  if (source === branches.deploy) return { schemaVersion: 1, ok: true, deployed: null, reason: 'land-is-deploy', to: branches.deploy }
  if (await designOf(context.workspace)) fail('이 checkout은 디자인 중입니다(vibe design). 디자인 마감 뒤 배포하세요.')
  const onRemote = branches.push
  if (onRemote && !remote) fail('배포할 원격이 없습니다.')
  const ref = (branch) => onRemote ? `refs/remotes/${remote}/${branch}` : `refs/heads/${branch}`
  for (let attempt = 1; ; attempt += 1) {
    if (onRemote && !(await fetchBranch(root, remote, `refs/heads/${source}`, ref(source)))) fail(`원격에 land 브랜치 ${source}가 없습니다. 먼저 vibe push로 반영하세요.`)
    if (!onRemote && !(await exists(root, ref(source)))) fail(`land 브랜치 ${source}가 없습니다.`)
    const from = await sha(root, ref(source))
    const present = onRemote ? await fetchBranch(root, remote, `refs/heads/${branches.deploy}`, ref(branches.deploy)) : await exists(root, ref(branches.deploy))
    const previous = present ? await sha(root, ref(branches.deploy)) : null
    if (previous === from) return { schemaVersion: 1, ok: true, deployed: null, reason: 'up-to-date', from: source, to: branches.deploy, commit: from }
    if (previous && !(await ancestor(root, previous, from))) {
      const extra = (await git(root, ['log', '--format=%h %s', `${from}..${previous}`])).trim().split('\n').slice(0, 10)
      fail(`${branches.deploy}에 ${source}에 없는 커밋이 있습니다. ${source}에 ${branches.deploy}를 먼저 합치고 검증한 뒤 다시 배포하세요.`, extra)
    }
    const bump = await bumpFor(context, 'deploy', previous, from)
    const commit = bump.commit ?? from
    if (bump.commit) {
      if (onRemote) {
        try { await git(root, ['push', '--quiet', remote, `${commit}:refs/heads/${source}`]) } catch (error) {
          // Someone pushed land first: decide again from the new tip. The deploy branch has not moved.
          if (attempt < 3 && /rejected|non-fast-forward|fetch first|stale info/i.test(error.stderr ?? '')) continue
          fail(`${source}에 버전 커밋을 올리지 못해 ${branches.deploy}에 배포하지 않았습니다.`, [(error.stderr || error.message).trim()])
        }
        await git(root, ['update-ref', ref(source), commit])
      }
      const landed = await forwardBranch(context, source, commit)
      if (!onRemote && landed !== 'ff') fail(`${source}에 버전 커밋을 올리지 못해 ${branches.deploy}에 배포하지 않았습니다(${landed}). ${source} checkout의 변경을 커밋한 뒤 다시 배포하세요.`, [commit])
    }
    if (onRemote) {
      await git(root, ['push', '--quiet', remote, `${commit}:refs/heads/${branches.deploy}`])
      await git(root, ['update-ref', ref(branches.deploy), commit])
    } else if (!previous) await git(root, ['branch', branches.deploy, commit])
    const local = previous || onRemote ? await advanceBranch(context, branches.deploy, commit) : 'created'
    if (!onRemote && ['dirty', 'diverged', 'moved', 'self'].includes(local)) fail(`${branches.deploy}에 반영하지 못했습니다(${local}).`, [commit])
    const result = await settleLanded(context, { schemaVersion: 1, ok: true, deployed: commit, previous, from: source, to: branches.deploy, remote: onRemote ? remote : null, local, version: bump.version }, commit)
    if (onRemote && options.waitCi) {
      try { result.ci = await vibeCIWait({ ...options, diffBase: previous ?? undefined, commit, branch: branches.deploy }); result.ok = result.ci.ok }
      catch (error) { result.ok = false; result.ci = { ok: false, outcome: 'error', error: error.message } }
    }
    return result
  }
}

// The land (or current) branch on the remote as last fetched: { branch, ref, head }; head is null
// when this clone has never seen it there.
async function upstreamOf(context) {
  const branch = context.target ?? context.branch
  const ref = context.remote && branch ? `refs/remotes/${context.remote}/${branch}` : null
  return { branch, ref, head: ref && await exists(context.root, ref) ? await sha(context.root, ref) : null }
}

// Take a task for this session on the coordination branch (src/vibe-coord.mjs claimSession): no
// push target, clean tree or commit is needed, and nothing in the working tree changes. Without
// --task it registers the session. Refused — a ClaimError — while another live session holds the
// task, another session's finished copy waits to land, or the remote had it first (lost).
export async function vibeClaim(options = {}, injected = {}) {
  if (!SESSION_TAG.test(options.tag ?? '') || (options.task && !TASK_ID.test(options.task))) fail('claim에는 --tag와 선택적 --task T###가 필요합니다.')
  assertSessionTag(options.tag)
  if (options.repairTask !== undefined && (typeof options.repairTask !== 'boolean' || options.repairTask && !options.task)) fail('repairTask에는 task와 boolean 값이 필요합니다.')
  if (options.mode !== undefined && !['pair', 'autopilot'].includes(options.mode)) fail('--mode는 pair 또는 autopilot입니다.')
  const context = await vibeSession(options, { unborn: true })
  await assertCoordinator(context, 'claim')
  const { head } = await upstreamOf(context)
  const landState = head ? await git(context.root, ['show', `${head}:spec/STATE.md`], [128]) : null
  return claimSession(context, options, { landState, injected })
}

// This session's presence row. In a Git repository — one without a commit yet included, the
// coordination branch being an orphan — it lives on the coordination branch (written and published
// there, nothing for the caller to commit); only a target without Git keeps it in STATE.
export async function vibeBeat(options = {}, injected = {}) {
  if (!SESSION_TAG.test(options.tag ?? '')) fail('--tag에는 영숫자 2-8자의 세션 tag가 필요합니다.')
  assertSessionTag(options.tag)
  if (options.mode !== undefined && !['pair', 'autopilot'].includes(options.mode)) fail('--mode는 pair 또는 autopilot입니다.')
  if (options.doing !== undefined && options.doing !== '-' && !TASK_ID.test(options.doing)) fail('--doing은 T### 또는 -입니다.')
  const workspace = await inspectWorkspace(options)
  if (workspace.git) {
    const context = await vibeSession({ ...options, inspection: workspace }, { unborn: true })
    await assertCoordinator(context, 'beat')
    return beatSession(context, options, injected)
  }
  const file = path.join(workspace.git?.root ?? workspace.targetRoot, 'spec/STATE.md')
  const text = await readOptional(file)
  if (text === null) fail('spec/STATE.md가 없습니다.')
  const existing = activeRows(text).find((row) => row.tag === options.tag)
  if (options.end) {
    await writeFile(file, upsertActive(text, { tag: options.tag }, { remove: true }))
    return { schemaVersion: 1, tag: options.tag, removed: Boolean(existing) }
  }
  if (!existing && !options.mode) fail('새 세션 행에는 --mode가 필요합니다.')
  const at = minuteNow()
  const row = { tag: options.tag, host: options.host ?? existing?.host ?? hostName(), mode: options.mode ?? existing.mode, since: existing?.since ?? at, at, doing: options.doing ?? existing?.doing ?? '-' }
  await writeFile(file, upsertActive(text, row))
  return { schemaVersion: 1, row }
}

// Snapshot the working tree (tracked, untracked, not ignored) onto wip/<tag> without touching
// HEAD, the index or the current branch. Each snapshot builds on the previous one, so the
// push is always a fast-forward.
export async function vibeCheckpoint(options = {}, injected = {}) {
  if (!SESSION_TAG.test(options.tag ?? '')) fail('--tag에는 세션 tag가 필요합니다.')
  assertSessionTag(options.tag)
  const context = await vibeSession(options)
  const { root, remote } = context
  if (options.handoff && !remote) fail('원격 인계에는 Git remote가 필요합니다. --remote로 지정하세요.')
  const publish = Boolean(remote && (context.target || options.handoff))
  const local = `refs/heads/wip/${options.tag}`
  const tracking = remote ? `refs/remotes/${remote}/wip/${options.tag}` : null
  let fetchError = null
  if (publish) await fetchBranch(root, remote, `refs/heads/wip/${options.tag}`, tracking).catch((error) => { fetchError = [error.message, ...(error.details ?? [])].join('\n') })
  const known = []
  for (const ref of [local, tracking].filter(Boolean)) if (await exists(root, ref)) known.push(await sha(root, ref))
  let previous = known[0] ?? null
  if (known.length === 2 && known[0] !== known[1] && await ancestor(root, known[0], known[1])) previous = known[1]
  const tree = await workingTree(root)
  const head = await sha(root, 'HEAD')
  const changed = !(previous && (await git(root, ['rev-parse', `${previous}^{tree}`])).trim() === tree && await ancestor(root, head, previous))
  const parents = previous ? [previous] : []
  if (!previous || !(await ancestor(root, head, previous))) parents.push(head)
  const message = `checkpoint ${options.tag}: ${options.message ?? 'work in progress'}`
  const commit = changed ? (await git(root, ['commit-tree', tree, ...parents.flatMap((parent) => ['-p', parent]), '-m', message])).trim() : previous
  await git(root, ['update-ref', local, commit])
  let pushed = false, pushError = null
  if (publish) {
    try { await git(root, ['push', '--quiet', remote, `${local}:refs/heads/wip/${options.tag}`]); pushed = true } catch (error) { pushError = error.stderr || error.message }
  }
  const branch = `wip/${options.tag}`
  // A coordination event too: the session's row gets its commit and a fresh `at` and is published,
  // so a long task does not read as a dead session elsewhere. The snapshot stands whatever it says.
  const coordination = await (async () => await isDelegated(context) ? { skipped: 'worker-checkout' } : recordCheckpoint(context, options.tag, injected))()
    .catch((error) => ({ error: error.message }))
  return { schemaVersion: 1, ...(options.handoff ? { ok: pushed, purpose: 'handoff' } : {}), changed, commit, tree, branch, remote,
    remoteBranch: remote ? `${remote}/${branch}` : null, pushed, pushError, ...(fetchError ? { fetchError } : {}), coordination,
    verification: { status: 'unverified', checksRun: false },
    next: options.next ?? `Continue unfinished work from ${pushed ? `${remote}/${branch}` : branch}; inspect remaining tasks and verification failures before final integration.` }
}

const minutesSince = (iso) => iso ? (Date.now() - Date.parse(iso)) / 60000 : Infinity

function summarize(text) {
  const map = sections(text)
  const rows = (name) => tableRows(map.get(name))
  const tasks = rows('tasks').map(([id, title, , dep, st]) => ({ id, title, dep, st }))
  const pending = rows('ssot').filter(([, rev, tasked]) => Number(tasked) < Number(rev)).map(([id, rev, tasked, delta]) => ({ id, rev: Number(rev), tasked: Number(tasked), pending: delta }))
  const reviews = rows('review').filter(([, st]) => st?.startsWith('ready@')).map(([id, st]) => ({ id, st }))
  const ideation = rows('ideation').filter(([, st]) => /^(open|ready)@/.test(st ?? '')).map(([id, st]) => ({ id, st }))
  // The inbox is coordination: the branch's, or this STATE's while it still has the old section.
  const inbox = inboxEntries(map.get('inbox') ?? [])
  return { tasks, pending, reviews, ideation, inbox }
}

// Read active task quote fields once. Archived history stays filename-only; an active file without
// a STATE row remains visible as a repair issue instead of silently becoming settled work.
async function taskFields(root) {
  const names = (await readdir(path.join(root, 'spec/tasks')).catch(() => [])).filter((name) => name.endsWith('.md') && /^T\d+\./.test(name))
  return new Map(await Promise.all(names.map(async (name) => {
    const content = await readOptional(path.join(root, 'spec/tasks', name))
    return [name.split('.')[0], quoteFields(quoteLine(content ?? '') ?? '')]
  })))
}
const timeboxesOf = (tasks, fields) => tasks.flatMap(({ id }) => {
  const timebox = exploreValue(fields.get(id)?.get('explore'))
  return timebox ? [{ id, timebox }] : []
})
// explore timeboxes of the STATE rows, in row order.
export const exploreTimeboxes = async (root, tasks) => timeboxesOf(tasks, await taskFields(root))
const stIssues = (tasks, fields) => {
  const rows = new Set(tasks.map(({ id }) => id))
  const issues = tasks.flatMap((task) => {
    const file = fields.get(task.id)?.get('st')
    return [...(TASK_ST.test(task.st ?? '') ? (/^done@/.test(task.st) ? [{ id: task.id, where: 'STATE', st: task.st, reason: 'stale-done-row' }] : []) : [{ id: task.id, where: 'STATE', st: task.st ?? null }]),
      ...(!fields.has(task.id) ? [] : !TASK_ST.test(file ?? '') ? [{ id: task.id, where: 'file', st: file ?? null }] : /^done@/.test(file) ? [{ id: task.id, where: 'file', st: file, reason: 'unarchived-done' }] : [])]
  })
  for (const [id, values] of fields) if (TASK_ID.test(id) && !rows.has(id)) issues.push({ id, where: 'file', st: values.get('st') ?? null, reason: 'missing-state-row' })
  return issues
}

// Shared final-close status check, without remote ownership/report scans or archived history reads.
export async function specCloseIssues(root) {
  const state = (await readOptional(path.join(root, 'spec/STATE.md'))) ?? ''
  return stIssues(summarize(state).tasks, await taskFields(root))
}

// The task checks this clone ran lately (each command's last runs in timings.json) and the ones that
// average over a minute: candidates for the final gate, decided by a person (gusta-update). A command
// ARCH now lists only under batch was moved already: the task tier refuses it, so it is left out.
async function recentTaskChecks(workspace, root) {
  const rows = taskTimingRows(await readTimings(runtimeRoot(workspace)))
  if (!rows.length) return null
  const verify = await readVerification(root), same = (a) => (b) => a === b.trim().replace(/\s+/g, ' ')
  const summary = taskCheckSummary(rows.filter(({ command }) => !verify.batch.some(same(command)) || verify.task.some(same(command))))
  return summary.runs ? summary : null
}

// What a session needs before its first question: who else is working and where (the coordination
// branch, synced with the remote unless fetch is off, plus STATE's old sections while a project
// still has them), what is left, and which way to go.
export async function vibeStatus(options = {}, injected = {}) {
  const workspace = await inspectWorkspace(options)
  const root = workspace.git?.root ?? workspace.targetRoot
  const text = await readOptional(path.join(root, 'spec/STATE.md'))
  if (text === null) return { schemaVersion: 1, route: 'architecture', reason: 'spec/STATE.md가 없습니다.', git: Boolean(workspace.git) }
  const cfg = cfgOf(text)
  // Without Git there is no coordination branch: STATE's own sections are the whole picture.
  // A repository without a commit yet has one (an orphan needs no HEAD).
  const context = workspace.git ? await vibeSession({ ...options, inspection: workspace }, { unborn: true }) : null
  const settings = context?.settings ?? await readSettings({ root })
  const result = { schemaVersion: 1, tag: options.tag ?? null, cfg: { level: cfg.get('level') ?? null, lang: cfg.get('lang') ?? null },
    settings: { land: settings.values.land, landVia: settings.values['land-via'], push: settings.values.push, deploy: settings.values.deploy, plan: settings.values.plan, version: settings.values.version, unset: settings.unset, ...(settings.legacy.length ? { legacy: settings.legacy } : {}) } }
  if (options.section) {
    if (options.section !== 'inbox') fail('status --section은 inbox를 지원합니다.')
    const lines = context ? (await coordView(context, { fetch: options.fetch !== false, tag: options.tag, injected })).doc.inbox : null
    return { ...result, inbox: lines ? inboxEntries(lines) : summarize(text).inbox }
  }
  let view = null
  const landed = new Set()
  if (context) {
    const fetching = Boolean(context.remote) && options.fetch !== false
    let fetchError = null
    if (fetching) {
      try { await git(root, ['fetch', '--quiet', context.remote]) } catch (error) { fetchError = (error.stderr || error.message).trim() }
    }
    const { branch, head: remoteHead } = await upstreamOf(context)
    let ahead = 0, behind = 0
    if (remoteHead && workspace.git.head) [ahead, behind] = (await git(root, ['rev-list', '--left-right', '--count', `HEAD...${remoteHead}`])).trim().split(/\s+/).map(Number)
    const remoteText = remoteHead ? await git(root, ['show', `${remoteHead}:spec/STATE.md`], [128]) : null
    const dirty = (await git(root, ['status', '--porcelain'])).split('\n').filter(Boolean).length
    result.git = { branch: context.branch, head: workspace.git.head, remote: context.remote, target: branch, remoteHead, ahead, behind, dirty, fetchError }
    view = await coordView(context, { fetch: options.fetch !== false, tag: options.tag, activeFrom: [remoteText], injected })
    // Others: where each works (branch, commit, and whether that commit is on the remote yet), and
    // whether it still shows life — its row's `at`, or a newer wip/<tag> snapshot.
    const sessions = []
    for (const row of view.doc.active.filter((entry) => entry.tag !== options.tag)) {
      const wipAt = await wipTime(context, row.tag)
      const lastSeen = [row.at, wipAt].filter(Boolean).map((value) => new Date(Date.parse(value)).toISOString()).sort().at(-1) ?? null
      const minutes = minutesSince(lastSeen)
      sessions.push({ ...row, pushed: await commitOnRemote(context, row.commit, fetching && !fetchError), wipAt, lastSeen, minutesAgo: Number.isFinite(minutes) ? Math.round(minutes) : null, stale: minutes > STALE_MINUTES })
    }
    const live = new Set(sessions.filter((row) => !row.stale).map((row) => row.tag))
    if (options.tag) live.add(options.tag)
    const doing = summarize(remoteText ?? text).tasks.filter((task) => task.st?.startsWith('doing@')).map((task) => ({ ...task, tag: task.st.split('.')[1] ?? null }))
    result.others = sessions
    result.orphanDoing = doing.filter((task) => task.tag !== options.tag && !live.has(task.tag))
    result.self = view.doc.active.find((entry) => entry.tag === options.tag) ?? null
    result.unlanded = await Promise.all(view.doc.unlanded.map(async (row) => ({ ...row, pushed: await commitOnRemote(context, row.commit, fetching && !fetchError) })))
    // Tasks the land branch already archived (its remote copy as last fetched, and its local one):
    // a checkout that has not taken land in yet still shows them todo.
    const land = context.branches.land && await exists(root, `refs/heads/${context.branches.land}`) ? `refs/heads/${context.branches.land}` : null
    for (const ref of [remoteHead, land].filter(Boolean)) {
      const names = (await git(root, ['ls-tree', '--name-only', '-z', `${ref}:spec/tasks/done`], [128]))?.split('\0') ?? []
      for (const name of names) if (/^T\d{3,}\./.test(name)) landed.add(name.split('.')[0])
    }
  }
  const local = summarize(text)
  const design = await designOf(workspace)
  const fields = await taskFields(root)
  const explore = timeboxesOf(local.tasks, fields), issues = stIssues(local.tasks, fields)
  const reports = (await readdir(path.join(root, 'spec/reports')).catch(() => [])).filter((name) => name.endsWith('.md'))
  const reportTo = await Promise.all(reports.map(async (file) => quoteFields(quoteLine((await readOptional(path.join(root, 'spec/reports', file))) ?? '') ?? '').get('to')))
  const openReports = reports.filter((file, index) => reportTo[index] === '-').map((file) => `spec/reports/${file}`)
  const ownTag = (task) => task.st?.startsWith('doing@') && task.st.split('.')[1] === options.tag
  // What execution (gusta-start, vibe loop) acts on: todo rows, this session's doing rows, and
  // blocked rows (a recovery unit).
  const implementation = { todo: local.tasks.filter((task) => task.st === 'todo').map((task) => task.id),
    resume: local.tasks.filter(ownTag).map((task) => task.id),
    blocked: local.tasks.filter((task) => task.st?.startsWith('blocked@')).map((task) => task.id), explore }
  // Untasked planning input: SSOT deltas (rev > tasked), adopted reviews and legacy open/ready
  // ideation. Only the user-invoked gusta-sketch turns it into tasks; execution never plans it, so it
  // makes no route or unit and only ends a loop as needs-sketch. (Formerly implementation.pending,
  // implementation.reviews and planning.ideation, with the same entries.)
  const sketch = { pending: local.pending, reviews: local.reviews, ideation: local.ideation }
  const executable = implementation.todo.length + implementation.resume.length + implementation.blocked.length > 0
  const untasked = sketch.pending.length + sketch.reviews.length + sketch.ideation.length > 0
  const inbox = view ? inboxEntries(view.doc.inbox) : local.inbox
  const parked = new Set(inbox.filter((entry) => entry.kind === 'parked').flatMap((entry) => entry.refs))
  const doneFiles = await readdir(path.join(root, 'spec/tasks/done')).catch(() => [])
  const done = new Set(doneFiles.map((file) => file.split('.')[0]))
  // held: remaining tasks this session must not start — another live session is doing them
  // (claimed), another session finished them and they have not landed (unlanded), or the land
  // branch has them archived and this checkout has not taken land in yet (landed: sync first).
  const remaining = new Set(local.tasks.map((task) => task.id))
  const held = view ? [...result.others.filter((row) => !row.stale).map((row) => ({ id: row.doing, tag: row.tag, reason: 'claimed' })),
    ...view.doc.unlanded.filter((row) => row.tag !== options.tag).map((row) => ({ id: row.id, tag: row.tag, reason: 'unlanded' })),
    ...[...landed].map((id) => ({ id, tag: null, reason: 'landed' }))]
    .filter((entry, index, all) => remaining.has(entry.id) && entry.id !== result.self?.doing && all.findIndex((other) => other.id === entry.id) === index) : []
  const taken = new Set(held.map((entry) => entry.id))
  const runnable = local.tasks.filter((task) => !parked.has(task.id) && !taken.has(task.id) && (task.st === 'todo' || ownTag(task)) &&
    (task.dep === '-' || !task.dep || task.dep.split(/[\s,]+/).filter(Boolean).every((id) => done.has(id))))
  // lost: tasks this checkout says are ours that someone else holds (the remote had them first).
  // contested: tasks we finished that another session is doing anyway — the coordination branch
  // settles two claims, not a claim against a finished task.
  const coordination = view && { branch: view.branch, ...(view.error ? { error: view.error } : {}), legacy: view.legacy,
    lost: [...view.lost, ...held.filter((entry) => implementation.resume.includes(entry.id) && !view.lost.some((lost) => lost.task === entry.id)).map((entry) => ({ task: entry.id, owner: entry.tag, reason: entry.reason }))],
    contested: view.doc.unlanded.filter((row) => options.tag && row.tag === options.tag).flatMap((row) => result.others.filter((other) => !other.stale && other.doing === row.id).map((other) => ({ task: row.id, owner: other.tag }))),
    push: view.push, sync: view.sync }
  // Advisory: an unreadable timings file or ARCH never fails status.
  const taskChecks = workspace.git ? await recentTaskChecks(workspace, root).catch(() => null) : null
  return { ...result, ...(coordination ? { coordination, held } : {}), ...(taskChecks ? { taskChecks } : {}),
    concurrency: (result.others ?? []).some((row) => !row.stale) || (result.orphanDoing ?? []).length > 0 ? 'strict' : 'solo',
    next: (sections(text).get('next') ?? []).filter((line) => line.startsWith('- ')).slice(0, 3),
    counts: { inbox: inbox.length, parked: inbox.filter((entry) => entry.kind === 'parked').length, remaining: local.tasks.length },
    // run: the planned tool/model@effort, only where the task file names one (format checked by lint).
    remaining: local.tasks.map((task) => { const run = runValue(fields.get(task.id)?.get('run')); return { ...task, title: task.title.slice(0, 120), ...(run ? { run } : {}) } }), runnable: runnable.map((task) => task.id),
    // settled: nothing to execute and nothing to repair (untasked sketch input may remain).
    // parkedOnly: nothing runnable, nothing to sketch, only parked or blocked work left.
    issues, settled: !executable && !issues.length, parkedOnly: !runnable.length && !untasked && (parked.size > 0 || implementation.blocked.length > 0),
    implementation, sketch, inbox: inbox.slice(0, 3).map(({ id, date, kind, refs, text }) => ({ id, date, kind, refs, text: text.slice(0, 220) })), inboxMore: inbox.length > 3, openReports,
    design,
    // An open design comes first: its edits are uncommitted until the user ends it. A broken st
    // (a hand close) is fixed before anything else is chosen: gusta-implement-task's close, then lint.
    // Execution only runs existing tasks: with none, planning is the user's /gusta-sketch.
    route: design ? 'design' : issues.length ? 'repair' : executable ? 'implementation' : 'sketch-first' }
}

const which = (command) => execute('sh', ['-c', `command -v ${command}`], { timeout: 5000 }).then(() => true, () => false)

// Everything autopilot needs before the user leaves. needsUser lists what only a person can fix.
// deps.catalog: the caller's agentCatalog read (vibe loop shares its own), else read here for the probe.
export async function vibePreflight(options = {}, deps = {}) {
  if (options.probeWorkspace !== undefined && !['current', 'new'].includes(options.probeWorkspace)) fail('--probe-workspace는 current 또는 new입니다.')
  const context = await vibeSession(options)
  const checks = []
  const add = (name, ok, detail, needsUser = false) => checks.push({ name, ok, detail, needsUser: !ok && needsUser })
  add('push-target', true, context.target ?? 'commit only (SETTINGS push false)')
  // Informational: an undecided land is settled by gusta-init before autopilot starts (common rule 1);
  // autopilot itself commits on the current branch, so it never blocks here.
  // version auto: which command raises the version, or why none does.
  const bumpOn = context.branches.deploy && context.branches.deploy !== context.branches.land ? 'deploy' : 'push'
  const version = context.settings.values.version !== 'auto' ? '' : ` · version auto (${bumpGate(context.settings.values, context.branches, bumpOn) ?? `vibe ${bumpOn}`})`
  add('branch-settings', true, context.branches.unset ? 'land 미정 — 맡김은 현재 브랜치에 커밋만 합니다(/gusta-init으로 정하면 반영)' : `land ${context.settings.values.land}${context.branches.deploy ? ` → deploy ${context.branches.deploy}` : ''}${version}`)
  // Unlike land, undecided agents stops autopilot: the CLI routes units only within that list.
  const agents = agentList(context.settings.values.agents)
  const needsInit = !agents && !options.provider && !options.adapter
  add('agents', !needsInit, needsInit ? 'agents 미정 — /gusta-init으로 쓸 AI 목록을 정한 뒤 맡기세요' : agents ? `${agents.join(',')} (fallback order)` : `${options.provider ?? 'command adapter'} (explicit)`, true)
  // Where sessions coordinate, whether events reach the remote, and how the last publish went. A
  // coordination branch this checkout cannot write needs a person: SETTINGS coord differs from the
  // clone's or names a code branch, the name collides with another ref, the branch is checked out,
  // or Git has no user to commit as — the loop would die at its first claim. A remote in backoff
  // only delays publishing.
  const coordination = await coordView(context, { fetch: false, writable: true })
  const reach = coordination.push.enabled ? `→ ${coordination.push.remote} at every event` : `(this clone only: ${coordination.push.reason === 'disabled' ? 'coord-push false' : 'no remote'})`
  const { last, backoff } = coordination.push
  const blocked = coordination.error ?? (coordination.writable?.ok === false ? coordination.writable.error : null)
  add('coord-push', !blocked, blocked ?? `${coordination.branch} ${reach}${last ? ` · last publish ${last.at}: ${last.pushed ? 'pushed' : last.reason}` : ''}${backoff ? ` · remote backoff (${backoff.reason}) until ${backoff.until}` : ''}${coordination.push.unpublished ? ' · unpublished events go with the next one' : ''}`, true)
  if (context.target) {
    if (!context.remote) add('remote', false, 'no git remote for SETTINGS push', true)
    else {
      try {
        await git(context.root, ['push', '--dry-run', '--quiet', context.remote, `HEAD:refs/heads/${context.target}`])
        add('push-permission', true, `${context.remote}/${context.target}`)
      } catch (error) {
        const detail = (error.stderr || error.message).trim()
        // Being behind is fine (vibe push syncs first); auth or network failures are not.
        const behind = /rejected|non-fast-forward|fetch first/i.test(detail)
        add('push-permission', behind, behind ? `${context.remote}/${context.target} (behind; vibe push syncs)` : detail, !behind)
      }
    }
  }
  // Design edits wait for the user watching them; nobody is there to end the design.
  const design = await designOf(context.workspace)
  add('design', !design, design ? `design in progress since ${design.since} (${design.tag}) — end it with gusta-design-mode first` : 'none', true)
  const dirty = (await git(context.root, ['status', '--porcelain'])).split('\n').filter(Boolean)
  add('clean', dirty.length === 0, dirty.length ? `${dirty.length} uncommitted paths — commit or leave them out of unit commits` : 'clean')
  const lint = await lintSpec({ targetRoot: context.root })
  add('spec-lint', lint.ok, lint.ok ? `${lint.warnings.length} warnings` : lint.errors.slice(0, 5).join(' / '))
  add('keep-awake', process.platform !== 'darwin' || await which('caffeinate'), process.platform === 'darwin' ? 'caffeinate' : `${process.platform}: keep the machine awake yourself`)
  let workflows = false
  try { await access(path.join(context.root, '.github/workflows')); workflows = true } catch {}
  if (workflows && context.target) {
    const gh = await execute('gh', ['auth', 'status'], { timeout: 10000 }).then(() => true, () => false)
    const repo = context.remote ? githubRepository(await git(context.root, ['remote', 'get-url', context.remote])) : null
    const token = (options.env ?? process.env).GITHUB_TOKEN ?? (options.env ?? process.env).GH_TOKEN
    // Informational: CI nobody can read is skipped and reported as unchecked, never a reason to stop.
    add('ci-access', true, gh ? 'gh' : token ? 'token API' : repo ? 'public HTML (no gh/token: a private repo\'s CI is reported unchecked for later)' : 'no GitHub repository: CI is reported unchecked for later')
  }
  const verify = await readVerification(context.root)
  const commands = [...verify.task, ...(options.verify ?? verify.batch)]
  const executables = [...new Set(commands.map((command) => command.match(/^(?:\w+=\S+\s+)*([\w./-]+)/)?.[1]).filter(Boolean))]
  const missing = []
  for (const command of executables) {
    const available = await execute('sh', ['-c', 'command -v "$1"', 'gusta-verify', command], { cwd: context.root, env: options.env ?? process.env, timeout: 5000 }).then(() => true, () => false)
    if (!available) missing.push(command)
  }
  const verificationDetail = missing.length ? `missing commands: ${missing.join(', ')}`
    : verify.plan ? `plan: ${verify.plan.source}; task: ${verify.task.length}, batch: ${verify.batch.length}, CI: ${verify.ci.length}; successful checks reuse only matching declared inputs and execution scope`
    : verify.declared ? `task: ${verify.task.length}, batch: ${verify.batch.length}; conditional checks remain in ARCH guidance`
    : `declared:false, partial:${verify.partial}; legacy ARCH: changed tests + fast checks at task tier; reconcile project rules and select batch commands before code push`
  add('verification', missing.length === 0, verificationDetail, true)
  if (options.probe && !needsInit) checks.push(await probeWorker(context, { ...options, permissionMode: await permissionMode(options, context.root), headlessMcp: await readSetting({ root: context.root }, 'headless-mcp') }, { agents, catalog: deps.catalog, blocked: deps.blocked }))
  return { schemaVersion: 1, ok: checks.every((check) => check.ok), checks, needsUser: checks.filter((check) => check.needsUser), ...(needsInit ? { reason: 'needs-init', hint: loopHint('needs-init') } : {}) }
}

const PROBE_SCHEMA = { type: 'object', additionalProperties: false, required: ['ran', 'exitCode', 'denied', 'note'],
  properties: { ran: { type: 'boolean' }, exitCode: { type: 'integer' }, denied: { type: 'boolean' }, note: { type: 'string' } } }

export function probeFailureKind({ denied = false, note = '', code } = {}) {
  if (denied || /EACCES|EPERM|permission denied|operation not permitted|sandbox.*(?:denied|blocked)|approval.*(?:denied|required)/i.test(note)) return 'permission'
  if (/ENOTFOUND|EAI_AGAIN|ECONN(?:REFUSED|RESET)|ETIMEDOUT|network (?:is )?(?:unreachable|access|error|restricted)|could not resolve|unable to resolve|fetch failed/i.test(note)) return 'network'
  if (code === 'ENOENT' || /MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND|cannot find (?:module|package)|command not found|missing (?:dependencies|dependency)|node_modules.*(?:missing|not found|ENOENT)/i.test(note)) return 'dependency'
  return 'command'
}

// The probe's tool·model·effort: an explicit --provider as given, else the first tool of SETTINGS
// agents (not at a usage limit) at its cheapest combination (routeAgent probe). null: no usable tool, with the reasons.
async function probeRoute(context, options, { agents, catalog, blocked }) {
  if (options.provider) return { route: { tool: options.provider, model: options.model ?? null, effort: options.effort ?? null } }
  if (!agents) return { route: null }
  const read = catalog ?? (() => agentCatalog({ targetRoot: context.root, env: options.env ?? process.env }, { agents: context.settings.values.agents }))
  // A loop hands in the tools at a usage limit now: the probe runs on one that can answer.
  const routed = routeAgent({ role: 'probe', agents, catalog: await read(), blocked: blocked ? await blocked() : [] })
  return routed.chosen ? { route: routed.chosen } : { route: null, unusable: routed.skipped.map(({ option, reason }) => `${runLabel(option)}: ${reason}`) }
}

// Runs the command once through a real headless worker in a fresh, never-trusted worktree —
// the same place work-group workers run — so a permission gap shows before the user leaves.
async function probeWorker(context, options, routing = {}) {
  const { route, unusable } = await probeRoute(context, options, routing)
  if (unusable) return { name: 'worker-probe', ok: false, needsUser: true, failureKind: 'agents', permissionMode: options.permissionMode, detail: `SETTINGS agents의 도구를 쓸 수 없습니다 (gusta agents로 확인): ${unusable.join(', ')}` }
  // Without agents (an explicit command adapter run) the probe takes whichever CLI is installed.
  const provider = route?.tool ?? (await which('claude') ? 'claude' : 'codex')
  const model = route?.model ?? null, effort = route?.effort ?? null
  const allow = options.allowTool ?? []
  const place = options.probeWorkspace === 'current' ? null : await workInternals.destination({ workspace: context.workspace, cwd: context.root }, `probe-${randomUUID().slice(0, 8)}`)
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'gusta-probe-'))
  const bypass = options.permissionMode === 'bypass'
  const probeRoot = place ?? context.root
  if (place) await git(context.root, ['worktree', 'add', '--detach', '--quiet', place, 'HEAD'])
  try {
    const prompt = `Run exactly this shell command once with your shell tool from the current directory, and nothing else:\n${options.probe}\nThen report JSON {"ran":bool,"exitCode":int,"denied":bool,"note":string}; denied=true when the tool call was refused for permission. In note, include the exact failure code and a short diagnostic distinguishing missing dependencies, network failure, permission denial, or command failure. Do not install dependencies, retry, or change permissions.`
    const schemaFile = path.join(temporary, 'schema.json')
    const resultFile = path.join(temporary, 'result.json')
    await writeFile(schemaFile, JSON.stringify(PROBE_SCHEMA))
    const args = provider === 'claude'
      ? ['--print', '--output-format', 'json', '--json-schema', JSON.stringify(PROBE_SCHEMA), '--permission-mode', bypass ? 'bypassPermissions' : 'acceptEdits', '--permission-prompts', 'none',
          '--tools', 'Bash,Read', '--allowedTools', ['Read', ...allow].join(',')]
      : [...(bypass ? ['exec', '--dangerously-bypass-approvals-and-sandbox'] : ['-a', 'never', 'exec', '--sandbox', 'workspace-write']), '--output-schema', schemaFile, '--output-last-message', resultFile,
          ...(model ? ['--model', model] : []), ...(effort ? ['-c', `model_reasoning_effort=${effort}`] : []), '-']
    if (provider === 'claude') args.push(...(model ? ['--model', model] : []), ...(effort ? ['--effort', claudeEffort(effort)] : []))
    const env = providerEnvironment(provider, options.env ?? process.env, effort)
    // Same optional flags (MCP isolation included) as the workers it stands in for.
    if (provider === 'claude') args.push(...claudeOptionalFlags(await providerFlags(provider, { env }), { headlessMcp: options.headlessMcp }))
    const output = await new Promise((resolve, reject) => {
      const child = spawn(provider, args, { cwd: probeRoot, env, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] })
      let stdout = '', stderr = '', timedOut = false, forced
      const kill = (signal) => { try { process.platform === 'win32' ? child.kill(signal) : process.kill(-child.pid, signal) } catch {} }
      const stop = () => { kill('SIGTERM'); forced ??= setTimeout(() => kill('SIGKILL'), 2000) }
      const timer = setTimeout(() => { timedOut = true; stop() }, Number(options.probeTimeoutMs ?? 15 * 60 * 1000))
      const abort = () => { timedOut = true; stop() }
      options.signal?.addEventListener('abort', abort, { once: true })
      if (options.signal?.aborted) abort()
      child.stdout.on('data', (chunk) => { stdout += chunk; if (stdout.length > 1024 * 1024) { timedOut = true; stop(); stdout = stdout.slice(0, 1024 * 1024) } })
      child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000) })
      child.on('error', (error) => { clearTimeout(timer); reject(error) })
      child.on('close', (code) => { if (timedOut) kill('SIGKILL'); clearTimeout(timer); clearTimeout(forced); options.signal?.removeEventListener('abort', abort); code === 0 && !timedOut ? resolve(stdout) : reject(new Error(`${provider} ${timedOut ? 'probe timeout/output limit/stopped' : `exited ${code}`}: ${stderr.trim()}`)) })
      child.stdin.on('error', () => {})
      child.stdin.end(prompt)
    })
    const result = provider === 'claude' ? JSON.parse(output).structured_output : JSON.parse(await readFile(resultFile, 'utf8'))
    const ok = Boolean(result?.ran) && !result.denied && result.exitCode === 0
    return { name: 'worker-probe', ok, needsUser: !ok, failureKind: ok ? null : probeFailureKind(result), ran: Boolean(result?.ran), exitCode: result?.exitCode ?? null, permissionMode: options.permissionMode, route: runLabel({ tool: provider, model, effort }),
      detail: `${provider} ${options.permissionMode}: ${result?.denied ? 'denied' : `exit ${result?.exitCode}`} — ${result?.note ?? ''}`.trim(), allowTool: allow, workspace: probeRoot, workspaceMode: place ? 'new' : 'current',
      projectSettings: probeRoot === context.root ? 'current checkout: project settings available; effective permissions checked by this probe' : 'new worktree: project allowlist and installed dependencies may differ' }
  } catch (error) {
    return { name: 'worker-probe', ok: false, needsUser: true, failureKind: probeFailureKind({ note: error.message, code: error.code }), permissionMode: options.permissionMode,
      workspace: probeRoot, workspaceMode: place ? 'new' : 'current', detail: error.message }
  } finally {
    if (place) await git(context.root, ['worktree', 'remove', '--force', place], [128]).catch(() => {})
    await rm(temporary, { recursive: true, force: true })
  }
}

// Keep the machine awake while unattended work runs (macOS caffeinate, bounded by hours).
export async function vibeAwake(options = {}) {
  const context = await vibeSession(options)
  const file = path.join(context.runtime, 'awake.json')
  const previous = JSON.parse((await readOptional(file)) ?? 'null')
  const running = previous?.host === os.hostname() && (() => { try { process.kill(previous.pid, 0); return true } catch { return false } })()
  if (options.stop) {
    if (running) process.kill(previous.pid, 'SIGTERM')
    await rm(file, { force: true })
    return { schemaVersion: 1, stopped: Boolean(running) }
  }
  if (process.platform !== 'darwin') return { schemaVersion: 1, ok: false, reason: `${process.platform}: keep the machine awake yourself` }
  if (running) return { schemaVersion: 1, ok: true, pid: previous.pid, until: previous.until, reused: true }
  const hours = Number(options.hours ?? 12)
  if (!Number.isFinite(hours) || hours <= 0 || hours > 72) fail('--hours는 0보다 크고 72 이하입니다.')
  const child = spawn('caffeinate', ['-i', '-m', '-s', '-t', String(Math.round(hours * 3600))], { detached: true, stdio: 'ignore' })
  child.unref()
  const until = new Date(Date.now() + hours * 3600000).toISOString()
  await mkdir(context.runtime, { recursive: true })
  await writeFile(file, JSON.stringify({ pid: child.pid, host: os.hostname(), until }))
  return { schemaVersion: 1, ok: true, pid: child.pid, until }
}

// Compatibility API: callers still receive an exit code; CLI prints one bounded summary.
export async function vibeCheck(options = {}, command) {
  const result = options.resetGate ? await resetVibeGate(options, command) : await runVibeCheck(options, command)
  process.stdout.write(`${JSON.stringify(result)}\n`)
  return result.exitCode
}
