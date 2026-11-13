import { inspectWorkspace } from './workspace.mjs'
import { readInteractive, writeInteractive } from './interactive-state.mjs'
import { SESSION_TAG } from './spec-format.mjs'
import { readVerification } from './vibe-brief.mjs'
import { runVibeCheck } from './vibe-check.mjs'
import { minuteNow } from './vibe.mjs'
import { SkillPackageError } from './errors.mjs'

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
  if (step === 'verify') return verifyDesign(options, root, design)
  if (step === 'end') {
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
  const entry = { since: minuteNow(), tag: options.tag, scope: scope ?? '-' }
  await writeInteractive(workspace, { ...state, design: entry })
  return { schemaVersion: 1, ok: true, resumed: false, design: entry }
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
  const results = []
  for (const command of verify.task) {
    const result = await runVibeCheck({ targetRoot: root, tier: 'task', uncommitted: true, timeoutMs: options.timeoutMs, signal: options.signal, env: options.env }, command)
    results.push({ tier: 'task', command, ok: result.ok, cached: result.cached, exitCode: result.exitCode, timedOut: result.timedOut ?? false, stale: result.stale ?? false,
      ms: result.ms ?? 0, failedTests: result.failedTests, tail: result.ok ? [] : result.tail, log: result.log })
  }
  return { ...base, ok: results.every((result) => result.ok), results, skipped: [], guidance: verify.guidance,
    next: '로컬 task 검사 결과다. 디자인을 끝내고 하위 브랜치에 커밋한 뒤 vibe integration finish --tag <session tag>로 제출한다. --verify로 고른 명령은 공동 통합에도 전달한다. 전체 검수와 필요한 agent acceptance·CI는 아직 완료되지 않았다.' }
}
