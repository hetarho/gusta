import { access } from 'node:fs/promises'
import { inspectWorkspace, git } from './workspace.mjs'
import { readInteractive, writeInteractive } from './interactive-state.mjs'
import { SESSION_TAG } from './spec-format.mjs'
import { readVerification } from './vibe-brief.mjs'
import { runVibeCheck } from './vibe-check.mjs'
import { minuteNow } from './vibe.mjs'
import { SkillPackageError } from './errors.mjs'
import { sessionWorkspacePolicy } from './session-workspace.mjs'

const fail = (message, details = []) => { throw new SkillPackageError(message, details) }

// Design mode: a pair session edits code while the user watches the result live. Tests, commits
// and pushes wait until the user ends the design. The open design is this checkout's interactive
// state (its Git directory), so STATE and every other worktree stay untouched. The caller commits.
export async function vibeDesign(options = {}) {
  const step = options.step ?? 'status'
  if (!['status', 'start', 'verify', 'end'].includes(step)) fail('vibe design [start|verify|end]')
  const workspace = await inspectWorkspace(options)
  if (!workspace.git) fail('디자인 모드에는 Git checkout이 필요합니다.')
  const root = workspace.git.root
  const state = await readInteractive(workspace)
  const design = state.design ?? null
  if (step === 'status') return { schemaVersion: 1, ok: true, design }
  // A showcase design edits the main variant's worktree: its edits reach this checkout only through vibe ab pick.
  const showcase = design?.showcase && await access(design.showcase.path).then(() => design.showcase, () => null)
  if (step === 'verify') {
    if (showcase) fail(`showcase 디자인은 vibe ab pick ${showcase.slug}로 메인 ${showcase.variant}을 이 checkout에 옮긴 뒤 검사합니다.`)
    return verifyDesign(options, root, design)
  }
  if (step === 'end') {
    if (showcase) fail(`showcase 디자인은 vibe ab pick ${showcase.slug}(메인을 옮김) 또는 vibe ab stop ${showcase.slug} --remove(버림) 뒤에 끝냅니다.`)
    if (design) await writeInteractive(workspace, { ...state, design: undefined })
    return { schemaVersion: 1, ok: true, ended: Boolean(design), design }
  }
  if (!SESSION_TAG.test(options.tag ?? '')) fail('--tag에는 영숫자 2-8자의 세션 tag가 필요합니다.')
  const scope = options.scope?.replace(/\s+/g, ' ').trim() || null
  // A design left open by an earlier conversation resumes with its own since and tag.
  if (design) {
    const resumed = { ...design, scope: scope ?? design.scope }
    if (resumed.scope !== design.scope) await writeInteractive(workspace, { ...state, design: resumed })
    return { schemaVersion: 1, ok: true, resumed: true, design: resumed }
  }
  return { schemaVersion: 1, ok: true, resumed: false, ...(await openDesign(workspace, state, { tag: options.tag, scope })) }
}

// Opens a design on this checkout. Design edits never sit on land, deploy, plan or the default branch:
// a checkout there moves to design/<tag> first (git switch carries the uncommitted edits along; the dev
// server keeps its path). `showcase` names the main variant whose worktree the design edits (vibe ab main).
export async function openDesign(workspace, state, { tag, scope, showcase }) {
  if (!SESSION_TAG.test(tag ?? '')) fail('--tag에는 영숫자 2-8자의 세션 tag가 필요합니다.')
  const root = workspace.git.root
  const policy = await sessionWorkspacePolicy({ targetRoot: root, workspace })
  let switched = null
  if (policy.reason === 'protected-branch') {
    const branch = `design/${tag}`
    if ((await git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], [1]))?.trim()) fail(`${branch} 브랜치가 이미 있습니다. 그 브랜치로 전환해 이어 하거나 다른 tag를 쓰세요.`, [workspace.git.branch])
    await git(root, ['switch', '--quiet', '-c', branch])
    switched = { from: workspace.git.branch, to: branch }
  }
  const entry = { since: minuteNow(), tag, scope: scope ?? '-', ...(showcase ? { showcase } : {}) }
  await writeInteractive(workspace, { ...state, design: entry })
  return { design: entry, ...(switched ? { switched } : {}) }
}

// Design edits stay uncommitted here. Only their task checks run locally; final commands
// belong to the shared fixed candidate after the design is ended and committed.
async function verifyDesign(options, root, design) {
  const verify = await readVerification(root)
  const deferred = [
    ...[...new Set(options.verify ?? verify.batch)].map((command) => ({ tier: 'batch', command, reason: 'shared-integration' })),
    ...verify.ci.map((command) => ({ tier: 'ci', command, reason: 'ci-only' })),
  ]
  const base = { schemaVersion: 1, design, scope: 'local-design', finalVerified: false, tree: null, deferred }
  if (!verify.task.length && !deferred.length) return { ...base, ok: false, results: [], skipped: [], error: 'ARCH와 package.json에서 검증 명령을 찾지 못했습니다. 변경 영향 task 검사를 정하고 전체 검수는 커밋 후 공동 통합으로 제출하세요.' }
  // No task check ran: not a pass. The changed files say what a scoped check has to cover.
  if (!verify.task.length) {
    const changed = (await git(root, ['status', '--porcelain', '--untracked-files=all'])).split('\n').filter(Boolean).map((line) => line.slice(3))
    return { ...base, ok: false, reason: 'no-task-checks', results: [], skipped: [], changed: changed.slice(0, 50), changedCount: changed.length, guidance: verify.guidance,
      next: 'ARCH에 task 단계 명령이 없어 아무 검사도 돌지 않았다(통과 아님). 바뀐 파일의 영향 검사(관련 테스트·변경 파일 lint)를 vibe check --tier task -- <command>로 한 번 돌리고, 전체 스위트는 로컬에서 돌리지 않는다. 반복되면 ARCH 검증 결정에 task 명령을 두는 개정을 제안한다.' }
  }
  const results = []
  for (const command of verify.task) {
    const result = await runVibeCheck({ targetRoot: root, tier: 'task', uncommitted: true, timeoutMs: options.timeoutMs, signal: options.signal, env: options.env }, command)
    results.push({ tier: 'task', command, ok: result.ok, cached: result.cached, exitCode: result.exitCode, timedOut: result.timedOut ?? false, stale: result.stale ?? false,
      ms: result.ms ?? 0, failedTests: result.failedTests, tail: result.ok ? [] : result.tail, log: result.log })
  }
  return { ...base, ok: results.every((result) => result.ok), results, skipped: [], guidance: verify.guidance,
    next: '로컬 task 검사 결과다. 디자인을 끝내고 하위 브랜치에 커밋한 뒤 vibe integration finish --tag <session tag>로 제출한다. --verify로 고른 명령은 공동 통합에도 전달한다. 전체 검수와 필요한 agent acceptance·CI는 아직 완료되지 않았다.' }
}
