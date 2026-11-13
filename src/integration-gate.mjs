// Shared integration is a transaction, not a mergeable presence update. Every contender
// re-evaluates the whole predicate against the remote tip before it may own a candidate.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID, createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { git as runGit, gitInput as runInput } from './workspace.mjs'
import { remoteEnv, REMOTE_TIMEOUT_MS } from './coord-branch.mjs'
import { stateMergeArgs } from './git-merge.mjs'
import { SkillPackageError } from './errors.mjs'
import { validateAgentAcceptance, summarizeAgentAcceptance } from './agent-acceptance.mjs'
import { improvingGate } from './gate-ledger.mjs'

const execute = promisify(execFile)
const FILE = 'INTEGRATION.json'
const VERSION = 1
const terminal = new Set(['landed', 'withdrawn'])
const fail = (message, details = []) => { throw new SkillPackageError(message, details) }
const empty = () => ({ schemaVersion: VERSION, participants: {}, gate: null, history: [] })
const detail = (error) => String(error?.stderr || error?.message || error).slice(-1500)
const validRef = (name) => typeof name === 'string' && /^[A-Za-z0-9][\w./-]*$/.test(name) && !/\.\.|\/\/|\.lock$|[./]$/.test(name)
const validHead = (head) => /^[0-9a-f]{40,64}$/.test(head ?? '')
const wait = (reason, extra = {}) => ({ ok: false, waiting: true, reason, ...extra })
const participantKey = ({ owner, tag, branch }) => createHash('sha256').update(`${owner}\n${tag}\n${branch}`).digest('hex').slice(0, 24)
const failureProof = (checks) => ({ plan: JSON.stringify(checks.map((entry) => [entry.command, entry.checks?.map((check) => [check.id, check.command])])), evidence: 'checks-or-commands',
  failureSetComplete: checks.every((entry) => !entry.stale && !entry.timedOut && !entry.cancelled && (entry.checks ? entry.failureSetComplete === true : Number.isInteger(entry.exitCode))),
  identities: checks.flatMap((entry) => entry.checks ? entry.checks.filter((check) => !check.ok).map((check) => `check:${check.id}`) : entry.ok ? [] : [`command:${entry.command}`]),
  timedOut: checks.some((entry) => entry.timedOut), stale: checks.some((entry) => entry.stale) })

function parse(text) {
  let value
  try { value = JSON.parse(text) } catch { fail('공유 통합 기록의 JSON을 읽을 수 없습니다.') }
  if (value?.schemaVersion !== VERSION || !value.participants || Array.isArray(value.participants) || typeof value.participants !== 'object' || !Array.isArray(value.history)) fail('공유 통합 기록의 형식을 지원하지 않습니다. 모든 참여 기기의 GUSTA 버전을 함께 맞추세요.')
  return value
}

export async function openIntegration(context, injected = {}) {
  const root = context.root, git = injected.git ?? runGit, input = injected.gitInput ?? runInput
  const now = injected.now ?? (() => new Date().toISOString())
  const uuid = injected.uuid ?? randomUUID
  const branch = `${context.branches.coord}-integration`, ref = `refs/heads/${branch}`
  if (!validRef(branch) || [context.branches.land, context.branches.deploy, context.branches.plan, context.branches.coord].includes(branch)) fail('통합 기록 브랜치 이름이 코드·조정 브랜치와 충돌합니다.', [branch])
  const remote = context.remote ?? null
  const ownerFile = path.join(context.runtime, 'integration-owner.json')
  let identity
  const ownerId = async () => identity ??= (async () => {
    if (injected.ownerId) return injected.ownerId
    await mkdir(path.dirname(ownerFile), { recursive: true })
    try { await writeFile(ownerFile, JSON.stringify({ id: randomUUID() }), { flag: 'wx' }) } catch (error) { if (error.code !== 'EEXIST') throw error }
    const owner = JSON.parse(await readFile(ownerFile, 'utf8')).id
    if (typeof owner !== 'string' || !owner) fail('통합 세션의 clone 소유 기록을 읽을 수 없습니다.')
    return owner
  })()
  const shared = Boolean(remote)
  const tracking = remote ? `refs/remotes/${remote}/${branch}` : ref
  const remoteGit = injected.remote ?? (async (args) => (await execute('git', ['-C', root, ...args], {
    encoding: 'utf8', timeout: REMOTE_TIMEOUT_MS, env: remoteEnv(process.env, (await git(root, ['config', '--get', 'core.sshCommand'], [1]))?.trim()),
  })).stdout)
  const sha = async (name) => (await git(root, ['rev-parse', '--verify', '--quiet', `${name}^{commit}`], [1, 128]))?.trim() || null
  const ancestor = async (old, next) => (await git(root, ['merge-base', '--is-ancestor', old, next], [1])) !== null
  const snapshot = async (commit) => {
    if (!commit) return empty()
    const files = (await git(root, ['ls-tree', '--full-tree', '--name-only', '-z', commit])).split('\0').filter(Boolean)
    if (files.length !== 1 || files[0] !== FILE) fail('통합 기록 브랜치가 다른 용도로 사용 중입니다. 덮어쓰지 않습니다.', [branch])
    return parse(await git(root, ['show', `${commit}:${FILE}`]))
  }
  const fetch = async () => {
    if (!shared) return sha(ref)
    if (!context.branches.coordPush) throw new SkillPackageError('공유 통합 상태를 발행하지 않는 설정에서는 원격 전체 준비를 증명할 수 없습니다.')
    const listed = await remoteGit(['ls-remote', '--heads', remote, ref])
    if (!listed.trim()) return null
    await remoteGit(['fetch', '--quiet', '--no-tags', remote, `+${ref}:${tracking}`])
    return sha(tracking)
  }
  async function read({ fetch: fresh = true } = {}) {
    try {
      const local = await sha(ref)
      if (local) await snapshot(local)
      const commit = fresh ? await fetch() : await sha(tracking)
      return { ok: true, commit, state: await snapshot(commit), scope: shared ? 'remote' : 'clone', fresh: !shared || fresh, branch }
    } catch (error) { return wait('coordination-unknown', { error: detail(error), scope: shared ? 'remote' : 'clone', branch }) }
  }
  async function commitState(state, parent) {
    const blob = (await input(root, ['hash-object', '-w', '--stdin'], `${JSON.stringify(state, null, 2)}\n`)).toString().trim()
    const tree = (await input(root, ['mktree'], `100644 blob ${blob}\t${FILE}\n`)).toString().trim()
    return (await git(root, ['-c', 'commit.gpgsign=false', 'commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', 'gusta: integration transaction'])).trim()
  }
  async function transaction(change, { attempts = 5, publication = null } = {}) {
    if ((await git(root, ['worktree', 'list', '--porcelain'])).split('\n').includes(`branch ${ref}`)) return wait('integration-branch-checked-out')
    for (let attempt = 0; attempt < attempts; attempt++) {
      const current = await read()
      if (!current.ok) return current
      const state = structuredClone(current.state)
      const value = await change(state, { now: now(), commit: current.commit })
      if (value?.ok === false) return { ...value, scope: current.scope }
      if (JSON.stringify(state) === JSON.stringify(current.state)) return { ok: true, state, value, commit: current.commit, scope: current.scope }
      const commit = await commitState(state, current.commit)
      try {
        if (shared) {
          const args = ['push', '--quiet', '--atomic', `--force-with-lease=${ref}:${current.commit ?? ''}`]
          if (publication) args.push(`--force-with-lease=refs/heads/${publication.land}:${publication.base}`)
          args.push(remote, `${commit}:${ref}`)
          if (publication) args.push(`${publication.candidate}:refs/heads/${publication.land}`)
          await remoteGit(args)
          await git(root, ['update-ref', tracking, commit])
        } else await git(root, ['update-ref', ref, commit, current.commit ?? '0'.repeat(commit.length)])
        return { ok: true, state, value, commit, scope: current.scope }
      } catch (error) {
        if (!/rejected|non-fast-forward|fetch first|stale info|cannot lock ref|reference already exists/i.test(detail(error))) return wait('coordination-unknown', { error: detail(error), scope: current.scope })
        if (publication) {
          const landed = await remoteLand(publication.land).catch(() => null)
          if (landed !== publication.base) return wait('land-moved', { expected: publication.base, actual: landed, candidate: publication.candidate, automaticRecheck: false })
        }
        // A lost predicate is never merged into the winner's record.
      }
    }
    return wait('coordination-conflict', { automaticRecheck: false })
  }
  const remoteLand = async (land) => {
    if (!shared) return sha(`refs/heads/${land}`)
    return (await remoteGit(['ls-remote', '--heads', remote, `refs/heads/${land}`])).trim().split(/\s/)[0] || null
  }
  const own = (state, token) => {
    if (!state.gate || state.gate.token !== token) return wait('integration-owner-changed', { automaticRecheck: false })
    return state.gate
  }
  async function register({ tag, host, branch: sessionBranch = context.branch, head, agentChecks, verificationCommands }) {
    if (!tag || !validRef(sessionBranch)) return wait('session-branch-required')
    head ??= await sha('HEAD')
    if (!validHead(head)) return wait('session-head-required')
    if (verificationCommands !== undefined && (!Array.isArray(verificationCommands) || verificationCommands.some((command) => typeof command !== 'string' || !command.trim()))) return wait('invalid-verification-commands')
    const owner = await ownerId(), id = participantKey({ owner, tag, branch: sessionBranch })
    const result = await transaction((state, at) => {
      const previous = state.participants[id]
      if (previous?.status === 'landed' && previous.head === head) return { id, alreadyLanded: true, landed: previous.landed }
      // A frozen participant cannot quietly replace the input under an existing gate.
      if (state.gate?.cohort.some((entry) => entry.id === id) && previous?.head !== head) return wait('candidate-frozen', { token: state.gate.token })
      if (previous && previous.owner !== owner) return wait('participant-owner-changed')
      state.participants[id] = { ...previous, id, owner, tag, host: host ?? previous?.host ?? os.hostname().replace(/\.local$/, '').replace(/[|\s]/g, '-'), branch: sessionBranch, head, land: context.branches.land ?? context.branches.landTarget ?? null,
        status: previous?.status === 'ready' && previous.head === head ? 'ready' : 'working', at: at.now, agentChecks: agentChecks === undefined ? previous?.agentChecks ?? [] : validateAgentAcceptance(agentChecks),
        verificationCommands: verificationCommands ?? previous?.verificationCommands ?? [] }
      return { id }
    })
    return { ...result, participant: id }
  }
  async function ready(options) {
    const recorded = await register(options)
    if (!recorded.ok) return recorded
    if (recorded.value.alreadyLanded) return recorded
    const id = recorded.value.id
    const unitAcceptance = summarizeAgentAcceptance(recorded.state.participants[id].agentChecks ?? [], { stage: 'unit' })
    if (!unitAcceptance.verified) return wait('waiting-unit-agent', { checks: recorded.state.participants[id].agentChecks, candidate: recorded.state.participants[id].head, acceptance: unitAcceptance,
      nextAction: 'A capable host must complete required unit acceptance in this worktree, then submit ready --file <checks JSON>. Integration-stage not-run handoff remains allowed.' })
    // Publishing a session branch follows the existing code push setting. Local-only work can
    // be ready too, but a remote owner must actually possess its object before claiming it.
    if (shared && context.branches.push) {
      const participant = recorded.state.participants[id]
      try { await remoteGit(['push', '--quiet', remote, `${participant.head}:refs/heads/${participant.branch}`]) }
      catch (error) { return wait('session-head-unpublished', { error: detail(error), id }) }
    }
    return transaction((state, at) => {
      const entry = state.participants[id]
      if (!entry || entry.head !== recorded.state.participants[id].head) return wait('session-head-moved')
      entry.status = 'ready'; entry.at = at.now
      return { id }
    })
  }
  async function close({ tag, empty: noWork = false, reason = 'session-stopped' }) {
    const id = participantKey({ owner: await ownerId(), tag, branch: context.branch })
    return transaction((state, at) => {
      const entry = state.participants[id]
      if (!entry || state.gate?.cohort.some((participant) => participant.id === id) || ['ready', 'landed'].includes(entry.status)) return { id, unchanged: true }
      entry.status = noWork ? 'withdrawn' : 'paused'; entry.reason = reason; entry.at = at.now
      return { id, status: entry.status }
    })
  }
  async function claim({ tag, active = [], deadline = null, maxAttempts = 3 } = {}) {
    if (!Number.isInteger(Number(maxAttempts)) || Number(maxAttempts) < 2 || Number(maxAttempts) > 5) return wait('invalid-integration-attempt-limit')
    const seen = await read()
    if (!seen.ok) return seen
    const pending = Object.values(seen.state.participants).filter((entry) => !terminal.has(entry.status))
    // Fetch each explicitly ready head before taking a lease. An unpublished head is not a
    // reason to hold ownership while somebody else has all candidate objects locally.
    for (const entry of pending.filter((entry) => entry.status === 'ready')) {
      if (!await sha(entry.head) && shared) {
        try { await remoteGit(['fetch', '--quiet', '--no-tags', remote, `refs/heads/${entry.branch}`]) } catch {}
      }
      if (!await sha(entry.head)) return wait('session-head-unavailable', { participant: entry.id, branch: entry.branch, head: entry.head })
    }
    const land = context.branches.land ?? context.branches.landTarget
    if (!land) return wait('land-unset')
    let base
    try {
      base = await remoteLand(land)
      if (base && !await sha(base) && shared) await remoteGit(['fetch', '--quiet', '--no-tags', remote, `refs/heads/${land}`])
    } catch (error) { return wait('coordination-unknown', { error: detail(error) }) }
    if (!base || !await sha(base)) return wait('land-base-unavailable', { land })
    return transaction(async (state, at) => {
      if (state.gate) return wait('integration-owned', { gate: state.gate, automaticRecheck: false })
      const cohort = Object.values(state.participants).filter((entry) => !terminal.has(entry.status) && entry.land === land)
      const unregistered = []
      for (const row of active) {
        const matches = cohort.filter((entry) => entry.id === row.session && entry.tag === row.tag && entry.branch === row.branch && entry.host === row.host)
        const commit = typeof row.commit === 'string' && row.commit !== '-' ? await sha(row.commit) : null
        if (matches.length !== 1 || row.doing && row.doing !== '-' || !commit || !await ancestor(commit, matches[0].head)) unregistered.push(row)
      }
      if (unregistered.length) return wait('unregistered-sessions', { participants: unregistered.map(({ tag, branch }) => ({ tag, branch })) })
      const working = cohort.filter((entry) => entry.status !== 'ready')
      if (working.length) return wait('sessions-working', { participants: working.map(({ id, tag, branch, at }) => ({ id, tag, branch, at })) })
      if (!cohort.length) return wait('no-ready-sessions')
      if (cohort.some((entry) => !pending.some((known) => known.id === entry.id && known.head === entry.head))) return wait('participants-changed')
      if (await remoteLand(land) !== base) return wait('land-base-moved', { automaticRecheck: false })
      state.gate = { token: uuid(), owner: tag, executor: { host: os.hostname(), pid: process.pid }, phase: 'preparing', land, base, cohort: cohort.map(({ id, tag, branch, head, agentChecks, verificationCommands }) => ({ id, tag, branch, head, agentChecks, verificationCommands })), at: at.now, deadline, maxAttempts: Number(maxAttempts), attempts: 1, candidate: null, checks: [], agentChecks: [], rounds: [] }
      return { gate: state.gate }
    })
  }
  const mutateGate = (token, change) => transaction((state, at) => {
    const gate = own(state, token)
    if (gate.ok === false) return gate
    return change(gate, state, at)
  })
  async function candidate(token) {
    const current = await read()
    if (!current.ok) return current
    const gate = own(current.state, token)
    if (gate.ok === false) return gate
    if (gate.candidate) return { ok: true, gate, root: gate.path }
    const common = path.resolve(root, (await git(root, ['rev-parse', '--git-common-dir'])).trim())
    const directory = path.join(common, 'gusta', 'integration-worktrees', token)
    await mkdir(path.dirname(directory), { recursive: true })
    const candidateBranch = `integration/${token}`
    await git(root, ['worktree', 'add', '--quiet', '-b', candidateBranch, directory, gate.base])
    try {
      for (const entry of gate.cohort) if (!await ancestor(entry.head, (await git(directory, ['rev-parse', 'HEAD'])).trim())) await git(directory, [...await stateMergeArgs(directory, context.runtime), 'merge', '--no-edit', '--quiet', entry.head])
      const prepared = await injected.prepareCandidate?.(directory, gate)
      const head = (await git(directory, ['rev-parse', 'HEAD'])).trim()
      const saved = await mutateGate(token, (entry) => { if (entry.phase !== 'preparing') return wait('integration-phase-changed'); entry.candidate = head; entry.path = directory; entry.branch = candidateBranch; entry.phase = 'checking'; if (prepared) entry.version = prepared; return { gate: entry } })
      if (saved.ok && shared && context.branches.push) await remoteGit(['push', '--quiet', remote, `${head}:refs/heads/${candidateBranch}`])
      return saved.ok ? { ...saved, gate: saved.value.gate, root: directory } : saved
    } catch (error) {
      await git(directory, ['merge', '--abort'], [1, 128]).catch(() => {})
      await mutateGate(token, (entry) => { entry.phase = 'conflict'; entry.error = detail(error); return { gate: entry } })
      return wait('integration-conflict', { token, root: directory, error: detail(error), automaticRecheck: false })
    }
  }
  async function checked(token, receipt, agentChecks = []) {
    return mutateGate(token, (gate) => {
      if (gate.phase !== 'checking') return wait('integration-already-checked', { gate, automaticRecheck: false })
      gate.checks = receipt
      if (gate.rounds.length && receipt.some((entry) => !entry.ok)) gate.retryAllowed = improvingGate(failureProof(gate.rounds.at(-1).checks), failureProof(receipt))
      gate.rounds = [...gate.rounds, { candidate: gate.candidate, checks: receipt, at: now() }]
      gate.agentChecks = validateAgentAcceptance(agentChecks)
      gate.phase = receipt.every((entry) => entry.ok) ? agentChecks.some((entry) => entry.required !== false && (entry.status !== 'pass' || entry.candidate !== gate.candidate)) ? 'waiting-agent' : 'verified' : 'failed'
      return { gate }
    })
  }
  async function repair({ token, candidate: next, root: checkout = root }) {
    if (!validHead(next) || (await git(checkout, ['rev-parse', 'HEAD'])).trim() !== next || (await git(checkout, ['status', '--porcelain', '--untracked-files=all'])).trim()) return wait('repair-candidate-not-clean')
    const common = (await git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim()
    if ((await git(checkout, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim() !== common) return wait('repair-workspace-mismatch')
    return mutateGate(token, async (gate) => {
      if (gate.phase !== 'failed') return wait('repair-requires-failed-receipt', { gate })
      if (gate.attempts >= (gate.maxAttempts ?? 3)) return wait('integration-attempt-limit', { attempts: gate.attempts, gate })
      if (gate.retryAllowed === false) return wait('failure-set-not-improving', { gate })
      if (gate.deadline && Date.parse(gate.deadline) <= Date.parse(now())) return wait('integration-deadline', { gate })
      if (next === gate.candidate || !await ancestor(gate.candidate, next)) return wait('repair-needs-descendant-change', { gate })
      gate.candidate = next; gate.path = checkout; gate.branch = (await git(checkout, ['symbolic-ref', '--short', 'HEAD'])).trim()
      gate.phase = 'checking'; gate.attempts++; gate.executor = { host: os.hostname(), pid: process.pid }
      return { gate }
    })
  }
  async function accept({ token, candidate: expected, checks }) {
    checks = validateAgentAcceptance(checks)
    if (checks.some((entry) => entry.status !== 'not-run' && entry.candidate !== expected || entry.candidate !== null && entry.candidate !== expected)) return wait('acceptance-candidate-mismatch')
    return mutateGate(token, (gate) => {
      if (!['waiting-agent', 'verified'].includes(gate.phase) || gate.candidate !== expected) return wait('acceptance-candidate-mismatch')
      const values = new Map(checks.map((entry) => [entry.id, entry]))
      for (const check of checks) {
        const original = gate.agentChecks.find((entry) => entry.id === check.id)
        if (!original || ['scenario', 'steps', 'expected', 'replaces', 'stage', 'required'].some((field) => JSON.stringify(original[field]) !== JSON.stringify(check[field]))) return wait('acceptance-contract-mismatch')
      }
      gate.agentChecks = gate.agentChecks.map((entry) => values.has(entry.id) ? { ...entry, ...values.get(entry.id) } : entry)
      if (gate.agentChecks.every((entry) => entry.required === false || (entry.status === 'pass' && entry.candidate === expected))) gate.phase = 'verified'
      return { gate }
    })
  }
  async function complete({ token, candidate: expected }, { localLand } = {}) {
    const current = await read()
    if (!current.ok) return current
    const gate = own(current.state, token)
    if (gate.ok === false) return gate
    if (gate.phase !== 'verified' || gate.candidate !== expected) return wait(gate.phase === 'waiting-agent' ? 'waiting-agent' : 'candidate-not-verified', { gate })
    if (gate.executor?.host === os.hostname() && ((await git(gate.path, ['rev-parse', 'HEAD'])).trim() !== expected || (await git(gate.path, ['status', '--porcelain', '--untracked-files=all'])).trim())) return wait('candidate-changed', { gate, automaticRecheck: false })
    const actual = await remoteLand(gate.land).catch(() => null)
    if (actual !== gate.base) return wait('land-moved', { expected: gate.base, actual, candidate: expected, automaticRecheck: false })
    if (!await ancestor(gate.base, expected)) return wait('candidate-not-fast-forward')
    if (!shared || !context.branches.push || context.branches.via === 'pr') {
      if (!localLand) return wait(context.branches.via === 'pr' ? 'pr-required' : 'local-land-required', { gate })
      const landed = await localLand(gate)
      if (landed?.ok === false) return landed
    }
    return transaction((state) => {
      const owned = own(state, token)
      if (owned.ok === false) return owned
      if (owned.phase !== 'verified' || owned.candidate !== expected) return wait('candidate-not-verified')
      for (const entry of owned.cohort) if (state.participants[entry.id]?.head === entry.head) { state.participants[entry.id].status = 'landed'; state.participants[entry.id].landed = expected }
      state.history = [{ ...owned, phase: 'landed', at: now() }, ...state.history].slice(0, 20)
      state.gate = null
      return { gate: { ...owned, phase: 'landed' }, landed: expected }
    }, { publication: shared && context.branches.push && context.branches.via !== 'pr' ? { land: gate.land, base: gate.base, candidate: expected } : null })
  }
  return { branch, ref, scope: shared ? 'remote' : 'clone', read, transaction, register, ready, close, claim, candidate, checked, repair, accept, complete, remoteLand }
}

export async function assertIntegrationCandidate(context, options = {}, injected = {}) {
  const store = await openIntegration(context, injected)
  const view = await store.read()
  const gate = view.state?.gate
  const head = (await (injected.git ?? runGit)(context.root, ['rev-parse', 'HEAD'])).trim()
  if (!view.ok || !gate || gate.token !== options.integrationToken || gate.phase !== 'checking' || gate.candidate !== head || gate.executor?.host !== os.hostname() || gate.executor?.pid !== process.pid) fail('전체 검수는 모든 참여 세션이 준비된 고정 통합 후보의 소유자만 실행합니다. vibe integration finish로 통합을 요청하세요.', [view.reason ?? gate?.phase ?? 'integration-required'])
  return { ok: true, token: gate.token, candidate: head, scope: view.scope }
}
