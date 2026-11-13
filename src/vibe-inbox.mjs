// vibe inbox · vibe log: the owner's inbox and the activity log, written to the coordination
// branch in one call each (no file to edit, nothing for the caller to commit). SESSIONS.md is not
// in the tree, so lint never sees these lines: format and references are checked here, when a
// line is written, against the checkout that writes it. Only a target without Git keeps both in
// STATE: a repository without a commit yet writes the branch too (an orphan needs no HEAD).
import { readFile, writeFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { inspectWorkspace } from './workspace.mjs'
import { sections, tableRows, parseSsot, yymmdd, INBOX_LINE, SESSION_TAG, TASK_ID } from './spec-format.mjs'
import { readSessions, applyEvent, inboxEntries, lineId } from './coord-doc.mjs'
import { vibeSession } from './vibe.mjs'
import { coordWrite, coordView, assertCoordinator, assertSessionTag } from './vibe-coord.mjs'
import { SkillPackageError } from './errors.mjs'

const fail = (message, details = []) => { throw new SkillPackageError(message, details) }
const KINDS = ['decided', 'parked', 'suggest']
const STATE = 'spec/STATE.md'
const USAGE = 'vibe inbox add --kind decided|parked|suggest [--ref <T###|ID-n|review/<slug>|ideation/<slug>> ...] (--text <text> | --file <path>) | vibe inbox resolve (--id <id> ... | --line <line> | --file <path>) [--log <text>] | vibe inbox list [--kind <kind>] [--ref <ref>]'

async function readOptional(file) {
  try { return await readFile(file, 'utf8') } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

// --text, or --file for a body that quotes, pipes or backticks would break on a command line.
async function body(options, name = 'text') {
  if (options[name] !== undefined && options.file !== undefined) fail(`--${name}와 --file은 함께 쓰지 않습니다.`)
  const raw = options.file === undefined ? options[name] : await readFile(path.resolve(options.file), 'utf8').catch((error) => fail('--file을 읽지 못했습니다.', [options.file, error.code ?? error.message]))
  return raw === undefined ? null : `${raw}`.replace(/\r\n/g, '\n').trim()
}
const oneLine = (text, what) => {
  if (!text) fail(`${what} 본문이 비어 있습니다.`)
  if (/\n/.test(text)) fail(`${what}는 한 줄입니다 — 줄바꿈 없이 쓰세요.`, [text.split('\n')[0]])
  return text
}

// A reference names something this checkout has: a decision, a task (open or archived) or a
// review/ideation document. The same rule lint applied to STATE's inbox.
async function missingRefs(root, refs) {
  const names = async (directory) => readdir(path.join(root, 'spec', directory)).catch(() => [])
  const rows = new Set(tableRows(sections((await readOptional(path.join(root, STATE))) ?? '').get('tasks')).map(([id]) => id))
  const problems = []
  for (const ref of refs) {
    const decision = ref.match(/^([A-Z]{2,6})-(\d+)$/)
    const doc = ref.match(/^(review|ideation)\/(.+)$/)
    if (decision) {
      const ssot = await readOptional(path.join(root, 'spec/ssot', `${decision[1]}.md`))
      if (!ssot || !parseSsot(ssot).decisions.has(ref)) problems.push(`${ref}: 이 checkout의 ssot에 없는 결정입니다.`)
    } else if (TASK_ID.test(ref)) {
      if (!rows.has(ref) && ![...await names('tasks'), ...await names('tasks/done')].some((name) => name.startsWith(`${ref}.`))) problems.push(`${ref}: 이 checkout의 tasks 표에도 tasks/·tasks/done/에도 없습니다.`)
    } else if (doc) {
      const files = doc[1] === 'review' ? await names('review') : [...await names('ideation'), ...await names('ideation/done')]
      if (!files.includes(`${doc[2].replace(/^done\//, '')}.md`)) problems.push(`${ref}: 문서가 없습니다.`)
    } else problems.push(`${ref}: 알 수 없는 참조입니다 (<ID>-n|T###|review/<slug>|ideation/<slug>).`)
  }
  return problems
}

// Where the lines go: the coordination branch of a Git repository, else this target's STATE.
async function backend(options, command, injected) {
  const workspace = await inspectWorkspace(options)
  const root = workspace.git?.root ?? workspace.targetRoot
  if (options.tag !== undefined && !SESSION_TAG.test(options.tag)) fail('--tag에는 영숫자 2-8자의 세션 tag가 필요합니다.')
  if (options.tag !== undefined) assertSessionTag(options.tag)
  if (!workspace.git) {
    const file = path.join(root, STATE)
    const text = await readOptional(file)
    if (text === null) fail('spec/STATE.md가 없습니다.')
    return { root, text,
      read: async () => ({ doc: readSessions(text), sessions: readSessions(text), coordination: { backend: 'state' } }),
      write: async (mutate) => {
        const value = mutate(text, { now: `${new Date().toISOString().slice(0, 16)}Z` })
        const changed = value.changed !== false && value.text !== text
        if (changed) await writeFile(file, value.text)
        return { value, changed, coordination: { backend: 'state', changed } }
      } }
  }
  const context = await vibeSession({ ...options, inspection: workspace }, { unborn: true })
  await assertCoordinator(context, command)
  return { root, text: context.state ?? '',
    read: async () => {
      const view = await coordView(context, { fetch: options.fetch !== false, tag: options.tag ?? null, injected })
      if (view.error) fail(view.error)
      return { doc: view.doc, sessions: view.sessions, coordination: { branch: view.branch, legacy: view.legacy, sync: view.sync, push: view.push } }
    },
    write: (mutate, settings) => coordWrite(context, mutate, { tag: options.tag ?? null, injected, ...settings }) }
}

export async function vibeInbox(options = {}, injected = {}) {
  if (!['add', 'resolve', 'list'].includes(options.step)) fail(USAGE)
  const target = await backend(options, 'inbox', injected)
  if (options.step === 'list') {
    if (options.kind !== undefined && !KINDS.includes(options.kind)) fail(`--kind는 ${KINDS.join('|')}입니다.`)
    const { doc, sessions, coordination } = await target.read()
    const refs = [options.ref ?? []].flat()
    const inbox = inboxEntries(doc.inbox).filter((entry) => (!options.kind || entry.kind === options.kind) && refs.every((ref) => entry.refs.includes(ref)))
      // legacy: still only in STATE's old inbox — read here, resolved after gusta migrate moves it.
      .map((entry) => sessions.inbox.some((line) => line.trim() === entry.line) ? entry : { ...entry, legacy: true })
    return { schemaVersion: 1, ok: true, count: inbox.length, inbox, coordination }
  }
  if (options.step === 'add') {
    const whole = options.line?.trim()
    if (whole !== undefined && (options.kind !== undefined || options.ref !== undefined || options.text !== undefined || options.file !== undefined)) fail('--line은 완성된 한 줄입니다 — --kind·--ref·--text·--file과 함께 쓰지 않습니다.')
    const text = whole === undefined ? oneLine(await body(options), 'inbox') : null
    const refs = whole === undefined ? [options.ref ?? []].flat() : (whole.match(INBOX_LINE)?.[3] ?? '').split(/\s+/).filter((ref) => ref && ref !== '-')
    if (whole === undefined && !KINDS.includes(options.kind)) fail(`--kind는 ${KINDS.join('|')}입니다.`, [USAGE])
    if (refs.some((ref) => /[\s:|]/.test(ref) || ref === '-')) fail('--ref에는 참조 하나씩 씁니다(없으면 생략).', refs)
    const problems = await missingRefs(target.root, refs)
    if (problems.length) fail('inbox 참조가 이 checkout에 없습니다. 기록하지 않았습니다.', problems)
    let line = whole
    const written = await target.write((current, { now }) => {
      line = whole ?? `- ${yymmdd(new Date(now))} ${options.kind} ${refs.join(' ') || '-'}: ${text}`
      if (!INBOX_LINE.test(line) || /[\r\n]/.test(line)) fail('inbox 줄 형식 오류 (- YYMMDD decided|parked|suggest <refs>: <text>)', [line])
      return applyEvent(current, { type: 'inbox-add', line })
    }, { message: `gusta${options.tag ? ` ${options.tag}` : ''}: inbox ${options.kind ?? 'line'}` })
    return { schemaVersion: 1, ok: true, added: written.changed, id: lineId(line), line, coordination: written.coordination }
  }
  // resolve: the owner settled these lines — they go, and --log leaves the one line that says so.
  if (options.line !== undefined && options.file !== undefined) fail('--line과 --file은 함께 쓰지 않습니다.')
  const ids = [options.id ?? []].flat()
  const given = options.line !== undefined ? [options.line.trim()] : options.file !== undefined ? (await body({ file: options.file })).split('\n').map((line) => line.trim()).filter(Boolean) : []
  if (!ids.length && !given.length) fail('해소할 줄을 --id <id>(vibe inbox list의 id), --line 또는 --file로 지정하세요.', [USAGE])
  const note = options.log === undefined ? null : oneLine(`${options.log}`.trim(), 'log')
  const wanted = (line) => ids.includes(lineId(line)) || given.includes(line.trim())
  let resolved = []
  const written = await target.write((current, { now }) => {
    resolved = readSessions(current).inbox.filter(wanted)
    let text = current
    for (const line of resolved) text = applyEvent(text, { type: 'inbox-resolve', line }).text
    if (resolved.length && note) text = applyEvent(text, { type: 'log', line: `- ${yymmdd(new Date(now))} ${note}` }).text
    return { text, changed: text !== current }
  }, { message: `gusta${options.tag ? ` ${options.tag}` : ''}: inbox resolve` })
  // What was asked for and is not there: gone already, or still in STATE's old inbox, which this
  // command does not edit (writes go to the branch only).
  const settled = new Set([...resolved.map(lineId), ...resolved.map((line) => line.trim())])
  const old = target.text && written.coordination.backend !== 'state' ? readSessions(target.text).inbox.filter((line) => wanted(line) && !resolved.includes(line)) : []
  const legacy = new Set([...old.map(lineId), ...old.map((line) => line.trim())])
  const missing = [...ids, ...given].filter((entry) => !settled.has(entry) && !legacy.has(entry))
  return { schemaVersion: 1, ok: !missing.length && !old.length, resolved, missing, ...(old.length ? { legacy: old, hint: '이 줄은 spec/STATE.md의 옛 inbox에 있습니다 — gusta migrate로 조정 브랜치로 옮긴 뒤 해소하세요.' } : {}),
    logged: Boolean(resolved.length && note), coordination: written.coordination }
}

// vibe log --text <text> | --file <path>: one activity line, newest on top (20 kept). Without a
// body it lists the log.
export async function vibeLog(options = {}, injected = {}) {
  const target = await backend(options, 'log', injected)
  const text = await body(options)
  if (text === null) {
    const { doc, coordination } = await target.read()
    return { schemaVersion: 1, ok: true, log: doc.log, coordination }
  }
  const note = oneLine(text, 'log')
  let line
  const written = await target.write((current, { now }) => {
    line = `- ${yymmdd(new Date(now))} ${note}`
    return applyEvent(current, { type: 'log', line })
  }, { message: `gusta${options.tag ? ` ${options.tag}` : ''}: log`, publish: false })
  return { schemaVersion: 1, ok: true, line, coordination: written.coordination }
}
