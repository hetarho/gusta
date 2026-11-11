import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import os from 'node:os'
import { SkillPackageError } from './errors.mjs'
import { renderBrief } from './spec-context.mjs'
import { OPTIONAL_FLAGS } from './work-providers.mjs'

const fail = (message) => { throw new SkillPackageError(message) }
const object = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false })
const string = { type: 'string' }
export const RESULT_SCHEMAS = {
  unit: object({ kind: { type: 'string', enum: ['task', 'planning', 'inbox', 'fix', 'none'] }, id: string,
    outcome: { type: 'string', enum: ['completed', 'parked', 'blocked', 'no_work'] }, pushed: { type: 'boolean' }, next: string }),
  // decision is always present so strict structured output accepts it; an empty question means none.
  worker: object({ outcome: { type: 'string', enum: ['completed', 'blocked'] }, summary: string,
    decision: object({ question: string, options: { type: 'array', items: string }, recommendation: string }) }),
  reviewer: object({ verdict: { type: 'string', enum: ['approved', 'changes_requested'] }, summary: string,
    findings: { type: 'array', items: object({ priority: { type: 'string', enum: ['P1', 'P2', 'P3'] }, where: string, message: string }) } }),
  // A scout reads and proposes; its whole return is what reaches the orchestrator's context.
  scout: object({ summary: string, proposals: { type: 'array', items: object({ title: string, where: string, problem: string, evidence: string,
    change: string, touches: { type: 'array', items: string }, preserves: string, checks: string, cost: string, risk: string }) } }),
  // One A/B variant: what was built and where a person should look at it. path is the URL path the
  // host opens and probes (empty = root); view stays free text. Strict output needs path present.
  variant: object({ outcome: { type: 'string', enum: ['completed', 'blocked'] }, summary: string, view: string, path: string }),
}
// The mock scaffold the variants start from answers like a variant: what it did and which screen it renders.
RESULT_SCHEMAS.scaffold = RESULT_SCHEMAS.variant
const WRITES = ['worker', 'unit', 'variant', 'scaffold']
const PROPOSAL = ['title', 'where', 'problem', 'evidence', 'change', 'preserves', 'checks', 'cost', 'risk']

export function validateAgentResult(role, result) {
  if (role === 'unit') {
    if (!result || !['task', 'planning', 'inbox', 'fix', 'none'].includes(result.kind) || !['completed', 'parked', 'blocked', 'no_work'].includes(result.outcome) || typeof result.id !== 'string' || typeof result.pushed !== 'boolean' || typeof result.next !== 'string') fail('단위 결과의 kind/id/outcome/pushed/next가 올바르지 않습니다.')
    return { kind: result.kind, id: result.id, outcome: result.outcome, pushed: result.pushed, next: result.next }
  }
  if (!result || typeof result !== 'object' || Array.isArray(result) || typeof result.summary !== 'string' || !result.summary.trim()) fail('에이전트 결과에 summary가 없습니다.')
  if (role === 'scout') {
    if (!Array.isArray(result.proposals)) fail('탐색 결과에 proposals가 없습니다.')
    const proposals = result.proposals.map((entry) => {
      if (!entry || PROPOSAL.some((key) => typeof entry[key] !== 'string') || !entry.title.trim() || !Array.isArray(entry.touches) || entry.touches.some((value) => typeof value !== 'string')) fail('탐색 제안 형식이 올바르지 않습니다.')
      return Object.fromEntries([...PROPOSAL, 'touches'].map((key) => [key, entry[key]]))
    })
    return { summary: result.summary, proposals }
  }
  if (role === 'variant' || role === 'scaffold') {
    if (!['completed', 'blocked'].includes(result.outcome) || typeof result.view !== 'string' || !['string', 'undefined'].includes(typeof result.path)) fail('변형 결과의 outcome/view/path가 올바르지 않습니다.')
    return { outcome: result.outcome, summary: result.summary, view: result.view, path: result.path?.trim() ?? '' }
  }
  if (role === 'worker') {
    if (!['completed', 'blocked'].includes(result.outcome)) fail('워커 결과의 outcome이 올바르지 않습니다.')
    const decision = result.decision
    const asked = decision && typeof decision.question === 'string' && decision.question.trim()
    if (asked && (!Array.isArray(decision.options) || decision.options.some((value) => typeof value !== 'string') || typeof decision.recommendation !== 'string')) fail('워커의 결정 요청 형식이 올바르지 않습니다.')
    return { outcome: result.outcome, summary: result.summary,
      decision: asked && result.outcome === 'blocked' ? { question: decision.question, options: decision.options, recommendation: decision.recommendation } : null }
  }
  if (!['approved', 'changes_requested'].includes(result.verdict) || !Array.isArray(result.findings)) fail('리뷰 결과에 verdict/findings가 없습니다.')
  const findings = result.findings.map((entry) => {
    if (!entry || !['P1', 'P2', 'P3'].includes(entry.priority) || ![entry.where, entry.message].every((value) => typeof value === 'string' && value.trim())) fail('리뷰 finding 형식이 올바르지 않습니다.')
    return { priority: entry.priority, where: entry.where, message: entry.message }
  })
  return { verdict: result.verdict, summary: result.summary, findings }
}

// Four token counts are all a caller needs; the provider's full usage block stays out of context.
export function compactUsage(usage) {
  if (!usage || typeof usage !== 'object') return null
  return { input: usage.input_tokens ?? 0, cacheWrite: usage.cache_creation_input_tokens ?? 0, cacheRead: usage.cache_read_input_tokens ?? 0, output: usage.output_tokens ?? 0 }
}

// stream-json prints one event per line and ends with a `type:"result"` event; the last one is
// the answer. A single JSON envelope (`--output-format json`, command adapters) is accepted too.
const resultEvent = (line) => {
  if (!line.includes('"type":"result"')) return null
  try { const event = JSON.parse(line); return event?.type === 'result' ? event : null } catch { return null }
}
export function claudeEnvelope(text) {
  const last = String(text).split('\n').map(resultEvent).filter(Boolean).at(-1)
  if (last) return last
  let envelope
  try { envelope = JSON.parse(text) } catch { fail('Claude 응답에 result 이벤트가 없습니다.') }
  // A lone envelope has no type (or is the result); any other event means the session ended without one.
  if (envelope?.type !== undefined && envelope.type !== 'result') fail('Claude 응답에 result 이벤트가 없습니다.')
  return envelope
}

export function claudeResult(text, role) {
  const envelope = claudeEnvelope(text)
  if (envelope.is_error || envelope.subtype?.startsWith('error')) fail(`Claude 실행 실패: ${envelope.subtype ?? 'error'}`)
  if (!envelope.structured_output) fail('Claude 응답에 structured_output이 없습니다. JSON schema를 지원하는 CLI인지 확인하세요.')
  return validateAgentResult(role, envelope.structured_output)
}

// Codex prints JSONL events; the thread ID it starts is what `codex exec resume` continues.
export function codexSession(events) {
  for (const line of events.split('\n')) {
    try {
      const event = JSON.parse(line)
      const id = event.thread_id ?? event.session_id ?? (event.type === 'thread.started' ? event.id : null)
      if (typeof id === 'string' && id) return id
    } catch {}
  }
  return null
}

const DECIDE = 'If a planning decision that only the planner may make blocks you (a gap or contradiction in the SSOT), do not settle the policy in code: keep your edits, return outcome blocked with decision {question, options, recommendation}. Otherwise return decision with an empty question, empty options and empty recommendation.'
const BRIEF = 'The brief holds your task files, the decision blocks they depend on (cited, required, referencing them, global rules), the flow·constraints of those domains, changes since a stale base and the verification commands: that is your reading scope. Do not re-read STATE, FORMAT, ARCH or other SSOT files. Open an original only for what its issues, unfollowed or related lines name and the task needs; complete:no means part of it is missing, so read that part before relying on it.'
// A/B sessions once wrote helper scripts next to their worktree: scratch files stay inside it or in the OS temp dir.
const CONFINE = 'Write only inside this workspace, your own git worktree (scratch files under a git-ignored path in it or in the OS temp dir), never in its parent folders.'
const TASK_CHECKS = 'At task tier, run only added/changed/affected unit tests and fast type/lint/format checks. Write or update integration/e2e tests as needed, but do not launch browsers, integration/e2e or full suites at task/session completion. The coordinator host owns their single final gate on the integrated candidate before the target-branch push. Classify tests by their isolation and dependencies, not their script names. Use small fixtures for unit tests; record deferred commands/specs in result limits and never report unrun checks as passed.'

// The brief reaches the model as markdown ahead of the assignment JSON: inside JSON every newline
// and quote of the decision text would be escaped. The payload adapters receive is unchanged.
function splitBrief(job) {
  if (!job.brief?.decisions || !job.brief.roots) return { data: job, text: '' }
  const { tasks, decisions, sections, domains, history, refs, referrers, inbox, issues, ...meta } = job.brief
  return { data: { ...job, brief: meta }, text: `Brief (reading scope):\n${renderBrief(job.brief)}\n` }
}

// What a recovery unit inherits: the blocker, or the unfinished attempt the host kept aside.
export function recoveryText(recovery) {
  if (!recovery) return ''
  const { taskId: id, snapshot } = recovery
  const kept = snapshot ? ` The previous attempt's uncommitted changes are snapshot ${snapshot.commit} on top of ${snapshot.base}; the tree was reset to HEAD. List them with \`git diff --stat ${snapshot.base} ${snapshot.commit}\` and restore what is worth keeping with \`git checkout ${snapshot.commit} -- <paths>\`.` : ''
  if (recovery.reason === 'interrupted') return `\nContinuation unit for ${id}: the previous unit ended before finishing it (${recovery.cause}).${kept} Continue from there rather than starting over.`
  if (recovery.reason === 'split') return `\nSplit unit for ${id}: units keep ending before finishing it. Do not implement it now. As one planning slice, narrow ${id} to a first part that fits one unit and move the rest of its acceptance into new todo tasks that depend on it (create-task, consistent deps/base in task files and STATE)${snapshot ? `; note snapshot ${snapshot.commit} (on ${snapshot.base}) in ${id}'s impl notes as reusable work` : ''}. Return kind planning.`
  return `\nRecovery unit for ${id}: read the blocker in its task result and relevant inbox entries. Resolve reversible planning/technical gaps as one planning slice, record the decision and restore todo with consistent deps/base in the task and STATE. If it is an implementation failure, make the scoped fix. If it truly needs the reserved authorization above, record parked for this task and return outcome parked. Do not repeat the same blocked implementation or wait for a user.${kept}`
}

// The frontmatter only triggers a skill; a unit is already inside it. No frontmatter: unchanged.
export const skillBody = (text) => text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n+/, '')

// The full prompt a session gets; A/B runs save it next to their log for debugging.
export async function agentPrompt(job) {
  if (job.role === 'unit') {
    if (!job.workspace || job.resume) fail('단위는 workspace와 새 세션이 필요합니다 (resume 금지).')
    const skill = skillBody(await readFile(new URL('../skills/start-vibe/SKILL.md', import.meta.url), 'utf8'))
    const autonomy = 'Autopilot delegates reversible planning and technical decisions to you. Do not wait for a person or park work merely because a decision is needed. Apply the recommended option through update-ssot and create-task when needed, record question/choice/alternatives/reason in STATE inbox decided, and leave the task runnable for the next unit. You may reorder unstarted tasks to bring an already-approved prerequisite or CI fix forward after checking real dependencies and touches; update task and STATE deps together. Preserve acceptance criteria and verification gates. Park only the affected work when it needs unavailable access, explicit authorization for irreversible/external effects, or a billing, data-deletion, privacy or security-policy decision; continue other runnable work.'
    const recovery = recoveryText(job.recovery)
    const limit = job.timeLimit ? ` The host cuts this unit after ${job.timeLimit.minutes} minutes (${job.timeLimit.cutAt}) and hands uncommitted work to a fresh unit; write measurements and findings into the task result as you go.` : ''
    // The skill rides in the prompt; without this note Codex units re-read it from .codex/skills first.
    return `Run /start-vibe 맡김 단위1. The start-vibe skill is included below and already loaded: do not open its SKILL.md or call a Skill tool for it. Load the skills it routes to (implement-task, create-task, update-ssot...) as usual. Exactly one task done, one planning slice (update-ssot + create-task together), or inbox cleanup. No questions, no subagents. ${autonomy}${recovery}${limit} ${TASK_CHECKS} Host owns preflight, active row lifecycle, report lifecycle, batch checks, push and CI wait. Do not run them again. Use the same tag/report. Commit each completed task, including only its related changes. In strict concurrency the host publishes your claim with vibe claim before dispatch; never publish claims or pending code yourself. Never push completed code here: host runs the batch gate first. Do not close the shared report or remove active. Use cliCommand to call this installed CLI; do not download a different CLI. Read vibe brief for a task, exact FORMAT sections only for writing, never whole STATE/FORMAT/ARCH or large code files. Read scoped code with rg and ranges. Long checks: one blocking call (Codex) or shell background completion notification (Claude), no model polling. Return only the unit JSON schema.\n\nstart-vibe skill (already loaded):\n${skill}\n\n${splitBrief(job).text}Assignment JSON:\n${JSON.stringify(splitBrief(job).data)}`
  }
  if (job.role === 'scout') {
    if (!job.workspace || typeof job.prompt !== 'string' || !job.prompt.trim() || job.resume) fail('탐색은 workspace·prompt와 새 세션이 필요합니다.')
    return `You are a read-only scout started by an orchestrator. Do NOT edit files, change Git or runtime, run long or full checks, or spawn subagents. Read scoped code with rg and line ranges, not whole large files. Label inference and unknowns; cite file:line or log paths as evidence. An empty proposals array is a valid answer when nothing is worth changing. Return only the final JSON matching the output schema.\n\n${job.prompt}`
  }
  if (job.role === 'variant') {
    if (!job.workspace || typeof job.prompt !== 'string' || !job.prompt.trim() || job.resume) fail('변형은 workspace·prompt와 새 세션이 필요합니다.')
    return `You build one variant of an A/B comparison started by an orchestrator, on your own branch; implement it fully enough for a person to compare it. ${CONFINE} Do NOT edit spec/ (nothing is decided yet), run git add/commit/push/merge (the host commits your changes), start long-running servers (the host serves each variant on its own port as $PORT), or spawn subagents. ${TASK_CHECKS} Return outcome, summary (what you changed and its trade-offs), view (where a person should look: screen, state or command) and path (the URL path the host opens first, e.g. /settings/profile; empty for root or no screen); outcome blocked only when the variant cannot be built, with the reason in summary.\n\n${job.prompt}`
  }
  if (job.role === 'scaffold') {
    if (!job.workspace || typeof job.prompt !== 'string' || !job.prompt.trim() || job.resume) fail('scaffold는 workspace·prompt와 새 세션이 필요합니다.')
    return `You build the shared mock scaffold of an A/B UI comparison; the variants are built on top of it. ${CONFINE} Make the target screen render without a backend: realistic, deterministic fixtures and auth stubbed as a signed-in user, wired in at the data/auth boundary. Prefer, in order: (1) fixtures served by the project's own dev server or a dev-only route/middleware, touching no screen file; (2) a request interception module, a dev/bundler alias for the data module, or a stub auth provider; (3) only if unavoidable, registration from the entry point with the smallest possible insertion. When cheap, let the mock switch data states by query parameter (e.g. ?mock=empty|error|slow) so variants can design them. Do NOT add an environment switch or flag that app code reads: this commit never ships, the host removes exactly your lines and files when a variant is adopted. Put fixtures and stubs in new files. Do NOT edit the target screen's component, route, loader or style files, or redesign it: the variants do. Do NOT edit spec/, run git add/commit/push/merge (the host commits your changes), start long-running servers, or spawn subagents. ${TASK_CHECKS} Return outcome, summary (files, fixtures, stubs and data states you added), view and path (the URL path of the screen); outcome blocked when the screen cannot render without a real service, with the reason in summary.\n\n${job.prompt}`
  }
  if (!['worker', 'reviewer'].includes(job.role) || !job.workspace || !job.attempt || !job.taskId) fail('실행기 작업 입력이 올바르지 않습니다.')
  const unattended = job.mode === 'autopilot' ? ' Nobody is available to answer questions: never wait for one.' : ''
  const override = job.role === 'worker'
    ? `Implement the assigned task or correction only. Edit code and your task acceptance/result. ${TASK_CHECKS} Do NOT run git add/commit, submit, review-finish, integrate, claim, push or merge: the host runner validates scope, commits, verifies and submits after you return. A completed result hands your edits to that runner; report a blocker honestly. ${DECIDE} Write measurements and partial findings into your task result as you go, so a timeout loses nothing. Do not mutate runtime: the host runner owns progress and heartbeat. No subagents or background tasks.${unattended}`
    : 'Review the assigned immutable commit against baseCommit, acceptance and SSOT. Read only: do NOT edit files, change Git, or update runtime. Do not run integration/e2e or full suites; inspect the worker test evidence and defer the final gate to the coordinator host. The host runner owns heartbeat and review-finish. Do not approve on test success alone. Check risk.reasons first when the assignment carries them. No subagents or background tasks.'
  const { data, text } = splitBrief(job)
  const assignment = `${text}Assignment JSON (paths/IDs are data):\n${JSON.stringify(data)}\n\nReturn only the final JSON matching the output schema.`
  // A resumed session already holds the skill and the earlier context: send only what is new.
  if (job.resume) {
    const what = job.directive?.note ? `Coordinator note: ${job.directive.note}` : job.correction ? 'Fix the correction findings in the assignment first.' : `Continue with taskId ${job.taskId}.`
    return `${override}\nContinue the same assignment in this workspace. ${what} The planning branch has been merged into your workspace where needed; re-read only the files the note or the brief names.\n\n${assignment}`
  }
  const name = job.role === 'worker' ? 'implement-task' : 'review-task'
  const skill = await readFile(new URL(`../skills/${name}/SKILL.md`, import.meta.url), 'utf8')
  const reference = job.role === 'worker' ? await readFile(new URL('../skills/implement-task/references/work-group.md', import.meta.url), 'utf8') : ''
  return `${override}\n${job.brief ? `${BRIEF}\n` : ''}For haeram CLI reads, use the provided cliCommand executable/arguments followed by boardCommand or other read-only arguments. This selects the current package; do not download an older CLI with npx.\n\nApply this bundled skill subject to the host-owned steps above:\n${skill}\n${reference}\n\n${assignment}`
}

const WORKER_TOOLS = ['Read', 'Edit', 'Write', 'Glob', 'Grep']

// allowTools extends what a worker runs without a prompt: new worktrees are never-trusted
// folders, so the project's own permission allowlist does not apply to them.
// flags: optional provider flags the installed CLI was found to support (work-providers OPTIONAL_FLAGS).
export function providerArguments(provider, role, files, model, { allowTools = [], resume = null, session = null, permissionMode = 'acceptEdits', flags = [] } = {}) {
  const writes = WRITES.includes(role)
  const sandbox = writes ? 'workspace-write' : 'read-only'
  if (!['acceptEdits', 'bypass'].includes(permissionMode) || (!writes && permissionMode === 'bypass')) fail('지원하지 않는 permission mode입니다.')
  if (provider === 'codex') {
    const tail = ['--json', '--output-schema', files.schema, '--output-last-message', files.result, ...(model ? ['--model', model] : []), '-']
    // exec resume takes the bypass flag too, so a resumed bypass session keeps its session.
    if (permissionMode === 'bypass') return ['exec', ...(resume ? ['resume', resume] : []), '--dangerously-bypass-approvals-and-sandbox', ...tail]
    return resume ? ['-a', 'never', '--sandbox', sandbox, 'exec', 'resume', resume, ...tail] : ['-a', 'never', 'exec', '--sandbox', sandbox, ...tail]
  }
  // stream-json (which print mode allows only with --verbose) lets the log follow the session live.
  if (provider === 'claude') return ['--print', '--output-format', 'stream-json', '--verbose', '--json-schema', JSON.stringify(RESULT_SCHEMAS[role]),
    '--permission-mode', writes ? permissionMode === 'bypass' ? 'bypassPermissions' : 'acceptEdits' : 'plan', '--permission-prompts', 'none',
    '--tools', writes ? 'Bash,Read,Edit,Write,Glob,Grep' : 'Bash,Read,Glob,Grep',
    '--allowedTools', writes ? [...WORKER_TOOLS, ...allowTools].join(',') : 'Read,Glob,Grep,Bash(git diff *),Bash(git show *),Bash(git log *),Bash(git status *),Bash(git ls-files *)',
    ...(resume ? ['--resume', resume] : session ? ['--session-id', session] : []), ...(model ? ['--model', model] : []),
    ...flags.filter((flag) => OPTIONAL_FLAGS.claude.includes(flag))]
  fail(`지원하지 않는 실행기: ${provider}`)
}

// flags: the caller's providerFlags answer; none by default (this never probes the CLI).
export async function executeAgentAdapter({ provider, model, job, env = process.env, log = (text) => process.stderr.write(text), flags = [] }) {
  const prompt = await agentPrompt(job)
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'haeram-agent-'))
  const files = { schema: path.join(temporary, 'schema.json'), result: path.join(temporary, 'result.json') }
  try {
    await writeFile(files.schema, JSON.stringify(RESULT_SCHEMAS[job.role]))
    // The session ID is known before the run ends (Claude: chosen here; Codex: its first event)
    // and written to sessionFile at once, so even a run killed at its timeout can be resumed.
    const session = provider === 'claude' ? job.resume ?? randomUUID() : job.resume ?? null
    const remember = (id) => job.sessionFile && id ? writeFile(job.sessionFile, id).catch(() => {}) : null
    await remember(session)
    const args = providerArguments(provider, job.role, files, model, { allowTools: WRITES.includes(job.role) ? job.allowTools ?? [] : [], resume: job.resume ?? null, session: job.resume ? null : session, permissionMode: job.permissionMode ?? 'acceptEdits', flags })
    const childEnv = { ...env }
    // The provider is an independent foreground run, not a nested interactive session.
    delete childEnv.CLAUDECODE
    const child = spawn(provider, args, { cwd: job.workspace, env: childEnv, shell: false, stdio: ['pipe', 'pipe', 'pipe'] })
    let partial = '', answer = '', last = '', events = '', errorOutput = '', tooLarge = false, interrupted = false, timedOut = false, forced
    // Claude keeps only the last result event (or a lone envelope line) in memory; every event
    // already went to the log as it arrived, so a long session does not grow the buffer.
    const keep = (line) => { if (!line.trim()) return; last = line; if (resultEvent(line)) answer = line }
    // In work run, both processes share the runner-owned process group. Direct adapter
    // invocations still forward termination to the provider.
    const stop = () => {
      interrupted = true
      child.kill('SIGTERM')
      forced ??= setTimeout(() => child.kill('SIGKILL'), 2000)
      forced.unref()
    }
    process.on('SIGTERM', stop); process.on('SIGINT', stop)
    const limit = job.timeoutMs ? setTimeout(() => { timedOut = true; stop() }, job.timeoutMs) : null
    try {
      await new Promise((resolve, reject) => {
        child.on('error', reject)
        child.stdout.setEncoding('utf8')
        child.stdout.on('data', (chunk) => {
          // Both providers stream events: the log follows the session as it runs.
          log(chunk)
          if (provider === 'codex') {
            // Keep only the head of the event stream: the session ID comes first.
            if (events.length < 64 * 1024) {
              events += chunk
              if (!job.resume) remember(codexSession(events))
            }
            return
          }
          const lines = (partial + chunk).split('\n')
          partial = lines.pop()
          for (const line of lines) keep(line)
          if (partial.length > 8 * 1024 * 1024) { tooLarge = true; stop(); partial = '' }
        })
        child.stderr.on('data', (chunk) => { errorOutput = (errorOutput + chunk).slice(-16000); log(chunk.toString()) })
        child.on('close', (code, signal) => code === 0 && !interrupted ? resolve() : reject(new SkillPackageError(`${provider} 실행 실패 (${tooLarge ? 'output limit' : timedOut ? 'timeout' : interrupted ? 'interrupted' : code ?? signal})`, [errorOutput])))
        child.stdin.on('error', () => {})
        child.stdin.end(prompt)
      })
    } finally {
      clearTimeout(forced); clearTimeout(limit)
      process.off('SIGTERM', stop); process.off('SIGINT', stop)
    }
    if (provider === 'claude') {
      keep(partial)
      const output = answer || last
      return { ...claudeResult(output, job.role), session, ...(['unit', 'scout', 'variant', 'scaffold'].includes(job.role) ? { usage: claudeEnvelope(output).usage ?? null } : {}) }
    }
    return { ...validateAgentResult(job.role, JSON.parse(await readFile(files.result, 'utf8'))), session: codexSession(events) ?? job.resume ?? null }
  } finally { await rm(temporary, { recursive: true, force: true }) }
}
