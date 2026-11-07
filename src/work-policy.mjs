import { SkillPackageError } from './errors.mjs'
import { TASK_ID } from './spec-format.mjs'

export function approvedTasks(value) {
  const ids = typeof value === 'string' ? value.trim().split(/\s+/) : value
  if (!Array.isArray(ids) || !ids.length || ids.some((id) => typeof id !== 'string' || !TASK_ID.test(id)) || new Set(ids).size !== ids.length) throw new SkillPackageError('tasks: 중복 없는 태스크 ID 목록이 필요합니다.')
  return [...ids]
}

export function scopedBoard(board, group) {
  if (group.taskScope === undefined) return board
  const ids = new Set(approvedTasks(group.taskScope))
  const known = new Set([...board.tasks.map((task) => task.id), ...board.doneIds])
  const missing = [...ids].filter((id) => !known.has(id))
  if (missing.length) throw new SkillPackageError('승인 범위의 태스크가 없습니다.', missing)
  const lanes = new Set(board.tasks.filter((task) => ids.has(task.id) && task.lane).map((task) => task.lane))
  if (board.tasks.some((task) => lanes.has(task.lane) && !ids.has(task.id))) throw new SkillPackageError('같은 lane의 태스크는 함께 승인 범위에 포함해야 합니다.')
  return { ...board, tasks: board.tasks.filter((task) => ids.has(task.id)),
    excludedTasks: [...new Set([...(board.excludedTasks ?? []), ...board.tasks.filter((task) => !ids.has(task.id)).map((task) => task.id)])] }
}

export const activeAttempt = (attempt) => !['released', 'failed', 'integrated'].includes(attempt.status)
export const workerBusy = (attempt) => ['preparing', 'doing', 'committing', 'verifying'].includes(attempt.status)
export const pendingReview = (attempt) => ['ready', 'reviewing', 'approved', 'integrating'].includes(attempt.status)

export function workLimits(options = {}) {
  const limits = {}
  for (const [key, fallback] of [['workers', 4], ['reviewers', 1], ['maxPending', 8]]) {
    const value = Number(options[key] ?? fallback)
    if (!Number.isSafeInteger(value) || value < 1 || value > 100) throw new SkillPackageError(`${key}: 1~100 사이 정수가 필요합니다.`)
    limits[key] = value
  }
  return limits
}

export function invalidateReview(attempt, reason) {
  if (attempt.review) {
    attempt.reviewHistory = [...(attempt.reviewHistory ?? []), { ...attempt.review, invalidatedAt: new Date().toISOString(), invalidationReason: reason }]
    delete attempt.review
  }
}

// Paths are repo-relative literals, not shell globs. Directory prefixes overlap.
export function touchesErrors(value) {
  if (!value || value === '-') return []
  return value.split(/\s+/).filter((item) => item.startsWith('/') || item.includes('\\') || /[*?\[\]:]/.test(item) || item.split('/').some((part, i, all) => part === '..' || part === '.' || (!part && i !== all.length - 1)))
}
export function overlaps(left = [], right = []) {
  return left.some((a) => right.some((b) => {
    a = a.replace(/\/$/, ''); b = b.replace(/\/$/, '')
    return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
  }))
}
// Attempts created before lanes carry only taskId.
export const unitTasks = (attempt) => attempt.tasks ?? [attempt.taskId]

// Units that unlock the most outside work go first, then the oldest task ID.
export function rankedUnits(units, tasks) {
  const unlocks = (ids) => {
    const seen = new Set()
    const stack = [...ids]
    while (stack.length) {
      const id = stack.pop()
      for (const task of tasks) if (task.deps.includes(id) && !ids.includes(task.id) && !seen.has(task.id)) { seen.add(task.id); stack.push(task.id) }
    }
    return seen.size
  }
  return units.map((unit) => ({ ...unit, unlocks: unlocks(unit.ids) }))
    .sort((a, b) => b.unlocks - a.unlocks || a.ids[0].localeCompare(b.ids[0], 'en', { numeric: true }))
}
