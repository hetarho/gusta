// The solo task lifecycle, written by the CLI instead of hand-edited STATE and task files:
// start = todo → doing@date.tag (task file, STATE row, this session's active row);
// done = done@date, archive into tasks/done/, STATE row out, next and log updated.
// The model still writes acceptance checks and result; the caller commits (like vibe beat).
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { readTaskBoard } from './task-board.mjs'
import { git } from './workspace.mjs'
import { sections, openChecks, resultLines, yymmdd, INBOX_LINE, SESSION_TAG, TASK_ID } from './spec-format.mjs'
import { activeRows, upsertActive, taskRow, setTaskSt, closeTasks } from './state-doc.mjs'
import { withSt, withResultLine, archiveTaskFile } from './task-doc.mjs'
import { SkillPackageError } from './errors.mjs'

const fail = (message, details = []) => { throw new SkillPackageError(message, details) }
const STATE = 'spec/STATE.md'
const NEXT_LIMIT = 3
// next lines this command writes, replaced on its next run — in any wording it has used (e.g. the
// older `plan next with ideation or gusta-create-task`), so existing STATE files regenerate cleanly.
const GENERATED_NEXT = /^- (gusta-implement-task T\d{3,}( T\d{3,})*|no runnable task\b.*)$/
// result lines still holding the template text (`at` is fine when --at replaces it).
const UNFILLED = /^- (outcome|at|verified|limits): <[^>]*>$/

export async function vibeTask(options = {}, { now = () => new Date() } = {}) {
  if (!['start', 'done'].includes(options.step) || !TASK_ID.test(options.task ?? '')) fail('vibe task start T### --tag <tag> | vibe task done T### --tag <tag> [--at <sha>] [--force-other]')
  const board = await readTaskBoard({ targetRoot: options.targetRoot })
  const root = board.root
  const state = await readFile(path.join(root, STATE), 'utf8').catch((error) => {
    if (error.code === 'ENOENT') fail('spec/STATE.md가 없습니다.')
    throw error
  })
  const context = { options, board, root, state, id: options.task, date: yymmdd(now()) }
  return options.step === 'start' ? start(context) : done(context)
}

async function start({ options, board, root, state, id, date }) {
  const { tag } = options
  if (!SESSION_TAG.test(tag ?? '')) fail('--tag에는 영숫자 2-8자의 세션 tag가 필요합니다.')
  const task = board.tasks.find((entry) => entry.id === id)
  if (!task) fail(board.doneIds.includes(id) ? '이미 완료된 태스크입니다.' : 'tasks/에 그 태스크 파일이 없습니다.', [id])
  const row = taskRow(state, id)
  if (!row) fail('STATE tasks 표에 그 태스크 행이 없습니다.', [id])
  // A claim (vibe claim) may already hold the row; it keeps its date.
  const own = (st) => new RegExp(`^doing@\\d{6}\\.${tag}$`).test(st ?? '')
  const mine = [row.st, task.st].find(own)
  if (![task.st, row.st].every((st) => st === 'todo' || own(st))) fail('todo가 아니거나 다른 세션이 선점한 태스크입니다.', [id, `file ${task.st}`, `STATE ${row.st}`])
  if (task.waitingOn.length) fail('끝나지 않은 dep이 있습니다.', task.waitingOn)
  const st = mine ?? `doing@${date}.${tag}`
  const files = []
  if (task.st !== st) {
    await writeFile(path.join(root, task.file), withSt(await readFile(path.join(root, task.file), 'utf8'), st))
    files.push(task.file)
  }
  let text = row.st === st ? state : setTaskSt(state, id, st)
  const session = activeRows(text).find((entry) => entry.tag === tag)
  if (session && session.doing !== id) text = upsertActive(text, { ...session, doing: id })
  if (text !== state) {
    await writeFile(path.join(root, STATE), text)
    files.push(STATE)
  }
  return { schemaVersion: 1, task: id, st, changed: files.length > 0, files }
}

async function done({ options, board, root, state, id, date }) {
  const task = board.tasks.find((entry) => entry.id === id)
  if (!task) {
    if (board.doneIds.includes(id) && !taskRow(state, id)) return { schemaVersion: 1, task: id, st: 'done', changed: false, files: [] }
    fail('tasks/에 그 태스크 파일이 없습니다.', [id])
  }
  if (!task.st?.startsWith('doing@')) fail('doing 태스크만 완료합니다 — 먼저 vibe task start.', [id, task.st])
  // Another session's task closes only on the user's instruction.
  if (!options.forceOther) {
    if (!SESSION_TAG.test(options.tag ?? '')) fail('--tag에는 선점한 세션 tag가 필요합니다.')
    if (task.st.split('.')[1] !== options.tag) fail('다른 세션이 선점한 태스크입니다 — 사용자가 지시했을 때만 --force-other.', [id, task.st])
  }
  if (!taskRow(state, id)) fail('STATE tasks 표에 그 태스크 행이 없습니다.', [id])
  let content = await readFile(path.join(root, task.file), 'utf8')
  // The result is judged as the model wrote it: the `at` line --at writes proves nothing.
  const filled = resultLines(content).filter((line) => !line.startsWith('- at:'))
  const unfilled = (sections(content).get('result') ?? []).map((line) => line.trim()).filter((line) => UNFILLED.test(line) && !(options.at !== undefined && line.startsWith('- at:')))
  const problems = [...openChecks(content).map((line) => `acceptance ${line}`), ...(filled.length ? [] : ['result: empty']), ...unfilled.map((line) => `result ${line}`)]
  if (problems.length) fail('acceptance를 모두 체크하고 result를 채운 뒤 다시 실행하세요.', problems)
  if (options.at !== undefined) content = withResultLine(content, 'at', await commitOf(root, options.at))
  const archived = await archiveTaskFile(root, task.file, withSt(content, `done@${date}`))
  const parked = new Set((sections(state).get('inbox') ?? []).map((line) => line.trim().match(INBOX_LINE))
    .filter((entry) => entry?.[2] === 'parked').flatMap((entry) => entry[3].split(/\s+/)))
  const runnable = board.tasks.filter((entry) => entry.id !== id && entry.st === 'todo' && !parked.has(entry.id)
    && entry.waitingOn.every((dep) => dep === id)).map((entry) => entry.id)
  const remaining = board.tasks.length - 1
  const next = (lines) => {
    const kept = lines.filter((line) => !GENERATED_NEXT.test(line) && !new RegExp(`\\b${id}\\b`).test(line))
    const lead = runnable.length ? `- gusta-implement-task ${runnable.slice(0, NEXT_LIMIT).join(' ')}` : remaining ? '- no runnable task: resolve blocked, parked or deps' : null
    const result = [lead, ...kept].filter(Boolean).slice(0, NEXT_LIMIT)
    return result.length ? result : ['- no runnable task: plan next with gusta-sketch']
  }
  const closed = closeTasks(state, [id], { log: `- ${date} ${id} done`, next })
  await writeFile(path.join(root, STATE), closed.text)
  return { schemaVersion: 1, task: id, st: `done@${date}`, changed: true, files: [task.file, archived, STATE], runnable, next: sections(closed.text).get('next').filter((line) => line.startsWith('- ')) }
}

// `--at` takes a SHA, `-` or any ref this checkout resolves.
async function commitOf(root, at) {
  if (at === '-' || /^[0-9a-f]{7,64}$/.test(at)) return at
  const resolved = await git(root, ['rev-parse', '--verify', '--quiet', `${at}^{commit}`], [1]).catch(() => null)
  if (!resolved?.trim()) fail('--at은 커밋 SHA, - 또는 이 checkout의 ref입니다.', [at])
  return resolved.trim()
}
