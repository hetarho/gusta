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

// Every ARCH task and batch command once, on the uncommitted working tree, at the batch tier.
// Fast checks go first: a failure there changes the tree anyway, so the slow suites wait for the fix.
async function verifyDesign(options, root, design) {
  const verify = await readVerification(root)
  const plan = []
  for (const [tier, commands] of [['task', verify.task], ['batch', options.verify ?? verify.batch]]) {
    for (const command of commands) if (!plan.some((step) => step.command === command)) plan.push({ tier, command })
  }
  if (!plan.length) return { schemaVersion: 1, ok: false, design, results: [], skipped: [], error: 'ARCH와 package.json에서 검증 명령을 찾지 못했습니다. 프로젝트의 전체 테스트 명령을 --verify로 넘기세요.' }
  const results = [], skipped = []
  let tree = null
  for (const step of plan) {
    if (step.tier === 'batch' && results.some((result) => !result.ok)) { skipped.push(step.command); continue }
    // The person asked for this run: it is not a coordinator's gate round and never refused by the cap.
    const result = await runVibeCheck({ targetRoot: root, tier: 'batch', uncommitted: true, gateLedger: false, timeoutMs: options.timeoutMs, signal: options.signal, env: options.env }, step.command)
    results.push({ tier: step.tier, command: step.command, ok: result.ok, cached: result.cached, exitCode: result.exitCode, timedOut: result.timedOut ?? false, stale: result.stale ?? false,
      ms: result.ms ?? 0, failedTests: result.failedTests, tail: result.ok ? [] : result.tail, log: result.log })
    tree = result.tree
  }
  const ok = !skipped.length && results.every((result) => result.ok)
  // tree identifies what passed: a commit of exactly this tree needs no second run before push.
  return { schemaVersion: 1, ok, design, tree: ok ? tree : null, results, skipped, guidance: verify.guidance }
}
