import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { git } from './workspace.mjs'
import { readRuntime, transaction } from './work-runtime.mjs'
import { workInternals } from './work-groups.mjs'
import { workLimits, invalidateReview, workerBusy, unitTasks } from './work-policy.mjs'

const { repository, groupOf, attemptOf, notIntegrating, destination, requireClean, checkWorker, head, now, fail, approvalHolds } = workInternals

export async function claimReview(options) {
  if (!options.owner?.trim()) fail('review-claim에는 --owner가 필요합니다.')
  const context = await repository(options)
  const state = await readRuntime(context.root)
  const group = groupOf(state, options.work)
  const baseCommit = await head(context.cwd, `refs/heads/${group.branch}`)
  const id = randomUUID()
  const workspace = await destination(context, `${group.id}-review-${id.slice(0, 8)}`)
  const selected = await transaction(context.root, async (live) => {
    const currentGroup = groupOf(live, group.id)
    if (await head(context.cwd, `refs/heads/${group.branch}`) !== baseCommit) return { idle: true, reason: 'planning-changed; retry' }
    const attempts = Object.values(live.attempts).filter((entry) => entry.group === group.id)
    // A base advance invalidates the old approval only when it touches the same files or SSOT.
    for (const entry of attempts) if (entry.status === 'approved' && !(await approvalHolds(context.cwd, entry.review, baseCommit))) {
      invalidateReview(entry, 'review base changed'); entry.status = 'ready'
    }
    if (attempts.filter((entry) => entry.status === 'reviewing').length >= workLimits(currentGroup.limits).reviewers) return { idle: true, reason: 'reviewer-capacity' }
    if (attempts.some((entry) => entry.status === 'reviewing' && entry.review.owner === options.owner)) return { idle: true, reason: 'owner-busy' }
    const attempt = attempts.filter((entry) => entry.status === 'ready' && !(entry.contributors ?? [entry.owner]).includes(options.owner) && (!options.attempt || entry.id === options.attempt))
      .sort((a, b) => a.submittedAt.localeCompare(b.submittedAt) || a.id.localeCompare(b.id))[0]
    if (!attempt) return { idle: true, reason: 'no-reviewable-submission' }
    if (!attempt.verifiedCommit || !attempt.submissionId) fail('새 프로토콜로 submit한 제출물이 필요합니다.')
    const review = { id, attempt: attempt.id, tasks: unitTasks(attempt), group: group.id, owner: options.owner, status: 'reviewing',
      submissionId: attempt.submissionId, commit: attempt.verifiedCommit, baseCommit, workspace, createdAt: now(), heartbeatAt: now() }
    attempt.status = 'reviewing'
    attempt.review = review
    attempt.candidates = [...(attempt.candidates ?? []), workspace]
    return review
  })
  if (selected.idle) return selected
  try {
    const attempt = attemptOf(await readRuntime(context.root), selected.attempt)
    const current = await checkWorker(context, group, attempt)
    if (current.workerCommit !== selected.commit) fail('제출 이후 워커가 바뀌었습니다. 다시 submit하세요.')
    // Review a frozen checkout, independently of the worker's next assignment.
    await git(context.cwd, ['worktree', 'add', '--detach', workspace, selected.commit])
    return selected
  } catch (error) {
    await transaction(context.root, (live) => {
      const entry = attemptOf(live, selected.attempt)
      if (entry.review?.id !== id) return
      invalidateReview(entry, error.message)
      entry.status = 'blocked'; entry.reason = error.message
    })
    throw error
  }
}

function findReview(state, id) {
  const attempt = Object.values(state.attempts).find((entry) => entry.review?.id === id)
  if (!attempt || attempt.status !== 'reviewing' || attempt.review.status !== 'reviewing') fail('현재 선점된 리뷰 ID가 아닙니다. 오래된 리뷰 결과는 제출할 수 없습니다.')
  return attempt
}

export async function updateReview(options) {
  const context = await repository(options)
  return transaction(context.root, (state) => {
    const attempt = findReview(state, options.review)
    attempt.review.heartbeatAt = now()
    return attempt.review
  })
}

export async function releaseReview(options) {
  const context = await repository(options)
  return transaction(context.root, (state) => {
    const attempt = findReview(state, options.review)
    notIntegrating(groupOf(state, attempt.group), attempt)
    invalidateReview(attempt, options.reason ?? 'explicit review release; reviewer stopped')
    attempt.status = 'ready'
    return attempt
  })
}

function validateResult(result) {
  if (!result || !['approved', 'changes_requested'].includes(result.verdict) || typeof result.summary !== 'string' || !result.summary.trim() || !Array.isArray(result.findings)) {
    fail('리뷰 결과에는 verdict(approved|changes_requested), summary, findings 배열이 필요합니다.')
  }
  for (const finding of result.findings) {
    if (!finding || !['P1', 'P2', 'P3'].includes(finding.priority) || typeof finding.where !== 'string' || !finding.where.trim() || typeof finding.message !== 'string' || !finding.message.trim()) fail('finding에는 priority(P1|P2|P3), where, message가 필요합니다.')
  }
  if (result.verdict === 'approved' && result.findings.some((entry) => ['P1', 'P2'].includes(entry.priority))) fail('P1/P2 finding이 있으면 changes_requested로 제출하세요.')
  if (result.verdict === 'changes_requested' && !result.findings.length) fail('수정 요청에는 적어도 하나의 finding이 필요합니다.')
}

export async function finishReview(options) {
  const result = options.result ?? JSON.parse(await readFile(options.resultFile, 'utf8'))
  validateResult(result)
  const context = await repository(options)
  const initial = await readRuntime(context.root)
  const attempt = findReview(initial, options.review)
  const group = groupOf(initial, attempt.group)
  const review = attempt.review
  try {
    await requireClean(review.workspace)
    if (await head(review.workspace) !== review.commit) fail('리뷰 작업 공간의 커밋이 바뀌었습니다.')
    const current = await checkWorker(context, group, attempt)
    if (current.workerCommit !== review.commit || !(await approvalHolds(context.cwd, review, current.commit))) fail('리뷰 중 제출 커밋 또는 겹치는 상위 변경이 바뀌었습니다.')
    return await transaction(context.root, async (state) => {
      const entry = findReview(state, options.review)
      notIntegrating(groupOf(state, group.id), entry)
      if (entry.submissionId !== review.submissionId || entry.verifiedCommit !== review.commit ||
          !(await approvalHolds(context.cwd, review, await head(context.cwd, `refs/heads/${group.branch}`))) || await head(entry.workspace) !== review.commit) fail('리뷰 결과의 기준 버전이 바뀌었습니다.')
      Object.assign(entry.review, { verdict: result.verdict, summary: result.summary, findings: result.findings, status: result.verdict, finishedAt: now() })
      entry.status = result.verdict
      entry.reason = result.verdict === 'changes_requested' ? result.summary : null
      return entry
    })
  } catch (error) {
    // Preserve findings as evidence, but never grant approval for a stale snapshot.
    await transaction(context.root, (state) => {
      const entry = attemptOf(state, attempt.id)
      if (entry.review?.id !== review.id || entry.status !== 'reviewing') return
      Object.assign(entry.review, { rejectedResult: result })
      invalidateReview(entry, error.message)
      entry.status = 'ready'
      entry.reason = error.message
    })
    throw error
  }
}

// context: the caller's repository() for this same assignment (the runner's slot pass), else a new one.
export async function resumeWork(options, context = null) {
  if (!options.owner?.trim()) fail('resume에는 --owner가 필요합니다.')
  context ??= await repository(options)
  return transaction(context.root, (state) => {
    const group = groupOf(state, options.work)
    const attempts = Object.values(state.attempts).filter((entry) => entry.group === group.id)
    if (attempts.filter(workerBusy).length >= workLimits(group.limits).workers) return { idle: true, reason: 'worker-capacity' }
    if (attempts.some((entry) => workerBusy(entry) && entry.owner === options.owner)) return { idle: true, reason: 'owner-busy' }
    const attempt = attempts.filter((entry) => entry.status === 'changes_requested' && (!options.attempt || entry.id === options.attempt))
      .sort((a, b) => Number(b.owner === options.owner) - Number(a.owner === options.owner) || a.review.finishedAt.localeCompare(b.review.finishedAt))[0]
    if (!attempt) return { idle: true, reason: 'no-corrections' }
    attempt.correction = structuredClone(attempt.review)
    invalidateReview(attempt, 'correction assigned')
    attempt.contributors = [...new Set([...(attempt.contributors ?? [attempt.owner]), options.owner])]
    Object.assign(attempt, { status: 'doing', owner: options.owner, heartbeatAt: now() })
    delete attempt.verifiedCommit
    return attempt
  })
}
