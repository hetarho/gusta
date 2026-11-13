import { mkdir, readFile, writeFile, realpath } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { inspectWorkspace, git } from './workspace.mjs'
import { branchPlan, defaultBranch, readSettings } from './settings.mjs'
import { SESSION_TAG } from './spec-format.mjs'
import { SkillPackageError } from './errors.mjs'

const MARKER = 'gusta-session.json'
const KINDS = ['start', 'self-improve', 'self-improve-remote']
const fail = (message, details = []) => { throw new SkillPackageError(message, details) }
const inside = (parent, child) => { const relative = path.relative(parent, child); return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) }

export async function sessionWorkspacePolicy(options = {}, injected = {}) {
  const deps = { inspect: inspectWorkspace, settings: readSettings, defaultBranch, ...injected }
  const workspace = options.workspace ?? await deps.inspect(options)
  if (!workspace.git) return { workspace, plan: null, protectedBranches: [], allowed: false, reason: 'git-required' }
  const { values } = await deps.settings({ root: workspace.git.root })
  const fallback = await deps.defaultBranch(workspace.git.root)
  const plan = branchPlan(values, { branch: workspace.git.branch, defaultBranch: fallback })
  // Without a remote HEAD, defaultBranch's fallback is the primary checkout's *current*
  // branch. An explicit land/plan policy must not turn a newly switched child into a default.
  const run = deps.git ?? git
  const defaults = (await run(workspace.git.root, ['for-each-ref', '--format=%(symref)', 'refs/remotes/*/HEAD']).catch(() => '')).split('\n').filter(Boolean)
  const origin = (await run(workspace.git.root, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], [1, 128]))?.trim()
  if (origin) defaults.push(origin)
  const authoritativeDefault = defaults.some((ref) => ref.endsWith(`/${fallback}`))
  const keepFallback = authoritativeDefault || !plan.land
  const protectedBranches = [...new Set([...(keepFallback ? [fallback] : []), plan.land, plan.deploy, plan.plan, plan.coord, `${plan.coord}-integration`].filter(Boolean))]
  const ambiguous = !authoritativeDefault && !plan.land
  let owned = false
  if (ambiguous && workspace.git.isLinkedWorktree) {
    const owner = await readOwnership(workspace.git.gitDir, deps.readFile ?? readFile)
    owned = owner?.root === workspace.git.root && owner.branch === workspace.git.branch && /^[0-9a-f]{40,64}$/.test(owner.sourceHead ?? '') && (await run(workspace.git.root, ['merge-base', '--is-ancestor', owner.sourceHead, workspace.git.head], [1, 128])) !== null
  }
  const reason = !workspace.git.head ? 'commit-required' : !workspace.git.branch ? 'detached' : protectedBranches.includes(workspace.git.branch) ? 'protected-branch' : ambiguous && !owned ? 'default-branch-unknown' : null
  return { workspace, plan, protectedBranches, allowed: reason === null, reason }
}

export async function assertImplementationWorkspace(options = {}, injected = {}) {
  const policy = await sessionWorkspacePolicy(options, injected)
  if (!policy.allowed) fail('구현은 Git의 하위 작업 브랜치에서만 실행합니다.', [policy.reason, policy.workspace.git?.branch ?? policy.workspace.targetRoot])
  if (options.requireLinked && !policy.workspace.git.isLinkedWorktree) fail('이 세션은 전용 worktree에서 실행해야 합니다.', [policy.workspace.git.root])
  return policy
}

async function readOwnership(directory, read) {
  let value
  try { value = JSON.parse(await read(path.join(directory, MARKER), 'utf8')) } catch (error) {
    if (error.code === 'ENOENT') return null
    fail('세션 worktree 소유 기록을 읽을 수 없습니다.', [directory, error.message])
  }
  if (value?.schemaVersion !== 1 || !KINDS.includes(value.kind) || !SESSION_TAG.test(value.tag ?? '') || typeof value.branch !== 'string' || typeof value.root !== 'string') fail('세션 worktree 소유 기록이 올바르지 않습니다.', [directory])
  return value
}

// The original checkout is never switched, staged, reset or copied. A writing session begins
// from an explicit committed source and owns only its new linked checkout.
export async function prepareSessionWorkspace(options = {}, injected = {}) {
  const deps = { inspect: inspectWorkspace, settings: readSettings, defaultBranch, git, mkdir, readFile, writeFile, realpath, uuid: randomUUID, ...injected }
  const kind = options.kind ?? 'start', tag = options.tag ?? deps.uuid().replaceAll('-', '').slice(0, 8)
  if (!KINDS.includes(kind) || !SESSION_TAG.test(tag)) fail('세션 kind와 영숫자 2-8자의 tag가 필요합니다.')
  const policy = await sessionWorkspacePolicy(options, deps), source = policy.workspace.git
  if (!source?.head) fail('전용 세션 worktree를 만들려면 커밋이 있는 Git 저장소가 필요합니다.', [policy.workspace.targetRoot])
  const ownership = await readOwnership(source.gitDir, deps.readFile)
  if (ownership && source.isLinkedWorktree && policy.allowed && ownership.kind === kind && ownership.tag === tag && ownership.branch === source.branch && ownership.root === source.root) {
    return { created: false, targetRoot: source.root, root: source.root, branch: source.branch, kind, tag, sourceRoot: ownership.sourceRoot, sourceHead: ownership.sourceHead, ownership }
  }
  const dirty = await deps.git(source.root, ['status', '--porcelain=v1', '--untracked-files=all'])
  if (dirty) fail('원래 checkout에 미커밋 변경이 있어 세션을 옮기지 않았습니다. 변경을 보존한 채 먼저 정리하거나 명시적으로 인계하세요.', [source.root])
  const primary = source.worktrees.find((entry) => !entry.bare)?.path ?? source.root
  const identity = createHash('sha256').update(source.commonDir).digest('hex').slice(0, 8)
  const suffix = deps.uuid().replaceAll('-', '').slice(0, 8)
  const branch = options.branch ?? `gusta-session-${kind}-${tag}-${suffix}`
  if (typeof branch !== 'string' || branch.startsWith('-') || policy.protectedBranches.includes(branch)) fail('보호 브랜치를 세션 작업 브랜치로 쓸 수 없습니다.', [String(branch)])
  await deps.git(source.root, ['check-ref-format', '--branch', branch])
  const destination = path.resolve(options.path ?? path.join(path.dirname(primary), '.gusta-worktrees', `${path.basename(primary)}-${identity}`, `${kind}-${tag}-${suffix}`))
  if (source.worktrees.some((entry) => entry.path && inside(path.resolve(entry.path), destination)) || inside(source.commonDir, destination)) fail('전용 worktree는 기존 checkout과 Git 메타데이터 밖에 만드세요.', [destination])
  await deps.mkdir(path.dirname(destination), { recursive: true })
  const target = path.join(await deps.realpath(path.dirname(destination)), path.basename(destination))
  if (source.worktrees.some((entry) => entry.path && inside(path.resolve(entry.path), target)) || inside(source.commonDir, target)) fail('worktree 목적지가 기존 checkout 안으로 연결됩니다.', [target])
  const base = options.base ?? source.head
  const sourceHead = (await deps.git(source.root, ['rev-parse', '--verify', `${base}^{commit}`])).trim()
  await deps.git(source.root, ['worktree', 'add', '-b', branch, target, sourceHead])
  const prepared = await deps.inspect({ targetRoot: target })
  const marker = { schemaVersion: 1, kind, tag, branch, root: prepared.git.root, sourceRoot: source.root, sourceHead }
  await deps.writeFile(path.join(prepared.git.gitDir, MARKER), `${JSON.stringify(marker, null, 2)}\n`, { flag: 'wx' })
  return { created: true, targetRoot: prepared.git.root, root: prepared.git.root, branch, kind, tag, sourceRoot: source.root, sourceHead, ownership: marker }
}
