import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { inspectWorkspace, git, showMany } from './workspace.mjs'
import { quoteLine, quoteFields, sections, tableRows, splitRefs, TASK_ID, TASK_ST, EXPLORE, exploreValue } from './spec-format.mjs'
import { touchesErrors } from './work-policy.mjs'
import { dependencyErrors, laneErrors, laneValue } from './task-graph.mjs'

async function optionalRead(file) {
  try { return await readFile(file, 'utf8') } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

async function taskFiles(directory, errors, optional = false) {
  try {
    const entries = await readdir(directory, { withFileTypes: true })
    const files = []
    for (const entry of entries) {
      if (!entry.name.endsWith('.md')) continue
      if (!entry.isFile() || !/^(T\d{3,})\.[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.test(entry.name)) {
        errors.push(`${directory}/${entry.name}: 일반 파일 T###.<slug>.md가 필요합니다.`)
      } else files.push(entry.name)
    }
    return files.sort()
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    if (!optional) errors.push(`${directory}가 없습니다 — create-architecture로 부트스트랩하세요.`)
    return []
  }
}

// options.workspace: the caller's own inspection of targetRoot, made in the same operation.
export async function readTaskBoard(options = {}) {
  const workspace = options.workspace ?? await inspectWorkspace(options)
  const root = workspace.git?.root ?? workspace.targetRoot
  const errors = []
  const warnings = [...workspace.warnings]
  const tasksRoot = path.join(root, 'spec', 'tasks')
  const commit = options.ref ? (await git(root, ['rev-parse', '--verify', '--end-of-options', `${options.ref}^{commit}`])).trim() : null
  // One listing for spec/tasks and spec/tasks/done: the direct entries of each, as `ls-tree <commit>:<dir>` gives them.
  const listing = commit ? (await git(root, ['ls-tree', '-r', '-t', '--name-only', '-z', `${commit}:spec/tasks`], [128]))?.split('\0').filter(Boolean) ?? [] : null
  const files = commit ? listing.filter((name) => !name.includes('/') && name.endsWith('.md')) : await taskFiles(tasksRoot, errors)
  const archive = commit ? listing.filter((name) => /^done\/[^/]+$/.test(name)).map((name) => name.slice(5)).filter((name) => name.endsWith('.md')) : await taskFiles(path.join(tasksRoot, 'done'), errors, true)
  // Every task file and STATE at the commit in one batch; a working tree is read file by file.
  const wanted = [...files.map((file) => `spec/tasks/${file}`), 'spec/STATE.md']
  const committed = commit ? new Map((await showMany(root, wanted.map((file) => `${commit}:${file}`))).map((content, index) => [wanted[index], content])) : null
  const read = async (relative) => commit ? committed.get(relative) : optionalRead(path.join(root, relative))
  for (const file of [...files, ...archive]) {
    if (!/^T\d{3,}\.[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.test(file)) errors.push(`태스크 파일명 형식 오류: ${file}`)
  }
  const doneIds = new Set()
  for (const file of archive) {
    const id = file.split('.')[0]
    if (doneIds.has(id)) errors.push(`완료 태스크 파일 중복: ${id}`)
    doneIds.add(id)
  }
  const tasks = []
  const graph = new Map()
  const lanes = new Map()
  for (const file of files) {
    const id = file.split('.')[0]
    const content = await read(`spec/tasks/${file}`) ?? ''
    const fields = quoteFields(quoteLine(content) ?? '')
    const title = content.match(/^# (T\d{3,}) (.+)$/m)
    if (!title || title[1] !== id) errors.push(`${file}: 제목의 task ID가 파일명과 다릅니다.`)
    for (const key of ['st', 'ssot', 'base', 'dep']) {
      if (!fields.get(key)) errors.push(`${file}: 인용줄에 ${key}: 값이 없습니다.`)
    }
    const st = fields.get('st') ?? null
    if (!TASK_ST.test(st ?? '')) errors.push(`${file}: st 형식 오류: ${st}`)
    if (st?.startsWith('done@')) errors.push(`${file}: 완료 태스크는 tasks/done/으로 아카이브하세요.`)
    if (graph.has(id)) errors.push(`태스크 파일 중복: ${id}`)
    if (doneIds.has(id)) errors.push(`${id}: tasks/와 tasks/done/에 파일이 모두 있습니다.`)
    for (const value of touchesErrors(fields.get('touches'))) errors.push(`${file}: touches 경로 형식 오류: ${value}`)
    const explore = exploreValue(fields.get('explore'))
    if (explore && !EXPLORE.test(explore)) errors.push(`${file}: explore 형식 오류: ${explore}`)
    const deps = splitRefs(fields.get('dep'))
    const lane = laneValue(fields.get('lane'))
    graph.set(id, deps)
    lanes.set(id, lane)
    tasks.push({ id, title: title?.[2] ?? id, file: `spec/tasks/${file}`, st,
      ssot: splitRefs(fields.get('ssot')), base: splitRefs(fields.get('base')),
      touches: splitRefs(fields.get('touches')), lane, explore, deps, waitingOn: deps.filter((dep) => !doneIds.has(dep)), dependencyReady: false,
    })
  }
  errors.push(...dependencyErrors(graph, doneIds))
  errors.push(...laneErrors(lanes, graph))
  const state = await read('spec/STATE.md')
  if (state === null) warnings.push('spec/STATE.md가 없습니다. 태스크 파일만 표시합니다.')
  else {
    const rows = tableRows(sections(state).get('tasks'))
    const rowsById = new Map()
    for (const row of rows) {
      if (!TASK_ID.test(row[0] ?? '')) warnings.push(`STATE tasks ID 형식 오류: ${row[0]}`)
      if (rowsById.has(row[0])) warnings.push(`STATE tasks 행 중복: ${row[0]}`)
      rowsById.set(row[0], row)
    }
    for (const task of tasks) {
      const row = rowsById.get(task.id)
      if (!row) warnings.push(`${task.id}: STATE tasks 표에 없습니다.`)
      else {
        if (row[4] !== task.st) warnings.push(`${task.id}: 파일 st(${task.st})와 STATE st(${row[4]})가 다릅니다.`)
        if ([...new Set(splitRefs(row[3]))].sort().join(' ') !== [...new Set(task.deps)].sort().join(' ')) {
          warnings.push(`${task.id}: 파일 dep과 STATE dep이 다릅니다.`)
        }
      }
    }
    for (const id of rowsById.keys()) {
      if (!graph.has(id)) warnings.push(`${id}: STATE tasks 행에 대응하는 활성 파일이 없습니다.`)
    }
  }
  // This is only a dependency view. It never grants a claim, validates SSOT,
  // or proves that another branch has been integrated.
  for (const task of tasks) {
    task.dependencyReady = errors.length === 0 && task.st === 'todo' && task.waitingOn.length === 0
  }
  return {
    schemaVersion: 1, scope: commit ? 'commit' : 'checkout', commit, root, workspace,
    ok: errors.length === 0, tasks, doneIds: [...doneIds].sort(), errors, warnings,
  }
}
