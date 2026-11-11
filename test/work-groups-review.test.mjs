import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { startWork, claimWork, claimNextWork, inspectWork, updateWork, submitWork, integrateWork, workBoard } from '../src/work-groups.mjs'
import { nextWork, claimReviewWaiting } from '../src/work-wait.mjs'
import { claimReview, finishReview, releaseReview, resumeWork } from '../src/work-review.mjs'
import { execute, cli, commit, checkFile, checks, fixture, implement, approve, ready, expandTasks } from './helpers/work-fixture.mjs'

test('50개 대기 태스크에서 4개 프로세스가 중복 없이 선점하고 worker 한도를 지킨다', async (t) => {
  const setup = await fixture(t)
  await expandTasks(setup, 50)
  await startWork({ ...setup, name: 'fifty' })
  const calls = Array.from({ length: 5 }, (_, index) => execute(process.execPath, [cli, 'work', 'claim-next', '--work', 'fifty', '--owner', `worker-${index}`, '--target', setup.root, '--json'], { encoding: 'utf8' }))
  const results = (await Promise.all(calls)).map(({ stdout }) => JSON.parse(stdout))
  const claims = results.filter((entry) => entry.id)
  assert.equal(claims.length, 4)
  assert.equal(new Set(claims.map((entry) => entry.taskId)).size, 4)
  assert.ok(claims.some((entry) => entry.taskId === 'T001'))
  assert.ok(!claims.some((entry) => entry.taskId === 'T003'))
  assert.equal(results.find((entry) => entry.idle).reason, 'worker-capacity')
})

test('next는 의존 태스크를 많이 여는 일을 우선하고 touches 충돌을 직렬화한다', async (t) => {
  const setup = await fixture(t)
  for (const file of ['T001.first.md', 'T002.second.md']) {
    const target = path.join(setup.root, 'spec/tasks', file)
    await writeFile(target, (await readFile(target, 'utf8')).replace('dep:-', `dep:- | touches:${file.startsWith('T001') ? 'src/auth/' : 'src/auth/login.mjs'}`))
  }
  await commit(setup.root)
  await startWork({ ...setup, name: 'touches' })
  const first = await claimNextWork({ ...setup, work: 'touches', owner: 'a' })
  assert.equal(first.taskId, 'T001')
  assert.equal((await claimNextWork({ ...setup, work: 'touches', owner: 'b' })).reason, 'no-eligible-task')
  assert.equal((await workBoard({ ...setup, work: 'touches' })).tasks.find((entry) => entry.id === 'T002').claimable, false)
})

test('리뷰 대기 상한은 신규 선점을 멈추며 완료 검증만으로 통합할 수 없다', async (t) => {
  const setup = await fixture(t)
  await startWork({ ...setup, name: 'pressure', maxPending: 1 })
  const attempt = await claimNextWork({ ...setup, work: 'pressure', owner: 'worker' })
  await implement(attempt)
  await submitWork({ ...setup, attempt: attempt.id, verify: checks })
  assert.equal((await claimNextWork({ ...setup, work: 'pressure', owner: 'other' })).reason, 'review-backpressure')
  await assert.rejects(integrateWork({ ...setup, attempt: attempt.id, verify: checks }), /상태|승인/)
  assert.equal((await claimReview({ ...setup, work: 'pressure', owner: 'worker' })).idle, true)
})

test('리뷰 선점은 하나만 성공하고 수정 요청은 신규 작업보다 먼저 재배정된다', async (t) => {
  const setup = await fixture(t)
  await startWork({ ...setup, name: 'review-race' })
  const attempt = await claimNextWork({ ...setup, work: 'review-race', owner: 'a' })
  await implement(attempt)
  await submitWork({ ...setup, attempt: attempt.id, verify: checks })
  const calls = ['r1', 'r2'].map((owner) => execute(process.execPath, [cli, 'work', 'review-claim', '--work', 'review-race', '--owner', owner, '--target', setup.root, '--json'], { encoding: 'utf8' }))
  const results = (await Promise.all(calls)).map(({ stdout }) => JSON.parse(stdout))
  const review = results.find((entry) => entry.id)
  assert.equal(results.filter((entry) => entry.id).length, 1)
  await assert.rejects(updateWork({ ...setup, attempt: attempt.id, status: 'doing' }), /갱신/)
  await assert.rejects(finishReview({ ...setup, review: review.id, result: { verdict: 'approved', summary: 'bad', findings: [{ priority: 'P1', where: 'one.txt:1', message: 'broken' }] } }), /P1/)
  await finishReview({ ...setup, review: review.id, result: { verdict: 'changes_requested', summary: 'fix outcome', findings: [{ priority: 'P2', where: 'one.txt:1', message: 'missing edge case' }] } })
  assert.match((await claimNextWork({ ...setup, work: 'review-race', owner: 'b' })).reason, /changes-requested/)
  const resumed = await resumeWork({ ...setup, work: 'review-race', owner: 'b' })
  assert.equal(resumed.id, attempt.id)
  assert.equal(resumed.correction.findings[0].message, 'missing edge case')
  assert.equal(resumed.verifiedCommit, undefined)
  await assert.rejects(finishReview({ ...setup, review: review.id, result: { verdict: 'approved', summary: 'old reply', findings: [] } }), /오래된/)
  await writeFile(path.join(attempt.workspace, 'one.txt'), 'fixed\n')
  const changed = await commit(attempt.workspace)
  await submitWork({ ...setup, attempt: attempt.id, verify: checks })
  const approved = await approve(setup, attempt)
  assert.equal(approved.review.commit, changed)
  await integrateWork({ ...setup, attempt: attempt.id, verify: checks })
})

test('제출 이후 변경과 리뷰 이후 겹치는 상위 변경은 승인을 무효화한다', async (t) => {
  const setup = await ready(t)
  await writeFile(path.join(setup.attempt.workspace, 'one.txt'), 'changed\n')
  await commit(setup.attempt.workspace)
  await assert.rejects(integrateWork({ ...setup, attempt: setup.attempt.id, verify: checks }), /통합을 완료하지/)
  assert.equal((await inspectWork(setup)).attempts[0].status, 'blocked')
  await submitWork({ ...setup, attempt: setup.attempt.id, verify: checks })
  await approve(setup, setup.attempt)
  // The base adds the same file with the worker's content, so the later merge stays clean.
  await writeFile(path.join(setup.group.path, 'one.txt'), 'changed\n')
  await commit(setup.group.path, 'base touches the submission')
  await assert.rejects(integrateWork({ ...setup, attempt: setup.attempt.id, verify: checks }), /통합을 완료하지/)
  const entry = (await inspectWork(setup)).attempts[0]
  assert.equal(entry.status, 'ready')
  assert.equal(entry.review, undefined)
  await approve(setup, setup.attempt)
  await integrateWork({ ...setup, attempt: setup.attempt.id, verify: checks })
})

test('리뷰 중 변경된 기준과 해제한 review ID로는 승인할 수 없다', async (t) => {
  const setup = await ready(t)
  await submitWork({ ...setup, attempt: setup.attempt.id, verify: checks })
  let review = await claimReview({ ...setup, work: 'feature', attempt: setup.attempt.id, owner: 'r' })
  await releaseReview({ ...setup, review: review.id })
  await assert.rejects(finishReview({ ...setup, review: review.id, result: { verdict: 'approved', summary: 'late', findings: [] } }), /오래된/)
  review = await claimReview({ ...setup, work: 'feature', attempt: setup.attempt.id, owner: 'r' })
  await writeFile(path.join(setup.group.path, 'one.txt'), 'result\n')
  await commit(setup.group.path, 'overlapping base')
  await assert.rejects(finishReview({ ...setup, review: review.id, result: { verdict: 'approved', summary: 'stale', findings: [] } }), /바뀌었/)
  assert.equal((await inspectWork(setup)).attempts[0].status, 'ready')
})

test('겹치지 않는 상위 변경은 승인과 리뷰를 유지한 채 통합한다', async (t) => {
  const setup = await ready(t)
  const review = (await inspectWork(setup)).attempts[0].review
  await writeFile(path.join(setup.group.path, 'unrelated.txt'), 'other unit\n')
  await commit(setup.group.path, 'another unit integrated')
  assert.equal((await claimReview({ ...setup, work: 'feature', owner: 'r2' })).idle, true)
  assert.equal((await inspectWork(setup)).attempts[0].status, 'approved')
  const integrated = await integrateWork({ ...setup, attempt: setup.attempt.id, verify: [...checks, checkFile('unrelated.txt')] })
  assert.equal(integrated.status, 'integrated')
  assert.equal(integrated.review.id, review.id)
  assert.equal(integrated.reviewHistory, undefined)
})

test('리뷰 결과의 추가 필드로 고정된 커밋과 ID를 덮어쓸 수 없다', async (t) => {
  const setup = await ready(t)
  await submitWork({ ...setup, attempt: setup.attempt.id, verify: checks })
  const review = await claimReview({ ...setup, work: 'feature', attempt: setup.attempt.id, owner: 'r' })
  assert.equal((await inspectWork({ targetRoot: review.workspace })).mode, 'reviewer')
  const result = await finishReview({ ...setup, review: review.id, result: { verdict: 'approved', summary: 'reviewed', findings: [], id: 'injected', commit: 'wrong', baseCommit: 'wrong', submissionId: 'wrong' } })
  assert.equal(result.review.id, review.id)
  assert.equal(result.review.commit, review.commit)
  assert.equal(result.review.baseCommit, review.baseCommit)
})

test('손상된 touches 경로와 비정상 slot 설정은 배정 전에 거부한다', async (t) => {
  const setup = await fixture(t)
  await assert.rejects(startWork({ ...setup, name: 'bad', workers: 0 }), /정수/)
  const file = path.join(setup.root, 'spec/tasks/T001.first.md')
  await writeFile(file, (await readFile(file, 'utf8')).replace('dep:-', 'dep:- | touches:../outside'))
  await commit(setup.root)
  await startWork({ ...setup, name: 'bad-path' })
  await assert.rejects(claimNextWork({ ...setup, work: 'bad-path', owner: 'a' }), /태스크\/STATE/)
})

test('blocked만 남으면 next는 stalled, review-claim --wait는 제출을 기다렸다 선점한다', async (t) => {
  const setup = await fixture(t)
  const group = await startWork({ ...setup, name: 'waiting' })
  const a = await claimWork({ ...setup, work: group.id, task: 'T001', owner: 'a' })
  const b = await claimWork({ ...setup, work: group.id, task: 'T002', owner: 'b' })
  const idle = await nextWork({ ...setup, work: group.id, owner: 'c' })
  assert.deepEqual([idle.action, idle.reason], ['wait', 'no-eligible-task'])
  const waitingReviewer = claimReviewWaiting({ ...setup, work: group.id, owner: 'r', wait: 60, pollMs: 50 })
  await implement(a)
  await submitWork({ ...setup, attempt: a.id, verify: checks })
  assert.equal((await waitingReviewer).attempt, a.id)
  await updateWork({ ...setup, attempt: b.id, status: 'blocked', reason: 'needs decision' })
  await releaseReview({ ...setup, review: (await inspectWork(setup)).attempts.find((entry) => entry.id === a.id).review.id })
  await updateWork({ ...setup, attempt: a.id, status: 'blocked', reason: 'needs decision' })
  const stalled = await nextWork({ ...setup, work: group.id, owner: 'd', wait: 60, pollMs: 50 })
  assert.equal(stalled.action, 'stalled')
  assert.deepEqual(stalled.blocked.map((entry) => entry.tasks).sort(), [['T001'], ['T002']])
  const own = await nextWork({ ...setup, work: group.id, owner: 'b' })
  assert.deepEqual([own.action, own.attempt.id], ['blocked', b.id])
})

test('백그라운드 통합이 실패하면 단위 소유자에게 수정 요청으로 돌아간다', async (t) => {
  const setup = await fixture(t)
  const group = await startWork({ ...setup, name: 'auto-correct', verify: [checkFile('never.txt')] })
  const attempt = await claimWork({ ...setup, work: group.id, task: 'T001', owner: 'a' })
  await implement(attempt)
  await submitWork({ ...setup, attempt: attempt.id })
  await approve(setup, attempt)
  await assert.rejects(integrateWork({ ...setup, attempt: attempt.id, autoCorrect: true }), /통합을 완료하지/)
  const next = await nextWork({ ...setup, work: group.id, owner: 'a' })
  assert.deepEqual([next.action, next.attempt.id, next.attempt.correction.findings[0].where], ['implement', attempt.id, 'integration'])
  assert.match(next.attempt.correction.findings[0].message, /never\.txt/)
})
