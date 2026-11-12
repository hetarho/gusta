import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import { git } from './workspace.mjs'
import { vibeSession, fetchBranch, exists, sha, ancestor, advanceBranch } from './vibe.mjs'
import { stateMergeArgs } from './git-merge.mjs'
import { TASK_ID } from './spec-format.mjs'
import { SkillPackageError } from './errors.mjs'

// Planning documents have one home: the SETTINGS plan branch (unset: land, else the repository
// default branch). Every checkout merges
// that branch before numbering and publishes its spec-only planning commits onto it, so two
// worktrees never hand out the same T###. Only spec/ travels to the plan branch; the plan
// branch's history comes back as a merge, which keeps later three-way merges (task archive,
// STATE row removal) honest.
const execute = promisify(execFile)
const fail = (message, details = []) => { throw new SkillPackageError(message, details) }
const dirty = async (root) => Boolean((await git(root, ['status', '--porcelain', '--untracked-files=no'])).trim())
const treeOf = async (root, commit) => (await git(root, ['rev-parse', `${commit}^{tree}`])).trim()

async function planContext(options) {
  const context = await vibeSession(options)
  return { ...context, plan: context.branches.plan }
}

// The remote branch when the remote has it, else the local one.
async function planTip(context) {
  const { root, remote, plan } = context
  if (remote) {
    const tracking = `refs/remotes/${remote}/${plan}`
    if (await fetchBranch(root, remote, `refs/heads/${plan}`, tracking)) return { commit: await sha(root, tracking), remote: true, label: `${remote}/${plan}` }
  }
  const local = `refs/heads/${plan}`
  if (await exists(root, local)) return { commit: await sha(root, local), remote: false, label: plan }
  return fail(`기획 브랜치 ${plan}이 없습니다. spec/SETTINGS.md plan에 기획 정본 브랜치를 적거나 -로 두세요(/gusta-preference).`)
}

// merge-tree never touches the working tree; STATE merges by section like every other merge.
async function mergeTrees(context, base, ours, theirs) {
  const args = ['-C', context.root, ...await stateMergeArgs(context.root, context.runtime), 'merge-tree', '--write-tree', '--name-only', '--no-messages', ...(base ? [`--merge-base=${base}`] : []), ours, theirs]
  try {
    const { stdout } = await execute('git', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } })
    return { tree: stdout.split('\n')[0].trim(), conflicts: [] }
  } catch (error) {
    if (error.code !== 1 || !error.stdout) fail('기획 브랜치와 합치지 못했습니다.', [(error.stderr || error.message).trim()])
    return { tree: null, conflicts: [...new Set(error.stdout.split('\n').slice(1).map((line) => line.trim()).filter(Boolean))] }
  }
}

// task id → path:blob of every file under spec/tasks (active and done).
async function taskFiles(root, tree) {
  const byId = new Map()
  for (const entry of (await git(root, ['ls-tree', '-r', '-z', tree, '--', 'spec/tasks'])).split('\0').filter(Boolean)) {
    const [meta, file] = entry.split('\t')
    const id = path.posix.basename(file).split('.')[0]
    if (TASK_ID.test(id)) byId.set(id, [...(byId.get(id) ?? []), `${file}:${meta.split(' ')[2]}`])
  }
  return byId
}

// Both sides adding the same T### (absent from the base) in different files means two
// checkouts numbered the same task; two files for one T### afterwards means the same.
async function collisions(root, base, ours, theirs) {
  const [before, left, right] = await Promise.all([base, ours, theirs].map((tree) => taskFiles(root, tree)))
  return [...left].filter(([id, files]) => !before.has(id) && right.has(id) && files.join() !== right.get(id).join())
    .map(([id, files]) => `${id}: ${[...new Set([...files, ...right.get(id)].map((entry) => entry.split(':')[0]))].join(' ')}`)
}

async function duplicateTasks(root, tree) {
  return [...await taskFiles(root, tree)].filter(([, files]) => files.length > 1).map(([id, files]) => `${id}: ${files.map((entry) => entry.split(':')[0]).join(' ')}`)
}

async function commitTree(root, tree, parents, message, env = {}) {
  const { stdout } = await execute('git', ['-C', root, 'commit-tree', tree, ...parents.flatMap((parent) => ['-p', parent]), '-m', message], { encoding: 'utf8', env: { ...process.env, ...env } })
  return stdout.trim()
}

// Bring `commit` into HEAD: fast-forward, or a merge commit built off the working tree and
// then fast-forwarded to, so a conflict leaves the checkout untouched.
async function mergeInto(context, commit, label) {
  const { root } = context
  const head = await sha(root, 'HEAD')
  if (await ancestor(root, commit, head)) return { action: 'none', head }
  let next = commit, action = 'ff'
  if (!(await ancestor(root, head, commit))) {
    const base = (await git(root, ['merge-base', head, commit], [1]))?.trim()
    const clashes = base ? await collisions(root, base, head, commit) : []
    if (clashes.length) return { action: 'collision', duplicates: clashes }
    const merged = await mergeTrees(context, null, head, commit)
    if (!merged.tree) return { action: 'conflict', conflicts: merged.conflicts }
    const duplicates = await duplicateTasks(root, merged.tree)
    if (duplicates.length) return { action: 'collision', duplicates }
    next = await commitTree(root, merged.tree, [head, commit], `Merge ${label} into ${context.branch ?? 'HEAD'}`)
    action = 'merge'
  }
  await git(root, ['merge', '--ff-only', '--quiet', next])
  return { action, head: next }
}

// Move the local plan branch forward only when that is a fast-forward and, where it is
// checked out, the checkout is clean.
const advanceLocal = (context, commit) => advanceBranch(context, context.plan, commit)

const collision = (duplicates) => fail('태스크 ID 충돌: 다른 checkout이 같은 번호를 먼저 기획 브랜치에 올렸습니다. plan-sync 후 이 checkout의 미발행 태스크를 다시 채번하세요.', duplicates)

// Before planning: merge the plan branch's latest into this checkout.
export async function vibePlanSync(options = {}) {
  const context = await planContext(options)
  if (!context.plan) return { schemaVersion: 1, ok: true, action: 'none', reason: 'plan-disabled' }
  const tip = await planTip(context)
  if (!(await ancestor(context.root, tip.commit, 'HEAD')) && await dirty(context.root)) fail('커밋하지 않은 변경이 있어 기획 브랜치를 합칠 수 없습니다. 먼저 커밋하세요.')
  const result = await mergeInto(context, tip.commit, tip.label)
  if (result.action === 'conflict') fail(`기획 브랜치 ${tip.label}과 충돌했습니다. 직접 merge해 충돌을 해결하세요.`, result.conflicts)
  if (result.action === 'collision') collision(result.duplicates)
  return { schemaVersion: 1, ok: true, action: result.action, plan: context.plan, tip: tip.commit, head: result.head, remote: tip.remote }
}

// After a planning commit: replay spec-only commits onto the plan branch (push when it lives
// on the remote, fast-forward the local branch otherwise), then merge the result back.
export async function vibePlanPush(options = {}) {
  const context = await planContext(options)
  if (!context.plan) return { schemaVersion: 1, ok: true, pushed: null, reason: 'plan-disabled' }
  const { root, plan } = context
  if (await dirty(root)) fail('커밋하지 않은 변경이 있습니다. 기획 문서를 먼저 커밋하세요.')
  const commits = []
  for (const ref of options.commit ?? ['HEAD']) {
    const commit = await sha(root, ref)
    const parents = (await git(root, ['rev-list', '--parents', '-n', '1', commit])).trim().split(/\s+/).slice(1)
    if (parents.length !== 1) fail('기획 커밋을 하나씩 지정하세요(병합 커밋·최초 커밋 제외).', [ref])
    const outside = (await git(root, ['diff', '--name-only', '--no-renames', parents[0], commit])).split('\n').filter((file) => file && !file.startsWith('spec/'))
    if (outside.length) fail('기획 커밋에 spec/ 밖 변경이 있습니다. 코드와 기획 문서를 나눠 커밋하세요.', outside)
    commits.push({ commit, parent: parents[0] })
  }
  let last
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const tip = await planTip(context)
    let current = tip.commit, applied = 0
    for (const entry of commits) {
      if (await ancestor(root, entry.commit, current)) continue
      if (entry.parent === current) { current = entry.commit; applied += 1; continue }
      const clashes = await collisions(root, entry.parent, current, entry.commit)
      if (clashes.length) collision(clashes)
      const merged = await mergeTrees(context, entry.parent, current, entry.commit)
      if (!merged.tree) fail(`기획 브랜치 ${tip.label}과 충돌했습니다. plan-sync로 합친 뒤 기획 커밋을 다시 만드세요.`, merged.conflicts)
      if (merged.tree === await treeOf(root, current)) continue
      const [name, email, date, ...message] = (await git(root, ['log', '-1', '--format=%an%x00%ae%x00%aI%x00%B', entry.commit])).split('\0')
      current = await commitTree(root, merged.tree, [current], message.join('\0').trim(), { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_AUTHOR_DATE: date })
      applied += 1
    }
    if (!applied) return { schemaVersion: 1, ok: true, pushed: null, reason: 'up-to-date', plan }
    const duplicates = await duplicateTasks(root, current)
    if (duplicates.length) collision(duplicates)
    if (tip.remote) {
      try { await git(root, ['push', '--quiet', context.remote, `${current}:refs/heads/${plan}`]) } catch (error) {
        last = error.stderr || error.message
        if (/rejected|non-fast-forward|fetch first|stale info/i.test(last)) continue
        break
      }
      await git(root, ['update-ref', `refs/remotes/${context.remote}/${plan}`, current])
    }
    const local = await advanceLocal(context, current)
    if (!tip.remote && local === 'moved') continue
    if (!tip.remote && ['dirty', 'diverged'].includes(local)) fail(`로컬 기획 브랜치 ${plan}에 반영하지 못했습니다(${local === 'dirty' ? '그 checkout에 커밋하지 않은 변경' : '갈라진 이력'}).`, [current])
    const receipt = await mergeInto(context, current, plan)
    const result = { schemaVersion: 1, ok: !['conflict', 'collision'].includes(receipt.action), pushed: tip.remote ? current : null, published: current, plan, remote: tip.remote, local, merge: receipt.action, attempts: attempt }
    if (!result.ok) Object.assign(result, { error: `${plan}에는 올렸지만 이 checkout에 합치지 못했습니다. 충돌을 해결한 뒤 plan-sync하세요.`, details: receipt.conflicts ?? receipt.duplicates })
    return result
  }
  return fail('기획 브랜치에 올리지 못했습니다.', [last ?? '다른 checkout이 계속 먼저 반영했습니다.'])
}
