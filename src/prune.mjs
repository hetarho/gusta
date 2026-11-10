import { access, rm } from 'node:fs/promises'
import path from 'node:path'
import { git } from './workspace.mjs'
import { readRuntime, transaction } from './work-runtime.mjs'
import { readSetting } from './settings.mjs'
import { readTaskBoard } from './task-board.mjs'
import { mainSessionTasks } from './task-graph.mjs'
import { activeAttempt, scopedBoard } from './work-policy.mjs'
import { cleanupWork, pruneCleanedAttempt, workInternals } from './work-groups.mjs'
import { vibeSession, fetchBranch } from './vibe.mjs'
import { activeRows } from './state-doc.mjs'

// prune-branches (spec/SETTINGS.md): once work ends, the CLI deletes what it created and nothing
// still needs — worktrees, branches, checkpoint refs and wip/* snapshots. Anything holding commits
// the target lacks, uncommitted changes, or a live claim stays and is reported with the reason.
const { repository, requireClean, now } = workInternals
const commitOf = async (root, name) => (await git(root, ['rev-parse', '--verify', '--quiet', `${name}^{commit}`], [1]))?.trim() || null
const contains = async (root, older, newer) => (await git(root, ['merge-base', '--is-ancestor', older, newer], [1])) !== null
const exists = (file) => access(file).then(() => true, () => false)
// work run writes each dispatch's live log under its unit, so a unit's logs go as one folder.
export const dispatchLogDir = (root, attemptId) => path.join(root, 'logs', attemptId)

// A finished group is unused once its branch is merged into the branch it came from or the
// branch it pushes to (local, or as last fetched).
async function mergedInto(root, group) {
  const tip = await commitOf(root, `refs/heads/${group.branch}`)
  if (!tip) return 'missing'
  for (const name of [...new Set([group.baseRef, group.push].filter(Boolean))]) {
    for (const ref of [`refs/heads/${name}`, `refs/remotes/${group.remote ?? 'origin'}/${name}`]) {
      const at = await commitOf(root, ref)
      if (at && await contains(root, tip, at)) return ref
    }
  }
  return null
}

async function pruneGroup(context, id) {
  const state = await readRuntime(context.root)
  const group = state.groups[id]
  if (!group.managed) return { kept: '현재 checkout을 채택한 묶음이라 브랜치·공간을 그대로 둡니다.' }
  if (group.runner || group.operation) return { kept: '실행기 또는 통합 명령이 실행 중입니다.' }
  const attempts = Object.values(state.attempts).filter((entry) => entry.group === id)
  if (attempts.some((entry) => activeAttempt(entry) || entry.operation || (!entry.cleanedAt && entry.status !== 'failed'))) return { kept: '정리되지 않은 실행이 남아 있습니다.' }
  if (context.cwd === group.path) return { kept: '지금 이 묶음의 기획 공간에서 실행 중입니다.' }
  const into = await mergedInto(context.cwd, group)
  if (!into) return { kept: `${group.branch}가 ${[group.baseRef, group.push].filter(Boolean).join('·')}에 아직 합쳐지지 않았습니다.` }
  if (into !== 'missing') {
    const board = scopedBoard(await readTaskBoard({ targetRoot: context.cwd, ref: `refs/heads/${group.branch}` }), group)
    const deferred = mainSessionTasks(board.tasks)
    if (!board.ok || board.tasks.some((task) => !deferred.has(task.id))) return { kept: '남은 태스크가 있습니다.' }
  }
  const pruned = []
  let kept = null
  if (await access(group.path).then(() => true, () => false)) {
    try { await requireClean(group.path) } catch (error) { return { kept: error.message } }
    await git(context.cwd, ['worktree', 'remove', '--force', group.path])
    pruned.push(group.path)
  }
  if (into !== 'missing') {
    if (await git(context.cwd, ['branch', '-D', group.branch], [1]) === null) kept = `${group.branch}: 다른 작업 공간이 사용 중이라 보존합니다.`
    else pruned.push(group.branch)
  }
  await transaction(context.root, (current) => { Object.assign(current.groups[id], { status: 'pruned', prunedAt: now(), prunedRefs: pruned, branchKept: kept }) })
  return { pruned, kept }
}

// Attempts first (integrated or released, nobody working), then — with groups — the group
// branch and planning worktree. A runner prunes attempts only: the coordinator
// still reads the group afterwards.
export async function pruneWork(options = {}) {
  const context = await repository(options)
  if (!(await readSetting({ root: context.cwd }, 'prune-branches'))) return { skipped: 'prune-branches: false' }
  const state = await readRuntime(context.root)
  const result = { cleaned: [], pruned: [], kept: [] }
  for (const group of Object.values(state.groups)) {
    if (group.status !== 'active' || (options.work && group.id !== options.work)) continue
    for (const attempt of Object.values(state.attempts)) {
      if (attempt.group !== group.id || activeAttempt(attempt) || attempt.operation || attempt.status === 'failed') continue
      // A cleaned attempt is revisited only for what an older cleanup left behind.
      const leftovers = (attempt.preservedCandidates ?? []).length || (attempt.managed && attempt.branch && !(attempt.prunedRefs ?? []).includes(attempt.branch))
      let current = attempt
      if (!attempt.cleanedAt || leftovers) {
        try {
          const done = attempt.cleanedAt ? await pruneCleanedAttempt({ targetRoot: context.cwd, attempt: attempt.id }) : await cleanupWork({ targetRoot: context.cwd, attempt: attempt.id })
          if (done) {
            current = done
            if (!attempt.cleanedAt) result.cleaned.push(attempt.id)
            result.pruned.push(...(done.prunedRefs ?? []).filter((ref) => !(attempt.prunedRefs ?? []).includes(ref)))
            if (done.branchKept) result.kept.push({ attempt: attempt.id, reason: done.branchKept })
            for (const candidate of done.preservedCandidates ?? []) result.kept.push({ attempt: attempt.id, path: candidate, reason: 'candidate workspace not removable' })
          }
        } catch (error) {
          result.kept.push({ attempt: attempt.id, path: attempt.workspace, reason: error.message })
          continue
        }
      }
      // Dispatch logs go with a merged unit that left nothing behind; a unit kept above keeps them
      // too, and a released (unmerged) one keeps them, reported once when it is cleaned.
      const logs = dispatchLogDir(context.root, attempt.id)
      if (!current.cleanedAt || !(await exists(logs))) continue
      if (current.status === 'integrated' && !current.branchKept && !(current.preservedCandidates ?? []).length) {
        await rm(logs, { recursive: true, force: true })
        result.pruned.push(logs)
      } else if (!attempt.cleanedAt && current.status !== 'integrated') result.kept.push({ attempt: attempt.id, path: logs, reason: '합쳐지지 않은 단위라 dispatch 로그를 보존합니다.' })
    }
    if (!options.groups) continue
    try {
      const closed = await pruneGroup(context, group.id)
      result.pruned.push(...(closed.pruned ?? []))
      if (closed.kept) result.kept.push({ work: group.id, path: group.path, reason: closed.kept })
    } catch (error) { result.kept.push({ work: group.id, path: group.path, reason: error.message }) }
  }
  return result
}

// The session's own wip/<tag>: a snapshot of a working tree that is now fully committed. The
// remote copy goes only once HEAD is on the remote push branch — until then it is the record
// another device would resume from.
async function pruneWip(context, tag) {
  const { root, remote, target } = context
  const pruned = [], kept = []
  if (context.state && activeRows(context.state).some((row) => row.tag === tag)) return { pruned, kept: [{ ref: `wip/${tag}`, reason: '이 tag의 active 행이 남아 있습니다(beat --end 전).' }] }
  if ((await git(root, ['status', '--porcelain', '--untracked-files=all'])).trim()) return { pruned, kept: [{ ref: `wip/${tag}`, reason: '미커밋 변경이 있어 스냅샷을 보존합니다.' }] }
  if (await commitOf(root, `refs/heads/wip/${tag}`)) {
    await git(root, ['branch', '-D', `wip/${tag}`])
    pruned.push(`wip/${tag}`)
  }
  if (remote && target) {
    const tracking = `refs/remotes/${remote}/${target}`
    const fetched = await fetchBranch(root, remote, `refs/heads/${target}`, tracking).catch(() => false)
    if (!fetched || !(await contains(root, 'HEAD', tracking))) kept.push({ ref: `${remote}/wip/${tag}`, reason: `HEAD가 아직 ${remote}/${target}에 없습니다.` })
    else if (await git(root, ['push', '--quiet', remote, '--delete', `wip/${tag}`], [1, 128]) !== null) pruned.push(`${remote}/wip/${tag}`)
  }
  return { pruned, kept }
}

// vibe prune [--tag <tag>] [--work <slug>]: the end-of-session sweep. Reads prune-branches itself,
// so skills call it unconditionally as the last step.
export async function vibePrune(options = {}) {
  const context = await vibeSession(options)
  if (!(await readSetting({ root: context.root }, 'prune-branches'))) return { schemaVersion: 1, ok: true, skipped: 'prune-branches: false' }
  const wip = options.tag ? await pruneWip(context, options.tag) : { pruned: [], kept: [] }
  const work = await pruneWork({ targetRoot: context.root, work: options.work, groups: true })
  const kept = [...wip.kept, ...work.kept]
  return { schemaVersion: 1, ok: true, pruned: [...wip.pruned, ...work.pruned], cleaned: work.cleaned, kept: kept.slice(0, 20), keptCount: kept.length }
}
