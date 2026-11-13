// The coordination branch: an orphan branch that holds SESSIONS.md alone and shares no history
// with the code. Nothing checks it out, merges it or rebases onto it — this module reads and
// writes it with Git plumbing, so HEAD, the index and the working tree are never touched.
// A branch that already has this name and holds anything else is left exactly as it is.
// Worktrees of one clone share the ref: a write is visible to all of them at once, and the
// compare-and-swap update-ref makes a local claim atomic. Other machines meet through the remote.
import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import { git as runGit, gitInput as runGitInput } from './workspace.mjs'
import { SkillPackageError } from './errors.mjs'
import { readJSON, atomicJSON } from './loop-control.mjs'
import { SESSIONS_FILE, EMPTY_SESSIONS, isoMinute, mergeSessions } from './coord-doc.mjs'

const execute = promisify(execFile)
export const COORD_BRANCH = 'gusta'
export const REMOTE_TIMEOUT_MS = 30000
// After a publish or sync fails for want of credentials or a network, the remote is left alone this
// long: an expired login would otherwise cost every event a full timeout. Credential prompts stay
// as the user set them up (an IDE answers askpass quietly); only a failure starts the wait.
export const REMOTE_BACKOFF_MINUTES = 10
const BACKOFF_REASONS = ['auth', 'timeout', 'network']
// The clone's shared runtime record (src/vibe-coord.mjs keeps the branch name and last publish there).
export const RECORD_FILE = path.join('gusta', 'v1', 'coord.json')
const fail = (message, details = []) => { throw new SkillPackageError(message, details) }
const detail = (error) => `${error?.stderr || error?.message || error}`.trim()

// Environment for Git calls that reach a remote. Nobody answers a credential prompt in an
// unattended session, so every way of asking is closed and the call fails instead of waiting.
// The user's ssh command (GIT_SSH_COMMAND, else core.sshCommand) is kept and only made
// non-interactive; a custom GIT_SSH program is left alone.
export function remoteEnv(env = process.env, sshCommand = null) {
  const ssh = env.GIT_SSH_COMMAND || sshCommand || (env.GIT_SSH ? null : 'ssh')
  return { ...env, LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', SSH_ASKPASS_REQUIRE: 'never',
    ...(ssh ? { GIT_SSH_COMMAND: `${ssh} -o BatchMode=yes` } : {}) }
}

// Git against a remote: no prompt, and a timeout that ends a stalled connection.
function remoteRunner({ git, timeout = REMOTE_TIMEOUT_MS, env = process.env }) {
  const ssh = new Map()
  return async (cwd, args) => {
    if (!ssh.has(cwd)) ssh.set(cwd, (await git(cwd, ['config', '--get', 'core.sshCommand'], [1]))?.trim() || null)
    return (await execute('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout, env: remoteEnv(env, ssh.get(cwd)) })).stdout
  }
}

// A ref that cannot be created because another ref's name holds its path (here or on the remote).
const REF_CONFLICT = /exists; cannot create|is in the way|directory\/file conflict/i

// Why a remote call failed, for a caller that reports instead of throwing.
function failure(error, fallback) {
  const text = detail(error)
  const reason = REF_CONFLICT.test(text) ? 'ref-conflict'
    : error?.killed || /timed out|ETIMEDOUT/i.test(text) ? 'timeout'
    : /authentication failed|permission denied|could not read (?:username|password)|terminal prompts disabled|access denied|publickey|\b40[13]\b/i.test(text) ? 'auth'
    : /could not resolve|connection refused|unable to (?:access|connect)|network is unreachable|connection reset|could not read from remote/i.test(text) ? 'network'
    : fallback
  return { reason, error: text.slice(-1000) }
}

// commit-tree refusing to name an author or committer.
const NO_IDENTITY = /tell me who you are|empty ident|auto-detect(?:ion)?|no (?:name|email) was given/i
const identityMessage = (branch) => `Git 사용자 정보(user.name·user.email)가 없어 조정 브랜치 ${branch}에 기록하지 못했습니다. git config user.name·user.email을 설정한 뒤 다시 실행하세요.`

// A push the remote turned down because it moved first (or two pushes met on its ref lock):
// merging and pushing again settles it. A hook or branch-protection refusal does not retry.
const PUSH_RACE = /\[rejected\]|non-fast-forward|fetch first|stale info|cannot lock ref|failed to (?:lock|update ref)|reference already exists/i

// context: cwd (anywhere in the clone), branch (default `gusta`), push (default true; false
// means the remote is neither fetched nor pushed), remote (a name; default origin, else the
// first remote), timeout (ms, each remote call), record (the JSON file holding the remote backoff;
// default the clone's shared runtime, null = no backoff). deps: git, gitInput (src/workspace.mjs
// signatures), remote(cwd, args) for calls that reach the remote, now() → Date, sleep(ms).
export async function openCoord(context = {}, deps = {}) {
  const { cwd = process.cwd(), branch = COORD_BRANCH, push = true } = context
  if (!/^[A-Za-z0-9][\w./-]*$/.test(branch) || /\.\.|\/\/|\.lock$|[./]$/.test(branch)) fail(`조정 브랜치 이름이 올바르지 않습니다: ${branch}`)
  const git = deps.git ?? runGit
  const gitInput = deps.gitInput ?? runGitInput
  const remoteGit = deps.remote ?? remoteRunner({ git, timeout: context.timeout })
  const now = deps.now ?? (() => new Date())
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const ref = `refs/heads/${branch}`
  let remote = context.remote
  if (remote === undefined) {
    const listed = await git(cwd, ['remote']).catch((error) => fail('Git checkout이 필요합니다.', [detail(error)]))
    const names = listed.split('\n').map((line) => line.trim()).filter(Boolean)
    remote = names.includes('origin') ? 'origin' : names[0] ?? null
  }
  const tracking = remote ? `refs/remotes/${remote}/${branch}` : null
  let recordFile = context.record
  const recordPath = async () => recordFile !== undefined ? recordFile
    : (recordFile = path.join(path.resolve(cwd, (await git(cwd, ['rev-parse', '--git-common-dir'])).trim()), RECORD_FILE))

  // The remote backoff shared by every worktree of the clone: { reason, at, until, error } while
  // `until` is ahead, else null.
  async function backoff() {
    const file = await recordPath()
    const entry = file && (await readJSON(file).catch(() => null))?.backoff
    return entry && Date.parse(entry.until) > now().getTime() ? entry : null
  }
  const shown = ({ reason, at, until }) => ({ reason, at, until })
  // A failure that waiting may cure starts the backoff; reaching the remote ends it.
  async function settle(failed) {
    const file = await recordPath()
    if (!file || (failed && !BACKOFF_REASONS.includes(failed.reason))) return
    const current = (await readJSON(file).catch(() => null)) ?? {}
    if (!failed && !current.backoff) return
    const { backoff: _, ...rest } = current
    const at = now()
    await atomicJSON(file, failed ? { schemaVersion: 1, ...rest, backoff: { reason: failed.reason, at: isoMinute(at), until: isoMinute(new Date(at.getTime() + REMOTE_BACKOFF_MINUTES * 60000)), error: failed.error.slice(-300) } } : rest).catch(() => {})
  }

  const commitOf = async (name) => (await git(cwd, ['rev-parse', '--verify', '--quiet', `${name}^{commit}`], [1]))?.trim() || null
  const ancestor = async (older, newer) => (await git(cwd, ['merge-base', '--is-ancestor', older, newer], [1])) !== null
  const textAt = async (commit) => (await git(cwd, ['show', `${commit}:${SESSIONS_FILE}`], [128])) ?? ''

  // A branch of this name whose tip holds anything but SESSIONS.md is not a coordination branch:
  // it is somebody's code that happens to be called the same. Why it cannot be used, or null —
  // for the branch here and for the remote's as last fetched. Nothing is read from such a
  // branch, written on it or pushed over it; the owner picks another name.
  const verified = new Set()
  async function foreign() {
    for (const name of [ref, tracking]) {
      const commit = name && await commitOf(name)
      if (!commit || verified.has(commit)) continue
      const files = (await git(cwd, ['ls-tree', '--full-tree', '--name-only', '-z', commit])).split('\0').filter(Boolean)
      if (files.length !== 1 || files[0] !== SESSIONS_FILE) {
        return { message: `${branch} 브랜치가 이미 다른 용도로 있습니다(${SESSIONS_FILE} 하나만 담은 조정 브랜치가 아닙니다). 덮어쓰지 않습니다 — spec/SETTINGS.md coord를 다른 이름으로 바꾸세요.`,
          details: [`${name} ${commit.slice(0, 12)}: ${files.slice(0, 5).join(', ') || '(empty tree)'}${files.length > 5 ? ', …' : ''}`] }
      }
      verified.add(commit)
    }
    return null
  }
  const refusal = (found) => ({ reason: 'foreign-branch', error: [found.message, ...found.details].join(' ') })

  // local is the branch here. Before this clone has one, the last fetched remote branch is the
  // starting point: the first write continues the shared history instead of a second orphan.
  async function state() {
    const found = await foreign()
    if (found) fail(found.message, found.details)
    const local = await commitOf(ref)
    const commit = local ?? (tracking ? await commitOf(tracking) : null)
    return { local, commit, text: (commit && await textAt(commit)) || EMPTY_SESSIONS }
  }

  // A ref Git cannot create because another ref's name holds its path: `gusta` beside an existing
  // `gusta/feature`, or `team/sessions` beside `team`. Retrying never helps; the name must change.
  async function conflictOf(name) {
    if (!name) return null
    const below = (await git(cwd, ['for-each-ref', '--count=1', '--format=%(refname)', `${name}/`])).trim()
    if (below) return below
    const parts = name.split('/')
    for (let length = 3; length < parts.length; length += 1) {
      const above = parts.slice(0, length).join('/')
      if (await git(cwd, ['show-ref', '--verify', '--quiet', above], [1]) !== null) return above
    }
    return null
  }
  const conflictMessage = (name, other) => [`조정 브랜치 ${branch}를 만들 수 없습니다: ${name}와 ${other}의 ref 이름이 충돌합니다(같은 경로에 브랜치와 하위 브랜치를 함께 둘 수 없습니다). spec/SETTINGS.md coord를 다른 이름으로 바꾸세요(/gusta-preference).`, [`${name} ↔ ${other}`]]
  // The branch here, and (when it is fetched) the remote's tracking ref.
  async function conflicts(names = [ref, push ? tracking : null]) {
    for (const name of names) {
      if (name === ref && await commitOf(ref)) continue
      const other = await conflictOf(name)
      if (other) return conflictMessage(name, other)
    }
    return null
  }
  async function checkedOut() {
    let where = null
    for (const line of (await git(cwd, ['worktree', 'list', '--porcelain'])).split('\n')) {
      if (line.startsWith('worktree ')) where = line.slice('worktree '.length)
      else if (line === `branch ${ref}`) return [`조정 브랜치 ${branch}가 checkout돼 있어 기록할 수 없습니다. 그 checkout을 다른 브랜치로 옮기세요(코드 브랜치로 쓰지 않는 브랜치입니다).`, [where]]
    }
    return null
  }
  // update-ref under a checkout would leave its index and files behind the branch, and a ref whose
  // name collides with another is refused every time.
  async function assertFree() {
    const found = await conflicts([ref]) ?? await checkedOut()
    if (found) fail(...found)
  }

  // Whether a write would succeed here, without writing: { ok } or { ok: false, reason, error }.
  async function writable() {
    const found = await foreign().catch(() => null)
    if (found) return { ok: false, reason: 'foreign-branch', error: [found.message, ...found.details].join(' ') }
    for (const [reason, check] of [['ref-conflict', conflicts], ['checked-out', checkedOut]]) {
      const problem = await check()
      if (problem) return { ok: false, reason, error: [problem[0], ...problem[1]].join(' ') }
    }
    for (const name of ['GIT_AUTHOR_IDENT', 'GIT_COMMITTER_IDENT']) {
      try { await git(cwd, ['var', name]) } catch (error) { return { ok: false, reason: 'no-identity', error: `${identityMessage(branch)} ${detail(error).slice(-300)}` } }
    }
    return { ok: true }
  }

  // One file needs no index and no worktree: blob → tree → commit.
  async function commitText(text, parents, message) {
    const blob = (await gitInput(cwd, ['hash-object', '-w', '--stdin'], text)).toString().trim()
    const tree = (await gitInput(cwd, ['mktree'], `100644 blob ${blob}\t${SESSIONS_FILE}\n`)).toString().trim()
    try {
      return (await git(cwd, ['-c', 'commit.gpgsign=false', 'commit-tree', tree, ...parents.flatMap((parent) => ['-p', parent]), '-m', message])).trim()
    } catch (error) {
      // A repository nobody has committed in yet may have no identity: say so instead of Git's hint.
      if (NO_IDENTITY.test(detail(error))) fail(identityMessage(branch), [detail(error).slice(-500)])
      throw error
    }
  }

  // Compare-and-swap: the branch moves only if it is still at `old` (all zeros: still absent).
  // false means someone else moved it first, or held its lock — the caller reads again.
  let refused = null
  async function moveRef(commit, old, attempt) {
    try {
      await git(cwd, ['update-ref', ref, commit, old ?? '0'.repeat(commit.length)])
      return true
    } catch (error) {
      refused = error
      await sleep(10 * attempt + Math.floor(Math.random() * 30))
      return false
    }
  }

  async function read() {
    const { commit, text } = await state()
    return { commit, text }
  }

  // Apply mutate(text, { now, commit }) → text | { text, ... } and commit the result. When the
  // branch moved meanwhile nothing is merged: mutate runs again on the new text, so it decides
  // again (a claim someone else just took throws here, and that goes to the caller). The same
  // text back means nothing to commit.
  async function update(mutate, { message = 'gusta: update sessions', attempts = 5 } = {}) {
    let free = false
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const current = await state()
      const value = await mutate(current.text, { now: isoMinute(now()), commit: current.commit })
      const text = typeof value === 'string' ? value : value?.text
      if (typeof text !== 'string') fail('mutate는 SESSIONS.md 본문(문자열 또는 { text })을 돌려줘야 합니다.')
      if (text === current.text) return { commit: current.commit, text, changed: false, attempts: attempt, value }
      if (!free) { await assertFree(); free = true }
      const commit = await commitText(text, current.commit ? [current.commit] : [], typeof message === 'function' ? message(value) : message)
      if (await moveRef(commit, current.local, attempt)) return { commit, text, changed: true, attempts: attempt, value }
    }
    return fail(`조정 브랜치 ${branch}를 ${attempts}회 시도에도 갱신하지 못했습니다. 다시 실행하세요.`, [detail(refused)])
  }

  // true: fetched into the tracking ref. false: the remote has no such branch.
  async function fetchRemote() {
    try {
      await remoteGit(cwd, ['fetch', '--quiet', '--no-tags', remote, `+${ref}:${tracking}`])
      return true
    } catch (error) {
      if (/couldn't find remote ref|no such ref/i.test(detail(error))) return false
      throw error
    }
  }

  // Take the fetched remote branch in: fast-forward, or — only when both sides moved — a merge
  // of the three texts with two parents (the merge base keeps a deleted inbox line deleted;
  // branches born apart have none and merge from an empty base).
  async function absorb(attempts) {
    const theirs = await commitOf(tracking)
    let free = false
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const ours = await commitOf(ref)
      if (ours === theirs || (ours && await ancestor(theirs, ours))) return { action: 'none', commit: ours, lost: [] }
      if (!free) { await assertFree(); free = true }
      if (!ours || await ancestor(ours, theirs)) {
        if (await moveRef(theirs, ours, attempt)) return { action: 'ff', commit: theirs, lost: [] }
        continue
      }
      const base = (await git(cwd, ['merge-base', ours, theirs], [1]))?.trim() || null
      const [baseText, ourText, theirText] = await Promise.all([base, ours, theirs].map((commit) => commit ? textAt(commit) : ''))
      const merged = mergeSessions(baseText, ourText, theirText)
      const commit = await commitText(merged.text, [ours, theirs], `gusta: merge ${remote}/${branch}`)
      if (await moveRef(commit, ours, attempt)) return { action: 'merge', commit, lost: merged.lost }
    }
    return fail(`조정 브랜치 ${branch}에 원격을 ${attempts}회 시도에도 합치지 못했습니다. 다시 실행하세요.`, [detail(refused)])
  }

  // Fetch and take the remote in; nothing is pushed. lost: local claims the remote had first.
  // A remote that cannot be reached is an answer ({ reason, error }), not a throw — and so is a
  // branch of this name that is not a coordination branch (`foreign-branch`).
  // While the remote backs off (REMOTE_BACKOFF_MINUTES after an auth, timeout or network failure)
  // nothing reaches it: `backoff` says why and when it is tried again.
  async function sync({ attempts = 5 } = {}) {
    if (!push) return { action: 'none', reason: 'disabled', lost: [] }
    if (!remote) return { action: 'none', reason: 'no-remote', lost: [] }
    const waiting = await backoff()
    if (waiting) return { action: 'none', reason: 'backoff', backoff: shown(waiting), lost: [] }
    let fetched
    try { fetched = await fetchRemote() } catch (error) {
      const failed = failure(error, 'fetch-failed')
      await settle(failed)
      return { action: 'none', ...failed, lost: [] }
    }
    await settle(null)
    const found = await foreign()
    if (found) return { action: 'none', ...refusal(found), lost: [] }
    if (!fetched) return { action: 'none', reason: 'remote-branch-missing', lost: [] }
    return absorb(attempts)
  }

  // Sync, then push. Never throws: an unattended session goes on with local coordination and
  // the next event publishes again. A remote with no branch at all is skipped — the first
  // branch pushed would become the hosting default branch. A branch of this name that holds
  // code, here or on the remote, is never pushed or pushed over (`foreign-branch`).
  async function publish({ attempts = 3 } = {}) {
    const lost = []
    try {
      if (!push) return { pushed: false, reason: 'disabled', lost }
      if (!remote) return { pushed: false, reason: 'no-remote', lost }
      const found = await foreign()
      if (found) return { pushed: false, ...refusal(found), lost }
      let rejected = null
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        const synced = await sync()
        lost.push(...synced.lost)
        if (synced.backoff) return { pushed: false, reason: 'backoff', backoff: synced.backoff, lost }
        if (synced.error) return { pushed: false, reason: synced.reason, error: synced.error, lost }
        const commit = await commitOf(ref)
        if (!commit) return { pushed: false, reason: 'no-branch', lost }
        try {
          if (synced.reason !== 'remote-branch-missing') {
            if (await commitOf(tracking) === commit) return { pushed: false, reason: 'up-to-date', commit, lost }
          } else if (!(await remoteGit(cwd, ['ls-remote', '--heads', remote])).trim()) return { pushed: false, reason: 'remote-empty', lost }
          await remoteGit(cwd, ['push', '--quiet', remote, `${commit}:${ref}`])
        } catch (error) {
          rejected = error
          if (PUSH_RACE.test(detail(error)) && !REF_CONFLICT.test(detail(error))) continue
          const failed = failure(error, 'push-failed')
          await settle(failed)
          return { pushed: false, ...failed, lost }
        }
        await git(cwd, ['update-ref', tracking, commit]).catch(() => {})
        return { pushed: true, commit, attempts: attempt, lost }
      }
      return { pushed: false, reason: 'rejected', error: detail(rejected).slice(-1000), lost }
    } catch (error) {
      return { pushed: false, reason: 'error', error: detail(error).slice(-1000), lost }
    }
  }

  // What the branch has held, here and on the remote as last fetched: whether either exists, and
  // every inbox·log line any commit ever added. `gusta migrate` moves a STATE line only once — a
  // line resolved since must not come back from another checkout's stale STATE. Merges add no
  // line of their own (they union both sides), so their diffs are not read.
  async function history() {
    const refs = []
    for (const name of [ref, tracking]) if (name && await commitOf(name)) refs.push(name)
    if (!refs.length) return { existed: false, lines: [] }
    const patch = await git(cwd, ['log', '-p', '--root', '-U0', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--format=', '-G^- [0-9]', ...refs, '--', SESSIONS_FILE])
    const lines = new Set(patch.split('\n').filter((line) => line.startsWith('+- ')).map((line) => line.slice(1).trimEnd()))
    return { existed: true, lines: [...lines] }
  }

  // Whether this clone holds coordination commits the remote, as last fetched or pushed, lacks.
  // Always false where nothing is published (push off, or no remote).
  async function unpublished() {
    if (!push || !remote) return false
    const local = await commitOf(ref)
    const theirs = await commitOf(tracking)
    return Boolean(local) && !(theirs && (theirs === local || await ancestor(local, theirs)))
  }

  return { branch, ref, remote, push, read, update, sync, publish, unpublished, writable, history, backoff: async () => { const entry = push && remote ? await backoff() : null; return entry && shown(entry) } }
}
