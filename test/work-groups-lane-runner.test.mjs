import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { startWork, workBoard } from '../src/work-groups.mjs'
import { runWork } from '../src/work-runner.mjs'
import { checkFile, laneFixture, laneAdapter } from './helpers/work-fixture.mjs'

test('실행기는 lane 태스크를 같은 공간에 차례로 배정하고 묶음 완료 검증을 한 번 실행한다', async (t) => {
  const setup = await laneFixture(t, [['T001', '-', '-'], ['T002', 'T001', 'a'], ['T003', 'T002', 'a'], ['T004', 'T001', 'b'], ['T005', 'T004', 'b'], ['T006', 'T003 T005', '-']])
  const group = await startWork({ ...setup, name: 'lane-runner' })
  const log = path.join(setup.temporary, 'dispatch.log')
  const runner = await laneAdapter(setup, log)
  const bases = path.join(setup.temporary, 'bases.log')
  const record = `node -e "require('fs').appendFileSync('${bases}', process.env.GUSTA_TASK + ' ' + process.env.GUSTA_DIFF_BASE + String.fromCharCode(10))"`
  const result = await runWork({ ...setup, work: group.id, ...runner,
    taskVerify: [checkFile('spec/STATE.md'), record], verify: [checkFile('spec/ssot/ARCH.md')], groupVerify: [checkFile('T006.txt')] })
  assert.equal(result.outcome, 'completed', JSON.stringify(result))
  assert.deepEqual(result.failures, [])
  assert.deepEqual(result.attempts.map((entry) => entry.status), ['integrated', 'integrated', 'integrated', 'integrated'])
  const jobs = (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
  const workers = jobs.filter((job) => job.role === 'worker')
  assert.deepEqual(workers.map((job) => job.taskId).sort(), ['T001', 'T002', 'T003', 'T004', 'T005', 'T006'])
  assert.equal(jobs.filter((job) => job.role === 'reviewer').length, 4)
  const where = Object.fromEntries(workers.map((job) => [job.taskId, job.workspace]))
  assert.equal(where.T002, where.T003)
  assert.equal(where.T004, where.T005)
  assert.notEqual(where.T002, where.T004)
  assert.deepEqual(workers.find((job) => job.taskId === 'T003').tasks, ['T002', 'T003'])
  assert.ok(result.finish.commit)
  const board = await workBoard({ ...setup, work: group.id })
  assert.equal(board.verified.current, true)
  // Each lane step's checks see only that task's changes.
  const laneA = board.attempts.find((entry) => entry.lane === 'a')
  const stepBase = Object.fromEntries((await readFile(bases, 'utf8')).trim().split('\n').map((line) => line.split(' ')))
  assert.equal(stepBase.T003, laneA.steps.find((entry) => entry.taskId === 'T002').commit)
  assert.match(await readFile(path.join(group.path, 'spec/tasks/done/T003.lane.md'), 'utf8'), /verified: "node -e .*STATE\.md.*"; ".*"; integration "node -e .*ARCH\.md/)
})

test('runner가 lane 중간에 멈추면 다음 runner가 같은 공간에서 이어받는다', async (t) => {
  const setup = await laneFixture(t, [['T001', '-', 'a'], ['T002', 'T001', 'a']])
  const group = await startWork({ ...setup, name: 'lane-resume' })
  const log = path.join(setup.temporary, 'dispatch.log')
  const runner = await laneAdapter(setup, log)
  const stopped = await runWork({ ...setup, work: group.id, ...runner, verify: [checkFile('T001.txt')], maxDispatches: 1 })
  assert.equal(stopped.outcome, 'dispatch-limit')
  assert.deepEqual(stopped.attempts.map(({ taskId, status }) => [taskId, status]), [['T002', 'doing']])
  const resumed = await runWork({ ...setup, work: group.id, ...runner, verify: [checkFile('T001.txt'), checkFile('T002.txt')] })
  assert.equal(resumed.outcome, 'completed', JSON.stringify(resumed))
  assert.deepEqual(resumed.attempts.map((entry) => entry.status), ['integrated'])
  const workers = (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line)).filter((job) => job.role === 'worker')
  assert.deepEqual(workers.map((job) => job.taskId), ['T001', 'T002'])
  assert.equal(workers[0].workspace, workers[1].workspace)
})
