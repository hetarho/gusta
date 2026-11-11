import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, open } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readTaskBoard } from './task-board.mjs'
import { readRuntime, transaction } from './work-runtime.mjs'
import { startWork, claimNextWork, recoverWork, workInternals } from './work-groups.mjs'
import { claimReview, resumeWork } from './work-review.mjs'
import { activeAttempt, unitTasks, overlaps, scopedBoard } from './work-policy.mjs'
import { planUnits, mainSessionTasks } from './task-graph.mjs'

const { repository, groupOf, fail, head, groupVerification } = workInternals
const cli = fileURLToPath(new URL('../bin/haeram-spec-creator.mjs', import.meta.url))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const alive = (pid) => { try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' } }
const local = (entry) => entry?.host === os.hostname()

function waitSeconds(options) {
  if (options.wait === undefined) return 0
  const value = Number(options.wait)
  if (!Number.isSafeInteger(value) || value < 0 || value > 3600) fail('wait: 0~3600 사이 초 단위 정수가 필요합니다.')
  return value
}

// Sessions started at the same commit derive the same group name, so concurrent
// "implement the remaining tasks" requests create one group and join it.
async function resolveGroup(context, options) {
  if (options.work) return options.work
  const groups = Object.values((await readRuntime(context.root)).groups).filter((group) => group.status === 'active')
  if (groups.length === 1) return groups[0].id
  if (groups.length > 1) fail('활성 작업 묶음이 여러 개입니다. --work로 지정하세요.', groups.map((group) => group.id))
  if (!options.start) fail('활성 작업 묶음이 없습니다. --start로 시작하거나 manage-work로 묶음을 만드세요.')
  const name = `work-${(await head(context.cwd)).slice(0, 7)}`
  try {
    // Sessions review each other's units, so review capacity follows the session count.
    await startWork({ targetRoot: options.targetRoot, name, workspace: 'new', workers: options.workers, reviewers: options.reviewers ?? options.workers ?? 4, maxPending: options.maxPending,
      taskVerify: options.taskVerify, verify: options.verify, groupVerify: options.groupVerify,
      push: options.push, remote: options.remote, review: options.review, reviewPath: options.reviewPath, reviewLines: options.reviewLines, allowTool: options.allowTool })
  } catch (error) {
    if (!Object.hasOwn((await readRuntime(context.root)).groups, name)) throw error
  }
  for (let index = 0; index < 600; index += 1) {
    const group = (await readRuntime(context.root)).groups[name]
    if (group?.status === 'active') return name
    if (group?.status === 'failed') fail('작업 묶음 생성에 실패했습니다.', [group.error ?? name])
    await sleep(100)
  }
  return fail('다른 세션의 작업 묶음 생성이 끝나지 않았습니다.')
}

// A background check whose process is gone is recovered with the regular, proof-based recover.
async function reap(options, group) {
  const operation = group.operation
  if (!operation?.pid || !local(operation) || alive(operation.pid)) return
  await (['sync', 'finishing'].includes(operation.kind) ? recoverWork({ ...options, attempt: undefined, work: group.id })
    : recoverWork({ ...options, work: undefined, attempt: operation.attempt })).catch(() => {})
}

// Integration and the group finish are mechanical, so no session spends a model turn on
// them: the first session that looks starts them as a detached CLI process.
async function kickGate(context, options, id) {
  const state = await readRuntime(context.root)
  const group = groupOf(state, id)
  await reap(options, group)
  const busy = (entry) => entry.operation || entry.runner || (local(entry.gate) && (entry.gate.pid ? alive(entry.gate.pid) : Date.now() - Date.parse(entry.gate.at) < 60000))
  if (busy(group)) return
  const attempts = Object.values(state.attempts).filter((entry) => entry.group === group.id)
  const approved = attempts.filter((entry) => entry.status === 'approved').sort((a, b) => (a.review?.finishedAt ?? '').localeCompare(b.review?.finishedAt ?? ''))[0]
  let args = null
  if (approved && group.verify?.unit?.length) args = ['integrate', '--attempt', approved.id, '--auto-correct']
  else if (!attempts.some(activeAttempt) && group.verify?.group?.length) {
    const target = await head(context.cwd, `refs/heads/${group.branch}`)
    const board = scopedBoard(await readTaskBoard({ targetRoot: context.cwd, workspace: context.workspace, ref: target }), group)
    const deferred = mainSessionTasks(board.tasks)
    if (board.ok && !board.warnings.length && board.tasks.every((task) => task.st?.startsWith('blocked@') || deferred.has(task.id)) &&
        !(await groupVerification(context, group))?.current && group.finishFailure?.commit !== target) args = ['finish', '--work', group.id]
  }
  if (!args) return
  const token = randomUUID()
  const reserved = await transaction(context.root, (live) => {
    const entry = groupOf(live, group.id)
    if (busy(entry)) return false
    entry.gate = { token, kind: args[0], attempt: approved?.id ?? null, host: os.hostname(), at: new Date().toISOString(), pid: null }
    return true
  })
  if (!reserved) return
  await mkdir(path.join(context.root, 'logs'), { recursive: true })
  const log = await open(path.join(context.root, 'logs', `${group.id}.log`), 'a')
  let child
  try {
    child = spawn(process.execPath, [cli, 'work', ...args, '--target', context.cwd, '--json'], { cwd: context.cwd, detached: true, stdio: ['ignore', log.fd, log.fd] })
    child.unref()
  } finally { await log.close() }
  await transaction(context.root, (live) => {
    const entry = groupOf(live, group.id)
    if (entry.gate?.token === token) entry.gate.pid = child.pid ?? null
  })
}

// complete: nothing left · stalled: only a person can unblock it · waiting: in-flight work
// can still open something. Liveness of other sessions is unknown, so --wait stays bounded.
async function outlook(context, id, owner) {
  const state = await readRuntime(context.root)
  const group = groupOf(state, id)
  const target = await head(context.cwd, `refs/heads/${group.branch}`)
  const board = scopedBoard(await readTaskBoard({ targetRoot: context.cwd, workspace: context.workspace, ref: target }), group)
  const live = Object.values(state.attempts).filter((entry) => entry.group === group.id && activeAttempt(entry))
  const owned = new Set(live.flatMap(unitTasks))
  // Explore tasks and their dependents belong to the main session, never to this group.
  const deferred = mainSessionTasks(board.tasks)
  const open = board.tasks.filter((task) => task.st === 'todo' && !owned.has(task.id) && !deferred.has(task.id))
  const moving = live.filter((entry) => entry.status !== 'blocked')
  // A filed decision is the coordinator's to answer: the group is waiting on it, not stalled.
  const deciding = live.filter((entry) => entry.status === 'blocked' && entry.decision && !entry.decision.answeredAt)
  if (!moving.length && deciding.length && group.coordinator) return { state: 'waiting', reason: 'decision', deciding: deciding.map((entry) => ({ attempt: entry.id, tasks: unitTasks(entry), question: entry.decision.question })) }
  const blocked = live.filter((entry) => entry.status === 'blocked').map((entry) => ({ attempt: entry.id, tasks: unitTasks(entry), owner: entry.owner, reason: entry.reason ?? null }))
  if (!open.length && !live.length) {
    const verified = await groupVerification(context, group)
    if (!group.verify?.group?.length || verified?.current) {
      const later = board.tasks.filter((task) => deferred.has(task.id)).map((task) => task.id)
      return later.length ? { state: 'main-session', tasks: later, verified, branch: group.branch } : { state: 'complete', verified, branch: group.branch }
    }
    if (group.finishFailure?.commit === target) return { state: 'stalled', finishFailure: group.finishFailure }
    return { state: 'waiting', reason: 'finishing' }
  }
  // A claim can lose a race with an integration that just moved the branch; a ready unit
  // that no live attempt blocks is never a stall.
  const claimable = planUnits(board.tasks, board.doneIds, owned).some((unit) => unit.ready && !live.some((entry) => overlaps(unit.touches, entry.touches)))
  if (claimable) return { state: 'waiting', reason: 'claimable' }
  if (!moving.length && !group.runner && !group.operation) return { state: 'stalled', blocked, waitingOn: open.map((task) => ({ id: task.id, waitingOn: task.waitingOn })) }
  const inFlight = moving.map((entry) => ({ attempt: entry.id, tasks: unitTasks(entry), owner: entry.owner, status: entry.status }))
  // Only this session's own submissions are waiting and nobody else is working: an
  // independent reviewer has to join before anything can move.
  if (owner && moving.every((entry) => entry.status === 'ready' && (entry.contributors ?? [entry.owner]).includes(owner))) return { state: 'waiting', reason: 'needs-reviewer', final: true, inFlight }
  return { state: 'waiting', reason: group.operation || group.gate ? 'integration-in-progress' : null, inFlight }
}

// Autopilot: nobody answers, so no instruction ends in a question to the user.
const UNATTENDED = {
  blocked: 'attempt.reason을 확인한다. 직접 고칠 수 있으면 고친 뒤 work update --attempt <id> --status doing으로 재개해 다시 submit한다. 기획 결정이 필요하면 결정 요청(question·options·recommendation)을 세션 임시 폴더의 JSON에 써서 work update --attempt <id> --status blocked --reason <요약> --decision-file <path>로 남기고 work next를 다시 호출한다 — 기다리지 않는다.',
  decide: 'attempt.decision에 답한다(조정자). 기획 공간에서 recommendation으로 update-ssot를 진행하고(잠정) inbox decided·보고서에 질문·선택·대안을 남겨 커밋한 뒤, work update --attempt <id> --status doing --note <적용한 결정과 SSOT rev>로 재개한다. 과금·데이터 삭제·개인정보·보안이면 정하지 않고 inbox parked 후 work release --attempt <id> --reason parked. 그리고 work next를 다시 호출한다.',
  complete: '남은 일이 없다. landFrom에서 vibe push --target <landFrom> --verified-commit <verified.commit>으로 SETTINGS land에 반영하고, 반영 결과와 검증 커밋을 보고서에 남긴 뒤 마감한다. 결과 reason이 land-unset이면 inbox parked로 남긴다.',
  stalled: '사람만 풀 수 있는 원인이다. 원인을 inbox parked와 보고서에 남기고 묶음 밖의 다른 일로 간다 — 기다리지 않는다.',
  // No subagent here: its permission prompt would stall an unattended session (start-vibe §3).
  'needs-reviewer': '이 세션의 제출물만 남아 있어 독립 리뷰어가 필요하다. 맡김에서는 부하 에이전트를 띄우지 않는다 — 리뷰어 슬롯이 있는 헤드리스 실행기(work run)가 맡게 하고, 없으면 inbox parked로 남기고 다른 일로 간다.',
}

const INSTRUCTION = {
  implement: 'attempt.workspace에서 attempt.tasks를 attempt.taskId부터 순서대로 implement-task로 구현하고 태스크마다 커밋한 뒤, 마지막 태스크까지 끝나면 work submit --attempt <id>를 한 번 실행한다. 응답이 doing이면 그 taskId부터 이어 가고, ready면 work next를 다시 호출한다. correction이 있으면 findings부터 처리한다.',
  review: 'review.workspace(읽기 전용)에서 review-task로 review.tasks를 검토하고, 세션 임시 폴더의 JSON 파일에 결과를 써서 work review-finish --review <id> --result-file <path>를 실행한 뒤 work next를 다시 호출한다.',
  blocked: 'attempt.reason을 확인한다. 직접 고칠 수 있으면 고친 뒤 work update --attempt <id> --status doing으로 재개해 다시 submit하고, 기획 판단이 필요하면 사용자에게 보고하고 멈춘다.',
  wait: 'work next를 다시 호출한다. 통합·검증은 CLI가 백그라운드에서 진행한다.',
  'needs-reviewer': '이 세션의 제출물만 남아 있어 독립 리뷰어가 필요하다. 다른 세션을 열어 같은 요청을 하게 하거나, 새 컨텍스트의 서브에이전트에서 다른 owner로 review-task를 실행한 뒤 work next를 다시 호출한다.',
  complete: '남은 일이 없다. landFrom에서 vibe push --target <landFrom> --verified-commit <verified.commit>으로 SETTINGS land에 반영하고 묶음 브랜치·검증 커밋·반영 결과를 보고한다. land가 정해지지 않았으면(land-unset) haeram-init으로 먼저 정한다.',
  stalled: 'blocked·finishFailure 원인을 사용자에게 보고하고 멈춘다. 해결되면 work next를 다시 호출한다.',
  decide: 'attempt.decision(question·options·recommendation)을 사용자에게 선택지형으로 묻고, 기획 공간에서 update-ssot로 반영해 커밋한 뒤 work update --attempt <id> --status doing --note <적용한 결정과 SSOT rev>로 재개한다.',
  'main-session': '묶음에서 할 일은 끝났다. 남은 tasks는 explore 태스크와 그 후속이라 메인 세션에서 단독으로(implement-task) 진행한다.',
}

async function nextAction(context, options) {
  const state = await readRuntime(context.root)
  const group = groupOf(state, options.work)
  // The coordinator answers filed decisions before anything else: each one unblocks a worker.
  if (options.owner === group.coordinator) {
    const filed = Object.values(state.attempts).filter((entry) => entry.group === options.work && entry.status === 'blocked' && entry.decision && !entry.decision.answeredAt)
      .sort((a, b) => a.decision.at.localeCompare(b.decision.at))[0]
    if (filed) return { action: 'decide', attempt: filed }
    // The coordinator decides, parks and reports; it never takes a unit or a review.
    const view = await outlook(context, options.work, options.owner)
    return view.state === 'waiting' ? { action: 'wait', ...view } : { action: view.state, ...view, final: true }
  }
  const mine = Object.values(state.attempts).filter((entry) => entry.group === options.work && entry.owner === options.owner)
  const doing = mine.find((entry) => entry.status === 'doing')
  if (doing) return { action: 'implement', attempt: doing }
  // A unit whose decision is with the coordinator is not this session's to unblock.
  const blocked = mine.find((entry) => entry.status === 'blocked' && !(entry.decision && !entry.decision.answeredAt && group.coordinator))
  if (blocked) return { action: 'blocked', attempt: blocked }
  const corrected = await resumeWork({ ...options, attempt: undefined })
  if (!corrected.idle) return { action: 'implement', attempt: corrected }
  // Reviews unblock the pipeline, so an idle session reviews before it takes new work.
  const review = await claimReview({ ...options, attempt: undefined })
  if (!review.idle) return { action: 'review', review }
  const claimed = await claimNextWork(options)
  if (!claimed.idle) return { action: 'implement', attempt: claimed }
  const view = await outlook(context, options.work, options.owner)
  if (view.state !== 'waiting') return { action: view.state, ...view, final: true }
  return { action: 'wait', ...view, reason: view.reason ?? claimed.reason }
}

// One call for any long-lived session: its own unit, corrections, reviews, then the next
// ready unit, waiting without model calls while integration or other units run.
export async function nextWork(options) {
  if (!options.owner?.trim()) fail('next에는 --owner가 필요합니다.')
  const seconds = waitSeconds(options)
  const deadline = Date.now() + seconds * 1000
  const context = await repository(options)
  const work = await resolveGroup(context, options)
  const scoped = { ...options, work }
  if (options.coordinator) {
    await transaction(context.root, (state) => {
      const group = groupOf(state, work)
      if (group.coordinator && group.coordinator !== options.owner) fail(`이 묶음의 조정자는 ${group.coordinator}입니다.`)
      group.coordinator = options.owner
    })
  }
  for (;;) {
    await kickGate(context, scoped, work)
    const result = await nextAction(context, scoped)
    const timedOut = result.action === 'wait' && !result.final && Date.now() >= deadline
    if (result.action !== 'wait' || result.final || timedOut) {
      const { final, state, ...rest } = result
      const key = result.reason === 'needs-reviewer' ? 'needs-reviewer' : result.action
      const group = result.action === 'complete' ? groupOf(await readRuntime(context.root), work) : null
      const integrationTarget = group?.managed === false ? { branch: group.branch, path: group.path } : null
      return { schemaVersion: 1, work, owner: options.owner, ...rest, ...(timedOut && seconds ? { reason: 'timeout', detail: result.reason } : {}),
        ...(integrationTarget ? { integrationTarget } : {}), ...(group ? { landFrom: group.path } : {}),
        instruction: integrationTarget ? '지정한 기존 로컬 브랜치에 통합과 최종 검증이 끝났다. integrationTarget과 검증 커밋을 보고한다. 이미 위임된 로컬 통합을 다시 묻지 않는다. 이후 반영은 SETTINGS land·push를 따른다: vibe push --target <landFrom> --verified-commit <verified.commit> (land가 current이고 push가 false면 할 일 없음).' : (options.autopilot ? UNATTENDED[key] : null) ?? INSTRUCTION[key] }
    }
    await sleep(Math.min(options.pollMs ?? 5000, deadline - Date.now()))
  }
}

export async function claimReviewWaiting(options) {
  if (!options.owner?.trim()) fail('review-claim에는 --owner가 필요합니다.')
  if (options.wait === undefined) return claimReview(options)
  const deadline = Date.now() + waitSeconds(options) * 1000
  const context = await repository(options)
  for (;;) {
    await kickGate(context, options, options.work)
    const result = await claimReview(options)
    if (!result.idle || result.reason === 'owner-busy') return result
    const view = await outlook(context, options.work)
    if (view.state !== 'waiting') return { ...result, reason: view.state, detail: result.reason, ...view }
    if (Date.now() >= deadline) return { ...result, reason: 'timeout', detail: result.reason, ...view }
    await sleep(Math.min(options.pollMs ?? 5000, deadline - Date.now()))
  }
}
