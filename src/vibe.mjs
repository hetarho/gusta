import { readFile, writeFile, readdir, mkdir, mkdtemp, rm, access, realpath } from 'node:fs/promises'
import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { inspectWorkspace, git } from './workspace.mjs'
import { runtimeRoot } from './work-runtime.mjs'
import { sections, tableRows, quoteLine, quoteFields, exploreValue, INBOX_LINE, SESSION_TAG, TASK_ID } from './spec-format.mjs'
import { activeRows, upsertActive, mergeState, parseState, renderState } from './state-doc.mjs'
import { designOf } from './interactive-state.mjs'
import { workingTree, checkKey, cachedPass, recordPass, withHeavyLock } from './check-cache.mjs'
import { lintSpec } from './spec-lint.mjs'
import { workInternals } from './work-groups.mjs'
import { stateMergeArgs } from './git-merge.mjs'
import { SkillPackageError } from './errors.mjs'
import { readSettings, branchPlan, defaultBranch, permissionMode } from './settings.mjs'
import { runVibeCheck } from './vibe-check.mjs'
import { readVerification } from './vibe-brief.mjs'
import { vibeCIWait, githubRepository } from './vibe-ci.mjs'
import { providerFlags } from './work-providers.mjs'

const execute = promisify(execFile)
const fail = (message, details = []) => { throw new SkillPackageError(message, details) }
const STALE_MINUTES = 90
export const minuteNow = () => `${new Date().toISOString().slice(0, 16)}Z`
const hostName = () => os.hostname().replace(/\.local$/, '').replace(/[|\s]/g, '-') || 'host'

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

// Code that changed after the final gate is not what was verified (spec bookkeeping aside).
async function assertVerified(root, verifiedCommit, commit) {
  if (!verifiedCommit) return
  const verified = await sha(root, verifiedCommit)
  const changed = (await git(root, ['diff', '--name-only', verified, commit])).trim().split('\n').filter((file) => file && !/^spec\/(?:STATE\.md$|reports\/|tasks\/|work\/)/.test(file))
  if (changed.length) fail('최종 검증 이후 코드가 변경됐습니다. 합친 현재 결과를 다시 검증한 뒤 반영하세요.', changed)
}

// Where finished work goes, from spec/SETTINGS.md (legacy STATE cfg push/plan as fallback):
// target is the branch `vibe push` publishes (push: true), land the branch work lands on.
// Unset or push: false commits only.
export async function vibeSession(options = {}) {
  const workspace = await inspectWorkspace(options)
  if (!workspace.git?.head) fail('커밋이 있는 Git checkout이 필요합니다.')
  const root = workspace.git.root
  const state = await readOptional(path.join(root, 'spec/STATE.md'))
  const settings = await readSettings({ root })
  const remotes = (await git(root, ['remote'])).split('\n').map((line) => line.trim()).filter(Boolean)
  const remote = options.remote ?? (remotes.includes('origin') ? 'origin' : remotes[0] ?? null)
  if (options.remote && !remotes.includes(options.remote)) fail(`원격이 없습니다: ${options.remote}`)
  const branches = branchPlan(settings.values, { branch: workspace.git.branch, defaultBranch: await defaultBranch(root) })
  const target = branches.pushTarget
  return { workspace, root, state, settings, branches, push: target ?? '-', remote, target, branch: workspace.git.branch, runtime: runtimeRoot(workspace) }
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

// Land HEAD the way SETTINGS says: land-via pr opens a PR into land; push: true publishes to the
// push branch (a rejection means someone pushed first — sync and retry); otherwise a land branch
// other than this one takes the work as a local merge. Nothing to do is not an error.
export async function vibePush(options = {}) {
  const context = await vibeSession(options)
  const { branches } = context
  if (!context.target && !branches.landTarget) return { schemaVersion: 1, ok: true, pushed: null, reason: branches.unset ? 'land-unset' : 'push-disabled' }
  if (await designOf(context.workspace)) fail('이 checkout은 디자인 중입니다(vibe design). 사용자에게 디자인이 끝났는지 확인하고 start-design 마감(vibe design verify → end → 커밋) 뒤 push하세요.')
  if (branches.via === 'pr' && branches.landTarget) return landByPR(context, options)
  if (!context.target) return landLocal(context, options)
  if (!context.remote) fail('push할 원격이 없습니다. spec/SETTINGS.md push를 false로 두거나 원격을 추가하세요.')
  let last
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const synced = await vibeSync(options)
    const pushed = await sha(context.root, 'HEAD')
    await assertVerified(context.root, options.verifiedCommit, pushed)
    try {
      const tracking = `refs/remotes/${context.remote}/${context.target}`
      const diffBase = options.diffBase ?? (await exists(context.root, tracking) ? await sha(context.root, tracking) : undefined)
      await git(context.root, ['push', '--quiet', context.remote, `${pushed}:refs/heads/${context.target}`])
      const result = { schemaVersion: 1, ok: true, pushed, diffBase, target: context.target, remote: context.remote, attempts: attempt, sync: synced.action }
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
  if (!(await exists(root, ref))) fail(`land 브랜치 ${land}가 없습니다. 브랜치를 만들거나 /haeram-setting으로 land를 고치세요.`)
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
  await assertVerified(root, options.verifiedCommit, head)
  const moved = await advanceBranch(context, land, head)
  if (['dirty', 'diverged', 'moved'].includes(moved)) fail(`${land}에 반영하지 못했습니다(${moved === 'dirty' ? '그 브랜치 checkout에 커밋하지 않은 변경' : '그 사이 브랜치가 움직임'}). 다시 실행하세요.`, [head])
  return { schemaVersion: 1, ok: true, pushed: null, landed: head, target: land, mode: 'local', merged, local: moved }
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
  await assertVerified(root, options.verifiedCommit, head)
  await git(root, ['push', '--quiet', remote, `${head}:refs/heads/${branch}`])
  const gh = (args) => execute('gh', args, { cwd: root, encoding: 'utf8', timeout: 60000, env: { ...process.env, GH_PROMPT_DISABLED: '1' } }).then((result) => result.stdout.trim())
  let pr = null, prError = null
  try { pr = (await gh(['pr', 'create', '--base', land, '--head', branch, '--fill'])).split('\n').pop() } catch (error) {
    pr = await gh(['pr', 'view', branch, '--json', 'url', '--jq', '.url']).catch(() => null)
    if (!pr) prError = (error.stderr || error.message || '').trim().slice(-500)
  }
  return { schemaVersion: 1, ok: true, pushed: head, target: branch, mode: 'pr', base: land, pr, prError }
}

// vibe deploy: fast-forward the deploy branch to land — the commit the final gate verified when
// it landed. A deploy branch with commits land lacks is refused: merge it into land and verify first.
export async function vibeDeploy(options = {}) {
  const context = await vibeSession(options)
  const { root, remote, branches } = context
  if (!branches.deploy) fail('deploy 브랜치가 정해지지 않았습니다. /haeram-setting deploy <branch>로 정하세요.')
  const source = branches.land ?? context.branch
  if (!source) fail('배포할 land 브랜치가 정해지지 않았습니다. /haeram-init으로 정하세요.')
  if (source === branches.deploy) return { schemaVersion: 1, ok: true, deployed: null, reason: 'land-is-deploy', to: branches.deploy }
  if (await designOf(context.workspace)) fail('이 checkout은 디자인 중입니다(vibe design). 디자인 마감 뒤 배포하세요.')
  const onRemote = branches.push
  if (onRemote && !remote) fail('배포할 원격이 없습니다.')
  const ref = (branch) => onRemote ? `refs/remotes/${remote}/${branch}` : `refs/heads/${branch}`
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
  if (onRemote) {
    await git(root, ['push', '--quiet', remote, `${from}:refs/heads/${branches.deploy}`])
    await git(root, ['update-ref', ref(branches.deploy), from])
  } else if (!previous) await git(root, ['branch', branches.deploy, from])
  const local = previous || onRemote ? await advanceBranch(context, branches.deploy, from) : 'created'
  if (!onRemote && ['dirty', 'diverged', 'moved', 'self'].includes(local)) fail(`${branches.deploy}에 반영하지 못했습니다(${local}).`, [from])
  const result = { schemaVersion: 1, ok: true, deployed: from, previous, from: source, to: branches.deploy, remote: onRemote ? remote : null, local }
  if (onRemote && options.waitCi) {
    try { result.ci = await vibeCIWait({ ...options, diffBase: previous ?? undefined, commit: from, branch: branches.deploy }); result.ok = result.ci.ok }
    catch (error) { result.ok = false; result.ci = { ok: false, outcome: 'error', error: error.message } }
  }
  return result
}

// Publish only this session's claim on the remote's tree, never pending local code.
// Merging the receipt back makes later task-row removal a normal three-way merge.
export async function vibeClaim(options = {}) {
  if (!SESSION_TAG.test(options.tag ?? '') || (options.task && !TASK_ID.test(options.task))) fail('claim에는 --tag와 선택적 --task T###가 필요합니다.')
  const context = await vibeSession(options)
  if (!context.target) return { schemaVersion: 1, ok: true, pushed: null, reason: 'push-disabled' }
  if (!context.remote) fail('선점을 push할 원격이 없습니다.')
  if ((await git(context.root, ['status', '--porcelain'])).trim()) fail('선점 전에 로컬 변경을 커밋하세요.')
  const row = activeRows(context.state ?? '').find((entry) => entry.tag === options.tag)
  if (!row) fail('선점 전에 vibe beat로 세션을 등록하세요.')
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'haeram-claim-'))
  const tracking = `refs/remotes/${context.remote}/${context.target}`
  const env = { ...process.env, GIT_INDEX_FILE: path.join(temporary, 'index') }
  const indexGit = async (args) => (await execute('git', ['-C', context.root, ...args], { env, encoding: 'utf8' })).stdout.trim()
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!await fetchBranch(context.root, context.remote, `refs/heads/${context.target}`, tracking)) fail('원격 대상 브랜치가 없습니다. 먼저 기획 기준을 공유하세요.')
      const parent = await sha(context.root, tracking)
      const remoteState = await git(context.root, ['show', `${parent}:spec/STATE.md`])
      const blocks = parseState(remoteState)
      if (options.task) {
        const tasks = blocks.find((block) => block.name === 'tasks')
        const index = tasks?.body.findIndex((line) => line.split('|')[1]?.trim() === options.task) ?? -1
        if (index < 0) fail('원격에 선점할 태스크가 없습니다. 기획 기준을 먼저 공유하세요.', [options.task])
        const cells = tasks.body[index].split('|').slice(1, -1).map((cell) => cell.trim())
        if (cells[4] !== 'todo' && !cells[4]?.endsWith(`.${options.tag}`)) fail('다른 세션이 선점했거나 실행할 수 없는 태스크입니다.', [options.task, cells[4]])
        cells[4] = `doing@${new Date().toISOString().slice(2, 10).replaceAll('-', '')}.${options.tag}`
        tasks.body[index] = `| ${cells.join(' | ')} |`
      }
      const state = upsertActive(renderState(blocks), { ...row, doing: options.task ?? '-', at: minuteNow() })
      const file = path.join(temporary, 'STATE.md')
      await writeFile(file, state)
      await indexGit(['read-tree', parent])
      const blob = await indexGit(['hash-object', '-w', file])
      await indexGit(['update-index', '--add', '--cacheinfo', `100644,${blob},spec/STATE.md`])
      const tree = await indexGit(['write-tree'])
      const commit = (await git(context.root, ['commit-tree', tree, '-p', parent, '-m', `vibe ${options.tag}: claim ${options.task ?? 'session'}`])).trim()
      try { await git(context.root, ['push', '--quiet', context.remote, `${commit}:refs/heads/${context.target}`]) }
      catch (error) {
        if (/rejected|non-fast-forward|fetch first/i.test(error.stderr ?? '') && attempt < 2) continue
        throw error
      }
      try { await git(context.root, [...await stateMergeArgs(context.root, context.runtime), 'merge', '--no-edit', '--quiet', commit]) }
      catch (error) { await git(context.root, ['merge', '--abort'], [1, 128]); fail('원격 선점은 기록됐지만 로컬 병합에 실패했습니다. 변경을 보존하고 sync하세요.', [error.stderr || error.message]) }
      return { schemaVersion: 1, ok: true, pushed: commit, task: options.task ?? null, progressOnly: true }
    }
  } finally { await rm(temporary, { recursive: true, force: true }) }
}

// This session's presence row; the caller commits and pushes it.
export async function vibeBeat(options = {}) {
  if (!SESSION_TAG.test(options.tag ?? '')) fail('--tag에는 영숫자 2-8자의 세션 tag가 필요합니다.')
  if (options.mode !== undefined && !['pair', 'autopilot'].includes(options.mode)) fail('--mode는 pair 또는 autopilot입니다.')
  if (options.doing !== undefined && options.doing !== '-' && !TASK_ID.test(options.doing)) fail('--doing은 T### 또는 -입니다.')
  const workspace = await inspectWorkspace(options)
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
export async function vibeCheckpoint(options = {}) {
  if (!SESSION_TAG.test(options.tag ?? '')) fail('--tag에는 세션 tag가 필요합니다.')
  const context = await vibeSession(options)
  const { root, remote } = context
  const local = `refs/heads/wip/${options.tag}`
  const tracking = remote ? `refs/remotes/${remote}/wip/${options.tag}` : null
  if (remote && context.target) await fetchBranch(root, remote, `refs/heads/wip/${options.tag}`, tracking).catch(() => false)
  const known = []
  for (const ref of [local, tracking].filter(Boolean)) if (await exists(root, ref)) known.push(await sha(root, ref))
  let previous = known[0] ?? null
  if (known.length === 2 && known[0] !== known[1] && await ancestor(root, known[0], known[1])) previous = known[1]
  const tree = await workingTree(root)
  const head = await sha(root, 'HEAD')
  if (previous && (await git(root, ['rev-parse', `${previous}^{tree}`])).trim() === tree && await ancestor(root, head, previous)) {
    return { schemaVersion: 1, changed: false, commit: previous, branch: `wip/${options.tag}` }
  }
  const parents = previous ? [previous] : []
  if (!previous || !(await ancestor(root, head, previous))) parents.push(head)
  const message = `checkpoint ${options.tag}: ${options.message ?? 'work in progress'}`
  const commit = (await git(root, ['commit-tree', tree, ...parents.flatMap((parent) => ['-p', parent]), '-m', message])).trim()
  await git(root, ['update-ref', local, commit])
  let pushed = false, pushError = null
  if (remote && context.target) {
    try { await git(root, ['push', '--quiet', remote, `${local}:refs/heads/wip/${options.tag}`]); pushed = true } catch (error) { pushError = error.stderr || error.message }
  }
  return { schemaVersion: 1, changed: true, commit, tree, branch: `wip/${options.tag}`, pushed, pushError }
}

const minutesSince = (iso) => iso ? (Date.now() - Date.parse(iso)) / 60000 : Infinity

async function commitTime(root, ref) {
  return (await git(root, ['log', '-1', '--format=%cI', ref, '--'], [128]))?.trim() || null
}

function summarize(text) {
  const map = sections(text)
  const rows = (name) => tableRows(map.get(name))
  const tasks = rows('tasks').map(([id, title, , dep, st]) => ({ id, title, dep, st }))
  const pending = rows('ssot').filter(([, rev, tasked]) => Number(tasked) < Number(rev)).map(([id, rev, tasked, delta]) => ({ id, rev: Number(rev), tasked: Number(tasked), pending: delta }))
  const reviews = rows('review').filter(([, st]) => st?.startsWith('ready@')).map(([id, st]) => ({ id, st }))
  const ideation = rows('ideation').filter(([, st]) => /^(open|ready)@/.test(st ?? '')).map(([id, st]) => ({ id, st }))
  const inbox = (map.get('inbox') ?? []).map((line) => line.trim().match(INBOX_LINE)).filter(Boolean)
    .map(([line, date, kind, refs, text]) => ({ line, date, kind, refs: refs.split(/\s+/), text }))
  return { tasks, pending, reviews, ideation, inbox }
}

// What a session needs before its first question: who else is working (as the remote sees
// it), what is left, and which way to go.
export async function vibeStatus(options = {}) {
  const workspace = await inspectWorkspace(options)
  const root = workspace.git?.root ?? workspace.targetRoot
  const text = await readOptional(path.join(root, 'spec/STATE.md'))
  if (text === null) return { schemaVersion: 1, route: 'architecture', reason: 'spec/STATE.md가 없습니다.', git: Boolean(workspace.git) }
  const cfg = cfgOf(text)
  const settings = await readSettings({ root })
  const result = { schemaVersion: 1, tag: options.tag ?? null, cfg: { level: cfg.get('level') ?? null, lang: cfg.get('lang') ?? null },
    settings: { land: settings.values.land, landVia: settings.values['land-via'], push: settings.values.push, deploy: settings.values.deploy, plan: settings.values.plan, unset: settings.unset, ...(settings.legacy.length ? { legacy: settings.legacy } : {}) } }
  if (options.section) {
    if (options.section !== 'inbox') fail('status --section은 inbox를 지원합니다.')
    return { ...result, inbox: summarize(text).inbox }
  }
  let remoteText = null
  if (workspace.git?.head) {
    const context = await vibeSession(options)
    const branch = context.target ?? context.branch
    let fetchError = null
    if (context.remote && options.fetch !== false) {
      try { await git(root, ['fetch', '--quiet', context.remote]) } catch (error) { fetchError = (error.stderr || error.message).trim() }
    }
    const upstream = context.remote && branch ? `refs/remotes/${context.remote}/${branch}` : null
    const remoteHead = upstream && await exists(root, upstream) ? await sha(root, upstream) : null
    let ahead = 0, behind = 0
    if (remoteHead) [ahead, behind] = (await git(root, ['rev-list', '--left-right', '--count', `HEAD...${remoteHead}`])).trim().split(/\s+/).map(Number)
    if (remoteHead) remoteText = await git(root, ['show', `${remoteHead}:spec/STATE.md`], [128])
    const dirty = (await git(root, ['status', '--porcelain'])).split('\n').filter(Boolean).length
    result.git = { branch: context.branch, head: workspace.git.head, remote: context.remote, target: branch, remoteHead, ahead, behind, dirty, fetchError }
    // Others as the remote sees them: their active rows, refreshed by their wip/<tag> snapshots.
    const remoteRows = activeRows(remoteText ?? '')
    const seen = [...remoteRows, ...activeRows(text).filter((row) => !remoteRows.some((other) => other.tag === row.tag))]
    const sessions = []
    for (const row of seen.filter((entry) => entry.tag !== options.tag)) {
      const wipAt = context.remote ? await commitTime(root, `refs/remotes/${context.remote}/wip/${row.tag}`) : null
      const lastSeen = [row.at, wipAt].filter(Boolean).map((value) => new Date(Date.parse(value)).toISOString()).sort().at(-1) ?? null
      const minutes = minutesSince(lastSeen)
      sessions.push({ ...row, wipAt, lastSeen, minutesAgo: Number.isFinite(minutes) ? Math.round(minutes) : null, stale: minutes > STALE_MINUTES })
    }
    const live = new Set(sessions.filter((row) => !row.stale).map((row) => row.tag))
    if (options.tag) live.add(options.tag)
    const doing = summarize(remoteText ?? text).tasks.filter((task) => task.st?.startsWith('doing@')).map((task) => ({ ...task, tag: task.st.split('.')[1] ?? null }))
    result.others = sessions
    result.orphanDoing = doing.filter((task) => task.tag !== options.tag && !live.has(task.tag))
    result.self = seen.find((entry) => entry.tag === options.tag) ?? null
  }
  const local = summarize(text)
  const design = await designOf(workspace)
  const explore = []
  for (const task of local.tasks) {
    const file = (await readdir(path.join(root, 'spec/tasks')).catch(() => [])).find((name) => name.startsWith(`${task.id}.`))
    const content = file ? await readOptional(path.join(root, 'spec/tasks', file)) : null
    const timebox = exploreValue(quoteFields(quoteLine(content ?? '') ?? '').get('explore'))
    if (timebox) explore.push({ id: task.id, timebox })
  }
  const openReports = []
  for (const file of (await readdir(path.join(root, 'spec/reports')).catch(() => [])).filter((name) => name.endsWith('.md'))) {
    if (quoteFields(quoteLine((await readOptional(path.join(root, 'spec/reports', file))) ?? '') ?? '').get('to') === '-') openReports.push(`spec/reports/${file}`)
  }
  const ownTag = (task) => task.st?.startsWith('doing@') && task.st.split('.')[1] === options.tag
  const implementation = { todo: local.tasks.filter((task) => task.st === 'todo').map((task) => task.id),
    resume: local.tasks.filter(ownTag).map((task) => task.id),
    blocked: local.tasks.filter((task) => task.st?.startsWith('blocked@')).map((task) => task.id),
    pending: local.pending, reviews: local.reviews, explore }
  const planning = { ideation: local.ideation }
  const hasImplementation = implementation.todo.length + implementation.resume.length + implementation.pending.length + implementation.reviews.length > 0
  const hasPlanning = planning.ideation.length > 0
  const parked = new Set(local.inbox.filter((entry) => entry.kind === 'parked').flatMap((entry) => entry.refs))
  const doneFiles = await readdir(path.join(root, 'spec/tasks/done')).catch(() => [])
  const done = new Set(doneFiles.map((file) => file.split('.')[0]))
  const runnable = local.tasks.filter((task) => !parked.has(task.id) && (task.st === 'todo' || ownTag(task)) &&
    (task.dep === '-' || !task.dep || task.dep.split(/[\s,]+/).filter(Boolean).every((id) => done.has(id))))
  return { ...result, concurrency: (result.others ?? []).some((row) => !row.stale) || (result.orphanDoing ?? []).length > 0 ? 'strict' : 'solo',
    next: (sections(text).get('next') ?? []).filter((line) => line.startsWith('- ')).slice(0, 3),
    counts: { inbox: local.inbox.length, parked: local.inbox.filter((entry) => entry.kind === 'parked').length, remaining: local.tasks.length },
    remaining: local.tasks.map((task) => ({ ...task, title: task.title.slice(0, 120) })), runnable: runnable.map((task) => task.id),
    settled: !hasImplementation && !hasPlanning, parkedOnly: !runnable.length && !local.pending.length && !local.reviews.length && !hasPlanning && (parked.size > 0 || implementation.blocked.length > 0),
    implementation, planning, inbox: local.inbox.slice(0, 3).map(({ date, kind, refs, text }) => ({ date, kind, refs, text: text.slice(0, 220) })), inboxMore: local.inbox.length > 3, openReports,
    design,
    // An open design comes first: its edits are uncommitted until the user ends it.
    route: design ? 'design' : hasImplementation && hasPlanning ? 'choose' : hasImplementation ? 'implementation' : hasPlanning ? 'planning' : 'ideation-first' }
}

const which = (command) => execute('sh', ['-c', `command -v ${command}`], { timeout: 5000 }).then(() => true, () => false)

// Everything autopilot needs before the user leaves. needsUser lists what only a person can fix.
export async function vibePreflight(options = {}) {
  const context = await vibeSession(options)
  const checks = []
  const add = (name, ok, detail, needsUser = false) => checks.push({ name, ok, detail, needsUser: !ok && needsUser })
  add('push-target', true, context.target ?? 'commit only (SETTINGS push false)')
  // Informational: an undecided land is settled by haeram-init before autopilot starts (common rule 1);
  // autopilot itself commits on the current branch, so it never blocks here.
  add('branch-settings', true, context.branches.unset ? 'land 미정 — 맡김은 현재 브랜치에 커밋만 합니다(/haeram-init으로 정하면 반영)' : `land ${context.settings.values.land}${context.branches.deploy ? ` → deploy ${context.branches.deploy}` : ''}`)
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
  add('design', !design, design ? `design in progress since ${design.since} (${design.tag}) — end it with start-design first` : 'none', true)
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
    const available = await execute('sh', ['-c', 'command -v "$1"', 'haeram-verify', command], { cwd: context.root, env: options.env ?? process.env, timeout: 5000 }).then(() => true, () => false)
    if (!available) missing.push(command)
  }
  add('verification', missing.length === 0, missing.length ? `missing commands: ${missing.join(', ')}` : verify.declared ? `task: ${verify.task.length}, batch: ${verify.batch.length}; conditional checks remain in ARCH guidance` : 'legacy ARCH: changed tests + fast checks at task tier; select batch commands before code push', true)
  if (options.probe) checks.push(await probeWorker(context, { ...options, permissionMode: await permissionMode(options, context.root) }))
  return { schemaVersion: 1, ok: checks.every((check) => check.ok), checks, needsUser: checks.filter((check) => check.needsUser) }
}

const PROBE_SCHEMA = { type: 'object', additionalProperties: false, required: ['ran', 'exitCode', 'denied', 'note'],
  properties: { ran: { type: 'boolean' }, exitCode: { type: 'integer' }, denied: { type: 'boolean' }, note: { type: 'string' } } }

// Runs the command once through a real headless worker in a fresh, never-trusted worktree —
// the same place work-group workers run — so a permission gap shows before the user leaves.
async function probeWorker(context, options) {
  const provider = options.provider ?? (await which('claude') ? 'claude' : 'codex')
  const allow = options.allowTool ?? []
  const place = await workInternals.destination({ workspace: context.workspace, cwd: context.root }, `probe-${randomUUID().slice(0, 8)}`)
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'haeram-probe-'))
  const bypass = options.permissionMode === 'bypass'
  const probeRoot = options.probeWorkspace === 'current' ? context.root : place
  if (probeRoot === place) await git(context.root, ['worktree', 'add', '--detach', '--quiet', place, 'HEAD'])
  try {
    const prompt = `Run exactly this shell command once with your shell tool from the current directory, and nothing else:\n${options.probe}\nThen report JSON {"ran":bool,"exitCode":int,"denied":bool,"note":string}; denied=true when the tool call was refused for permission.`
    const schemaFile = path.join(temporary, 'schema.json')
    const resultFile = path.join(temporary, 'result.json')
    await writeFile(schemaFile, JSON.stringify(PROBE_SCHEMA))
    const args = provider === 'claude'
      ? ['--print', '--output-format', 'json', '--json-schema', JSON.stringify(PROBE_SCHEMA), '--permission-mode', bypass ? 'bypassPermissions' : 'acceptEdits', '--permission-prompts', 'none',
          '--tools', 'Bash,Read', '--allowedTools', ['Read', ...allow].join(',')]
      : [...(bypass ? ['exec', '--dangerously-bypass-approvals-and-sandbox'] : ['-a', 'never', 'exec', '--sandbox', 'workspace-write']), '--output-schema', schemaFile, '--output-last-message', resultFile, '-']
    if (options.model) args.push('--model', options.model)
    const env = { ...(options.env ?? process.env) }
    delete env.CLAUDECODE
    // Same optional flags as the workers it stands in for.
    if (provider === 'claude') args.push(...await providerFlags(provider, { env }))
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
    return { name: 'worker-probe', ok, needsUser: !ok, permissionMode: options.permissionMode, detail: `${provider} ${options.permissionMode}: ${result?.denied ? 'denied' : `exit ${result?.exitCode}`} — ${result?.note ?? ''}`.trim(), allowTool: allow, workspace: probeRoot, projectSettings: probeRoot === context.root ? 'main checkout: project settings available; trust and effective permissions verified by this probe' : 'new worktree: project allowlist may not apply' }
  } catch (error) {
    return { name: 'worker-probe', ok: false, needsUser: true, detail: error.message }
  } finally {
    if (probeRoot === place) await git(context.root, ['worktree', 'remove', '--force', place], [128]).catch(() => {})
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
  const result = await runVibeCheck(options, command)
  process.stdout.write(`${JSON.stringify(result)}\n`)
  return result.exitCode
}
