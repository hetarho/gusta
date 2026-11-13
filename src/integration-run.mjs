import { readFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { git } from './workspace.mjs'
import { vibeSession } from './vibe-session.mjs'
import { coordView } from './vibe-coord.mjs'
import { openIntegration } from './integration-gate.mjs'
import { readVerification } from './vibe-brief.mjs'
import { runVibeCheck } from './vibe-check.mjs'
import { bumpGate, versionBump } from './version-bump.mjs'
import { validateAgentAcceptance, validateAcceptanceAllocation, summarizeAgentAcceptance } from './agent-acceptance.mjs'
import { SkillPackageError } from './errors.mjs'
import { lintSpec } from './spec-lint.mjs'
import { designOf } from './interactive-state.mjs'

const execute = promisify(execFile)
const pending = (reason, gate, extra = {}) => ({ schemaVersion: 1, ok: false, waiting: true, reason, gate, automaticRecheck: false, ...extra })

async function prepareVersion(root, gate) {
  const context = await vibeSession({ targetRoot: root })
  const skipped = bumpGate(context.settings.values, context.branches, 'push')
  if (skipped) return { skipped }
  const bump = await versionBump(root, { base: gate.base, head: (await git(root, ['rev-parse', 'HEAD'])).trim() })
  if (bump.commit) await git(root, ['merge', '--ff-only', '--quiet', bump.commit])
  return bump.version
}

async function localLand(context, gate) {
  const ref = `refs/heads/${gate.land}`
  if ((await git(context.root, ['rev-parse', ref])).trim() !== gate.base) return pending('land-moved', gate)
  const holder = context.workspace.git.worktrees.find((entry) => entry.branch === gate.land)
  if (holder) {
    if ((await git(holder.path, ['status', '--porcelain', '--untracked-files=all'])).trim()) return pending('land-checkout-dirty', gate)
    await git(holder.path, ['merge', '--ff-only', '--quiet', gate.candidate])
  } else await git(context.root, ['update-ref', ref, gate.candidate, gate.base])
  return { ok: true, landed: gate.candidate, mode: 'local' }
}

export async function finalizeIntegration(options = {}, injected = {}) {
  const context = await vibeSession(options)
  if (await designOf(context.workspace)) throw new SkillPackageError('이 checkout은 디자인 중입니다. 디자인을 마친 뒤 통합하세요.')
  if (!context.branches.land) return { schemaVersion: 1, ok: true, pending: true, reason: 'land-unset', verified: false, landed: null }
  const store = await openIntegration(context, { prepareCandidate: prepareVersion, ...injected.store })
  const status = await store.read()
  if (!status.ok) return { schemaVersion: 1, ...status }
  let gate = status.state.gate, created = false, repaired = false
  if (!gate) {
    const ready = await store.ready({ tag: options.tag, agentChecks: validateAgentAcceptance(options.agentChecks) })
    if (!ready.ok) return { schemaVersion: 1, ...ready }
    const peers = await (injected.view ?? coordView)(context, { tag: options.tag })
    if (peers.error || peers.sync?.error || peers.push?.backoff || context.remote && (peers.push?.unpublished || peers.push?.enabled === false)) return pending('coordination-unknown', null, { coordination: peers })
    const claimed = await store.claim({ tag: options.tag, active: peers.doc?.active ?? peers.active ?? [], deadline: options.deadline ?? new Date(Date.now() + Number(options.timeoutMs ?? 3600000)).toISOString() })
    if (!claimed.ok) return { schemaVersion: 1, ...claimed }
    gate = claimed.value.gate; created = true
  }
  if (gate.owner !== options.tag && gate.token !== options.token) return pending('integration-owned', gate)
  if (options.repair) {
    const changed = await store.repair({ token: gate.token, candidate: (await git(context.root, ['rev-parse', 'HEAD'])).trim(), root: context.root })
    if (!changed.ok) return { schemaVersion: 1, ...changed }
    gate = changed.value.gate; repaired = true
  }
  // A second process cannot infer that a previous checker has exited. In particular it must
  // never replay the full gate merely because its receipt has not arrived yet.
  if (!created && !repaired && ['preparing', 'checking', 'failed', 'conflict'].includes(gate.phase)) return pending(`integration-${gate.phase}`, gate, { nextAction: gate.phase === 'failed' ? 'Repair only failed/affected inputs in the candidate worktree, commit, then vibe integration repair --token <token> --target <candidate worktree>. The same deadline, cohort and three-attempt cap remain.' : 'Inspect the owning process; absence or elapsed time never authorizes replay.' })
  if (created || repaired) {
    const prepared = repaired ? { ok: true, root: context.root, gate } : await store.candidate(gate.token)
    if (!prepared.ok) return { schemaVersion: 1, ...prepared }
    gate = prepared.gate
    try {
    const verification = await readVerification(prepared.root)
    const agentChecks = validateAgentAcceptance(gate.cohort.flatMap((entry) => entry.agentChecks ?? []).filter((entry) => (entry.stage ?? 'integration') === 'integration'))
    validateAcceptanceAllocation(agentChecks, verification.plan?.checks.map((entry) => entry.id) ?? [])
    const results = []
    const lint = await (injected.lint ?? lintSpec)({ targetRoot: prepared.root })
    const close = await (injected.closeIssues ?? (async (root) => (await import('./vibe.mjs')).specCloseIssues(root)))(prepared.root)
    if (lint.errors.length || close.length) results.push({ ok: false, command: 'spec close', errors: [...lint.errors, ...close.map((entry) => `${entry.id}: ${entry.reason ?? entry.st}`)] })
    const commands = verification.plan ? [{ plan: verification.plan.source }] : verification.batch.map((command) => ({ command }))
    if (!commands.length && (!verification.declared || verification.partial)) results.push({ ok: false, command: 'verification policy', error: 'No declared batch coverage or explicit exclusion.' })
    const check = injected.check ?? runVibeCheck
    for (const command of commands) {
      if (results.some((entry) => entry.command === 'spec close')) break
      if (options.signal?.aborted) { results.push({ ok: false, cancelled: true, reason: 'cancelled', ...command }); break }
      try {
        const receipt = await check({ ...options, targetRoot: prepared.root, timeoutMs: Math.min(Number(options.timeoutMs ?? 3600000), gate.deadline ? Math.max(1, Date.parse(gate.deadline) - Date.now()) : Infinity), tag: gate.token.replaceAll('-', '').slice(0, 8), tier: 'batch', integrationToken: gate.token, diffBase: gate.base, gateLedger: 'record', ...(command.plan ? { plan: command.plan } : {}) }, command.command)
        results.push({ command: command.command ?? `verification-plan:${command.plan}`, ...receipt })
      } catch (error) { results.push({ ok: false, command: command.command ?? command.plan, error: error.message }) }
    }
    const actual = (await git(prepared.root, ['rev-parse', 'HEAD'])).trim()
    if (actual !== gate.candidate || (await git(prepared.root, ['status', '--porcelain', '--untracked-files=all'])).trim()) results.push({ ok: false, stale: true, command: 'immutable candidate', error: 'Candidate changed during verification.' })
    const saved = await store.checked(gate.token, results, agentChecks)
    if (!saved.ok) return { schemaVersion: 1, ...saved }
    gate = saved.value.gate
    } catch (error) {
      const failed = await store.checked(gate.token, [{ ok: false, command: 'candidate preflight', error: error.message }], gate.agentChecks ?? [])
      if (!failed.ok) return { schemaVersion: 1, ...failed }
      gate = failed.value.gate
    }
  }
  const acceptance = summarizeAgentAcceptance(gate.agentChecks, { stage: 'integration', candidate: gate.candidate })
  if (gate.phase === 'waiting-agent' || !acceptance.verified) return pending('waiting-agent', gate, { acceptance, nextAction: 'Run the listed acceptance checks with a capable computer-use host, submit exact-candidate observations with vibe integration accept --file <JSON>, then finish. Do not add another automated E2E suite.' })
  if (gate.phase !== 'verified') return pending(`integration-${gate.phase}`, gate)
  if (context.remote && !context.branches.push) return pending('waiting-publication', gate, { verified: true, nextAction: 'The candidate is verified; code publication is disabled. Preserve it and publish only when authorized. Do not rerun full verification.' })
  if (context.branches.via === 'pr') {
    const result = await (injected.pr ?? (async () => {
      await git(context.root, ['push', '--quiet', context.remote, `${gate.candidate}:refs/heads/${gate.branch}`])
      try { return { pr: (await execute('gh', ['pr', 'create', '--base', gate.land, '--head', gate.branch, '--fill'], { cwd: gate.path, encoding: 'utf8', env: { ...process.env, GH_PROMPT_DISABLED: '1' } })).stdout.trim() } }
      catch { return { pr: (await execute('gh', ['pr', 'view', gate.branch, '--json', 'url', '--jq', '.url'], { cwd: gate.path, encoding: 'utf8' })).stdout.trim() } }
    }))()
    return pending('waiting-pr', gate, { verified: true, ...result })
  }
  const completed = await store.complete({ token: gate.token, candidate: gate.candidate }, { localLand: (entry) => (injected.localLand ?? localLand)(context, entry) })
  if (!completed.ok) return { schemaVersion: 1, ...completed }
  return { schemaVersion: 1, ok: true, verified: true, gate: completed.value.gate, landed: gate.candidate, pushed: context.remote ? gate.candidate : null, target: gate.land, scope: completed.scope, acceptance }
}

export async function vibeIntegration(options = {}, injected = {}) {
  const context = await vibeSession(options), store = await openIntegration(context, injected.store)
  if (options.step === 'status') return { schemaVersion: 1, ...await store.read() }
  if (options.step === 'ready') return { schemaVersion: 1, ...await store.ready({ tag: options.tag, agentChecks: validateAgentAcceptance(options.agentChecks) }) }
  if (options.step === 'accept') {
    const receipt = JSON.parse(await readFile(path.resolve(options.file ?? ''), 'utf8'))
    const checks = validateAgentAcceptance(receipt.checks)
    if (!receipt.token || !receipt.candidate || checks.some((entry) => entry.candidate !== receipt.candidate)) throw new SkillPackageError('agent 인수검증에는 token·정확한 candidate와 일치하는 관측 증거가 필요합니다.')
    const current = await store.read(), gate = current.state?.gate
    if (!current.ok || !gate || gate.token !== receipt.token || gate.candidate !== receipt.candidate) throw new SkillPackageError('인수검증 대상이 현재 고정 통합 후보와 다릅니다.')
    const verification = await readVerification(gate.path && gate.executor?.host === os.hostname() ? gate.path : context.root)
    validateAcceptanceAllocation(checks, verification.plan?.checks.map((entry) => entry.id) ?? [])
    return { schemaVersion: 1, ...await store.accept({ ...receipt, checks }) }
  }
  if (options.step === 'finish' || options.step === 'repair') return finalizeIntegration({ ...options, ...(options.step === 'repair' ? { repair: true } : {}) }, injected)
  throw new SkillPackageError('vibe integration status|ready|finish --tag <tag>, repair --token <token>, 또는 accept --file <JSON>')
}
