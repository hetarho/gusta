import assert from 'node:assert/strict'
import test from 'node:test'
import { SESSIONS_FILE, EMPTY_SESSIONS, STALE_MINUTES, REFRESH_MINUTES, ClaimError, readSessions, splitState, mergeSessions, claimTask, applyEvent, sweepStale, refreshDue, isStale, legacySections, mergeLegacy, inboxEntries, lineId } from '../src/coord-doc.mjs'
import { ACTIVE_HEADER, SESSION_ACTIVE_HEADER, activeRows, upsertActive, closeTasks, mergeState } from '../src/state-doc.mjs'

const NOW = '2026-10-13T07:44Z'
const at = (minutes) => `${new Date(Date.parse(NOW) + minutes * 60000).toISOString().slice(0, 16)}Z`
const apply = (text, ...events) => events.reduce((current, event) => applyEvent(current, event).text, text)
const session = (tag, extra = {}) => ({ type: 'beat', tag, host: `host-${tag}`, mode: 'autopilot', now: NOW, ...extra })
const headings = (text) => [...text.matchAll(/^## (.+)$/gm)].map((match) => match[1])

const HEAD = '# STATE\n> state\n\n## cfg\n- level: expert\n- lang: ko  \n\n'
const ACTIVE = `## active\n${ACTIVE_HEADER.join('\n')}\n| aaaa | mbp | autopilot | 2026-10-13T01:00Z | 2026-10-13T02:00Z | T001 |\n\n`
const INBOX = '## inbox\n- 261013 parked T002: needs a decision\n- 261013 decided ARCH-1: runtime → node (alt: deno)\n\n'
const MIDDLE = '## ssot\n| id | rev | tasked | pending | [?] |\n|---|---|---|---|---|\n| ARCH | 1 | 1 | - | 0 |\n\n\n## tasks\n| id | title | ssot | dep | st |\n|---|---|---|---|---|\n| T001 | first | ARCH | - | doing@261013.aaaa |\n\n## next\n-   gusta-implement-task T001\n'
const LOG = '\n## log\n- 261013 T000 done\n- 261012 gusta-create-task ARCH\n'

test('splitState: active·inbox·log만 떼어 내고 나머지 바이트는 그대로 둔다', () => {
  assert.equal(SESSIONS_FILE, 'SESSIONS.md')
  const { state, sessions, moved } = splitState(HEAD + ACTIVE + INBOX + MIDDLE + LOG)
  assert.equal(state, HEAD + MIDDLE)
  assert.deepEqual(moved, ['active', 'inbox', 'log'])
  assert.deepEqual(headings(sessions), ['active', 'inbox', 'log'])
  assert.ok(sessions.startsWith(EMPTY_SESSIONS))
  // 왕복: 떼어 낸 내용은 SESSIONS에서 그대로 읽히고, 여섯 칸 행의 빠진 칸은 `-`다.
  const doc = readSessions(sessions)
  assert.deepEqual(doc.active, [{ tag: 'aaaa', host: 'mbp', mode: 'autopilot', since: '2026-10-13T01:00Z', at: '2026-10-13T02:00Z', doing: 'T001', branch: '-', commit: '-' }])
  assert.deepEqual(doc.inbox, ['- 261013 parked T002: needs a decision', '- 261013 decided ARCH-1: runtime → node (alt: deno)'])
  assert.deepEqual(doc.log, ['- 261013 T000 done', '- 261012 gusta-create-task ARCH'])
  assert.ok(sessions.includes(SESSION_ACTIVE_HEADER[0]))
  // 이미 떼어 낸 STATE는 한 바이트도 바뀌지 않고, 떼어 낼 것도 없다.
  assert.deepEqual(splitState(state), { state, sessions: EMPTY_SESSIONS, moved: [] })
  // 가운데 섹션만 있을 때도 앞뒤 바이트가 그대로다(CRLF 포함).
  const crlf = '# STATE\r\n\r\n## cfg\r\n- level: expert\r\n\r\n## inbox\r\n- 261013 suggest -: tidy\r\n\r\n## tasks\r\n| id |\r\n'
  assert.equal(splitState(crlf).state, '# STATE\r\n\r\n## cfg\r\n- level: expert\r\n\r\n## tasks\r\n| id |\r\n')
  assert.deepEqual(readSessions(splitState(crlf).sessions).inbox, ['- 261013 suggest -: tidy'])
  // 이름이 앞부분만 같은 섹션은 건드리지 않는다.
  assert.equal(splitState('# STATE\n\n## logbook\n- keep\n').state, '# STATE\n\n## logbook\n- keep\n')
  // 무엇을 옮길지 고를 수 있다: 섹션은 STATE에서 모두 빠지고, 고르지 않은 행·줄은 SESSIONS에 가지 않는다.
  const picked = splitState(HEAD + ACTIVE + INBOX + MIDDLE + LOG, { rows: false, line: (line) => !line.includes('T000') && !line.includes('parked') })
  assert.deepEqual([picked.state, picked.moved], [HEAD + MIDDLE, ['active', 'inbox', 'log']])
  assert.deepEqual(readSessions(picked.sessions), { active: [], inbox: ['- 261013 decided ARCH-1: runtime → node (alt: deno)'], log: ['- 261012 gusta-create-task ARCH'], unlanded: [] })
  assert.equal(splitState(HEAD + ACTIVE + MIDDLE, { rows: false }).sessions, EMPTY_SESSIONS)
})

test('state-doc 호환: STATE의 여섯 칸 active는 그대로, SESSIONS의 여덟 칸은 branch·commit을 싣는다', () => {
  const row = { tag: 'aaaa', host: 'mbp', mode: 'pair', since: NOW, at: NOW, doing: 'T001' }
  const narrow = upsertActive('# STATE\n\n## cfg\n- level: expert\n', row)
  assert.match(narrow, /\| aaaa \| mbp \| pair \| 2026-10-13T07:44Z \| 2026-10-13T07:44Z \| T001 \|\n/)
  assert.ok(narrow.includes(ACTIVE_HEADER[0]) && !narrow.includes('branch'))
  assert.deepEqual(activeRows(narrow), [row])
  // 여섯 칸 표에 branch가 있는 행을 넣어도 STATE 표는 넓어지지 않는다.
  assert.deepEqual(activeRows(upsertActive(narrow, { ...row, branch: 'feat/x', commit: 'abc1234' })), [row])
  const wide = upsertActive(narrow, { tag: 'bbbb', host: 'imac', mode: 'autopilot', since: NOW, at: NOW, branch: 'feat/x', commit: 'abc1234' }, { header: SESSION_ACTIVE_HEADER })
  assert.deepEqual(activeRows(wide), [{ ...row, branch: '-', commit: '-' }, { tag: 'bbbb', host: 'imac', mode: 'autopilot', since: NOW, at: NOW, doing: '-', branch: 'feat/x', commit: 'abc1234' }])
  assert.ok(wide.includes(SESSION_ACTIVE_HEADER.join('\n')))
  // 넓은 표의 행을 다시 쓰면 branch·commit은 이전 값을 잇는다.
  assert.equal(activeRows(upsertActive(wide, { tag: 'bbbb', host: 'imac', at: at(5) }, { header: SESSION_ACTIVE_HEADER }))[1].commit, 'abc1234')
  // 끝난 태스크는 여덟 칸 행에서도 doing을 비운다.
  const tasks = `${upsertActive(wide, { tag: 'bbbb', host: 'imac', at: NOW, doing: 'T002' }, { header: SESSION_ACTIVE_HEADER })}\n## tasks\n| id | title | ssot | dep | st |\n|---|---|---|---|---|\n| T002 | second | ARCH | - | todo |\n`
  assert.equal(activeRows(closeTasks(tasks, ['T002']).text)[1].doing, '-')
})

test('mergeState: unlanded는 ID별로 합치고 양쪽이 바꾼 행은 최신 at이 이긴다', () => {
  const table = (...rows) => `# SESSIONS\n\n## unlanded\n| id | tag | branch | commit | at |\n|---|---|---|---|---|\n${rows.join('\n')}\n`
  const base = table('| T001 | aaaa | feat/a | 1111111 | 2026-10-13T01:00Z |')
  const ours = table('| T001 | aaaa | feat/a | 2222222 | 2026-10-13T03:00Z |', '| T002 | aaaa | feat/a | 3333333 | 2026-10-13T03:00Z |')
  const theirs = table('| T001 | bbbb | feat/b | 4444444 | 2026-10-13T02:00Z |', '| T003 | bbbb | feat/b | 5555555 | 2026-10-13T02:00Z |')
  const { text, conflicts } = mergeState(base, ours, theirs)
  assert.deepEqual(conflicts, [])
  assert.deepEqual(readSessions(text).unlanded.map((row) => `${row.id}:${row.commit}`), ['T001:2222222', 'T002:3333333', 'T003:5555555'])
  // prefer 없이는 지운 쪽과 고친 쪽이 여전히 충돌이다(STATE 동작 그대로).
  assert.deepEqual(mergeState(base, '# SESSIONS\n', theirs).conflicts, ['unlanded'])
})

const BASE = apply(EMPTY_SESSIONS, session('aaaa'), session('bbbb'),
  { type: 'inbox-add', line: '- 261012 parked T009: needs the owner' }, { type: 'log', line: '- 261012 start' })

test('mergeSessions: 줄은 합치고 지운 줄은 되살리지 않으며, 같은 행은 최신 at이 이긴다', () => {
  const ours = apply(BASE, session('aaaa', { now: at(10), doing: 'T001', branch: 'feat/a' }), { type: 'log', line: '- 261013 T001 started' },
    { type: 'inbox-resolve', line: '- 261012 parked T009: needs the owner' }, { type: 'inbox-add', line: '- 261013 decided ARCH-1: a → b (alt: c)' })
  const theirs = apply(BASE, session('aaaa', { now: at(5), branch: 'old' }), session('cccc', { doing: 'T002' }), { type: 'log', line: '- 261014 T007 done' },
    { type: 'task-done', tag: 'bbbb', task: 'T007', branch: 'feat/b', commit: 'abc1234', now: at(3) }, { type: 'inbox-add', line: '- 261013 suggest -: tidy' })
  const { text, lost } = mergeSessions(BASE, ours, theirs)
  const doc = readSessions(text)
  assert.deepEqual(lost, [])
  assert.deepEqual(doc.active.map((row) => `${row.tag}:${row.doing}:${row.branch}:${row.at}`), [`aaaa:T001:feat/a:${at(10)}`, `bbbb:-:-:${NOW}`, `cccc:T002:-:${NOW}`])
  assert.deepEqual(doc.inbox, ['- 261013 decided ARCH-1: a → b (alt: c)', '- 261013 suggest -: tidy'])
  assert.deepEqual(doc.log, ['- 261014 T007 done', '- 261013 T001 started', '- 261012 start'])
  assert.deepEqual(doc.unlanded, [{ id: 'T007', tag: 'bbbb', branch: 'feat/b', commit: 'abc1234', at: at(3) }])
  assert.deepEqual(headings(text), ['active', 'inbox', 'unlanded', 'log'])
  // 한쪽이 지우고 한쪽이 고친 행도 충돌 표시 없이 고친 쪽이 남는다.
  const ended = apply(BASE, { type: 'release', tag: 'bbbb' })
  const beaten = apply(BASE, session('bbbb', { now: at(20), doing: 'T003' }))
  for (const merged of [mergeSessions(BASE, ended, beaten), mergeSessions(BASE, beaten, ended)]) {
    assert.doesNotMatch(merged.text, /<<<<<<<|>>>>>>>/)
    assert.equal(readSessions(merged.text).active.find((row) => row.tag === 'bbbb').doing, 'T003')
  }
})

test('mergeSessions: 같은 태스크를 양쪽이 잡으면 원격(theirs)이 이기고 진 쪽을 lost로 알린다', () => {
  const ours = apply(BASE, session('aaaa', { now: at(30), doing: 'T001' }))
  const theirs = apply(BASE, session('bbbb', { now: at(1), doing: 'T001' }))
  const { text, lost } = mergeSessions(BASE, ours, theirs)
  assert.deepEqual(lost, [{ task: 'T001', owner: 'bbbb', tag: 'aaaa', reason: 'claimed' }])
  assert.deepEqual(readSessions(text).active.map((row) => `${row.tag}:${row.doing}`), ['aaaa:-', 'bbbb:T001'])
  // 뒤집으면 우리(이번에는 bbbb)가 진다: 늦게 잡았는지가 아니라 원격에 먼저 올라갔는지다.
  assert.deepEqual(mergeSessions(BASE, theirs, ours).lost, [{ task: 'T001', owner: 'aaaa', tag: 'bbbb', reason: 'claimed' }])
  // 공통 조상 없이(각자 만든 브랜치) 합쳐도 같다.
  const apart = mergeSessions('', apply(EMPTY_SESSIONS, session('aaaa', { doing: 'T001' })), apply(EMPTY_SESSIONS, session('bbbb', { doing: 'T001' })))
  assert.deepEqual(apart.lost, [{ task: 'T001', owner: 'bbbb', tag: 'aaaa', reason: 'claimed' }])
  assert.deepEqual(readSessions(apart.text).active.map((row) => `${row.tag}:${row.doing}`), ['aaaa:-', 'bbbb:T001'])
  // 원격이 이미 끝내 unlanded에 둔 태스크를 잡고 있었어도 진다.
  const finished = apply(BASE, { type: 'task-done', tag: 'bbbb', task: 'T001', branch: 'feat/b', commit: 'abc1234', now: at(2) })
  const done = mergeSessions(BASE, ours, finished)
  assert.deepEqual(done.lost, [{ task: 'T001', owner: 'bbbb', tag: 'aaaa', reason: 'unlanded' }])
  assert.equal(readSessions(done.text).active[0].doing, '-')
  // 서로 다른 태스크는 누구도 지지 않는다.
  assert.deepEqual(mergeSessions(BASE, ours, apply(BASE, session('bbbb', { doing: 'T002' }))).lost, [])
})

test('claimTask: 살아 있는 다른 세션이 잡았거나 unlanded에 있으면 누가 잡았는지와 함께 거절한다', () => {
  const taken = apply(EMPTY_SESSIONS, session('bbbb', { doing: 'T001', now: at(-STALE_MINUTES) }))
  const refuse = (text, options, expected) => assert.throws(() => claimTask(text, { tag: 'aaaa', task: 'T001', now: NOW, host: 'mbp', mode: 'pair', ...options }),
    (error) => error instanceof ClaimError && error.task === 'T001' && error.owner === expected.owner && error.reason === expected.reason)
  refuse(taken, {}, { owner: 'bbbb', reason: 'claimed' })
  // 새 세션의 선점: 행을 만들고 doing을 채운다.
  const first = claimTask(EMPTY_SESSIONS, { tag: 'aaaa', task: 'T001', now: NOW, host: 'mbp', mode: 'pair', branch: 'feat/a', commit: 'abc1234' })
  assert.deepEqual(readSessions(first.text).active, [{ tag: 'aaaa', host: 'mbp', mode: 'pair', since: NOW, at: NOW, doing: 'T001', branch: 'feat/a', commit: 'abc1234' }])
  assert.deepEqual([first.changed, first.released], [true, []])
  assert.throws(() => claimTask(EMPTY_SESSIONS, { tag: 'aaaa', task: 'T001', now: NOW }), /host와 mode/)
  // 자기가 이미 잡은 태스크를 다시 잡는 것은 내용 변화가 아니다.
  assert.equal(claimTask(first.text, { tag: 'aaaa', task: 'T001', now: at(1) }).changed, false)
  // at이 STALE_MINUTES를 넘긴 세션의 선점은 풀고 가져온다.
  const stale = apply(EMPTY_SESSIONS, session('bbbb', { doing: 'T001', now: at(-STALE_MINUTES - 1) }))
  const over = claimTask(stale, { tag: 'aaaa', task: 'T001', now: NOW, host: 'mbp', mode: 'pair' })
  assert.deepEqual(over.released, ['bbbb'])
  assert.deepEqual(readSessions(over.text).active.map((row) => `${row.tag}:${row.doing}`), ['bbbb:-', 'aaaa:T001'])
  // 누가 쥐고 있었는지는 log 한 줄로 남는다(그 행은 이 쓰기에서 걷지 않는다 — vibe-coord가 keep에 넣는다).
  assert.deepEqual(readSessions(over.text).log, ['- 261013 released stale bbbb from T001'])
  assert.deepEqual(readSessions(first.text).log, [])
  // 생존 판단은 호출자가 줄 수 있다(wip 스냅샷으로 살아 있는 세션, 죽었다고 확인한 세션).
  refuse(stale, { live: ['bbbb'] }, { owner: 'bbbb', reason: 'claimed' })
  refuse(stale, { live: (row) => row.tag === 'bbbb' }, { owner: 'bbbb', reason: 'claimed' })
  assert.deepEqual(claimTask(taken, { tag: 'aaaa', task: 'T001', now: NOW, host: 'mbp', mode: 'pair', live: [] }).released, ['bbbb'])
  // 끝났지만 아직 land되지 않은 태스크는 다른 세션이 다시 집지 못한다. 끝낸 세션 자신은 다시 잡을 수 있다.
  const unlanded = apply(first.text, { type: 'task-done', tag: 'aaaa', task: 'T001', branch: 'feat/a', commit: 'abc1234', now: NOW })
  assert.throws(() => claimTask(unlanded, { tag: 'cccc', task: 'T001', now: NOW, host: 'imac', mode: 'pair' }), (error) => error instanceof ClaimError && error.owner === 'aaaa' && error.reason === 'unlanded')
  assert.equal(readSessions(claimTask(unlanded, { tag: 'aaaa', task: 'T001', now: at(1) }).text).active[0].doing, 'T001')
  assert.throws(() => claimTask(EMPTY_SESSIONS, { tag: 'aaaa', task: 'nope', now: NOW }), /T###/)
})

test('applyEvent beat·release: at만 바뀐 beat는 changed:false, 같은 내용은 같은 본문이다', () => {
  const created = applyEvent('', session('aaaa', { branch: 'feat/a b|c', commit: 'abc1234' }))
  assert.equal(created.changed, true)
  assert.deepEqual(readSessions(created.text).active, [{ tag: 'aaaa', host: 'host-aaaa', mode: 'autopilot', since: NOW, at: NOW, doing: '-', branch: 'feat/a-b-c', commit: 'abc1234' }])
  const again = applyEvent(created.text, { type: 'beat', tag: 'aaaa', now: NOW })
  assert.equal(again.changed, false)
  assert.equal(again.text, created.text)
  const later = applyEvent(created.text, { type: 'beat', tag: 'aaaa', now: at(7) })
  assert.equal(later.changed, false)
  assert.deepEqual([readSessions(later.text).active[0].since, readSessions(later.text).active[0].at], [NOW, at(7)])
  for (const change of [{ doing: 'T001' }, { commit: 'def5678' }, { branch: 'main' }, { mode: 'pair' }]) assert.equal(applyEvent(created.text, { type: 'beat', tag: 'aaaa', now: at(7), ...change }).changed, true)
  assert.throws(() => applyEvent(created.text, { type: 'beat', tag: 'bbbb', now: NOW }), /host와 mode/)
  assert.throws(() => applyEvent(created.text, { type: 'beat', tag: 'aaaa', now: 'today' }), /ISO UTC/)
  assert.throws(() => applyEvent(created.text, { type: 'beat', tag: 'aaaa', now: NOW, doing: 'task' }), /doing/)
  assert.throws(() => applyEvent(created.text, { type: 'toString' }), /알 수 없는 조정 사건/)
  // release: 태스크만 놓거나(행은 남음), 세션을 끝낸다(행이 사라짐).
  const doing = apply(created.text, session('bbbb', { doing: 'T002' }))
  const freed = applyEvent(doing, { type: 'release', tag: 'bbbb', task: 'T002', now: at(9) })
  assert.deepEqual([freed.changed, readSessions(freed.text).active[1].doing, readSessions(freed.text).active[1].at], [true, '-', at(9)])
  assert.deepEqual(applyEvent(doing, { type: 'release', tag: 'bbbb', task: 'T009' }), { text: doing, changed: false })
  const ended = applyEvent(doing, { type: 'release', tag: 'bbbb' })
  assert.deepEqual([ended.changed, ended.text], [true, created.text])
  assert.deepEqual(applyEvent(doing, { type: 'release', tag: 'zzzz' }), { text: doing, changed: false })
  assert.equal(applyEvent(created.text, { type: 'release', tag: 'aaaa' }).text, EMPTY_SESSIONS)
})

test('applyEvent inbox·log·task-done·landed: 섹션 순서는 사건 순서와 무관하다', () => {
  const parked = '- 261013 parked T002: needs a decision'
  const added = applyEvent(EMPTY_SESSIONS, { type: 'inbox-add', line: parked })
  assert.equal(added.changed, true)
  assert.deepEqual(applyEvent(added.text, { type: 'inbox-add', line: parked }), { text: added.text, changed: false })
  const built = applyEvent(added.text, { type: 'inbox-add', kind: 'decided', refs: ['ARCH-1', 'T003'], text: 'runtime → node (alt: deno)', now: NOW })
  assert.deepEqual(readSessions(built.text).inbox, [parked, '- 261013 decided ARCH-1 T003: runtime → node (alt: deno)'])
  assert.throws(() => applyEvent(EMPTY_SESSIONS, { type: 'inbox-add', line: '- parked without a date' }), /inbox 줄 형식/)
  assert.deepEqual(applyEvent(built.text, { type: 'inbox-resolve', line: '- 261013 parked T404: gone' }), { text: built.text, changed: false })
  assert.deepEqual(readSessions(applyEvent(built.text, { type: 'inbox-resolve', line: parked }).text).inbox, ['- 261013 decided ARCH-1 T003: runtime → node (alt: deno)'])
  assert.equal(applyEvent(added.text, { type: 'inbox-resolve', line: parked }).text, EMPTY_SESSIONS)
  // log: 최신이 위, STATE와 같은 20줄 한도.
  let logged = EMPTY_SESSIONS
  for (let index = 1; index <= 22; index += 1) logged = applyEvent(logged, { type: 'log', text: `event ${index}`, now: NOW }).text
  assert.equal(readSessions(logged).log.length, 20)
  assert.equal(readSessions(logged).log[0], '- 261013 event 22')
  assert.throws(() => applyEvent(EMPTY_SESSIONS, { type: 'log', line: 'no bullet' }), /log 줄 형식/)
  // task-done: unlanded에 올리고 그 세션의 doing을 비운다. 같은 사건을 다시 적용하면 본문이 같다.
  const working = apply(EMPTY_SESSIONS, { type: 'log', line: '- 261013 start' }, session('aaaa', { doing: 'T001', branch: 'feat/a', commit: '1111111' }), session('bbbb', { doing: 'T002' }))
  const event = { type: 'task-done', tag: 'aaaa', task: 'T001', branch: 'feat/a', commit: '2222222', now: at(4) }
  const done = applyEvent(working, event)
  assert.equal(done.changed, true)
  assert.deepEqual(readSessions(done.text).unlanded, [{ id: 'T001', tag: 'aaaa', branch: 'feat/a', commit: '2222222', at: at(4) }])
  assert.deepEqual(readSessions(done.text).active.map((row) => `${row.tag}:${row.doing}:${row.commit}`), ['aaaa:-:2222222', 'bbbb:T002:-'])
  assert.deepEqual(applyEvent(done.text, event), { text: done.text, changed: false })
  const redone = applyEvent(done.text, { ...event, commit: '3333333', now: at(8) })
  assert.deepEqual(readSessions(redone.text).unlanded.map((row) => row.commit), ['3333333'])
  assert.deepEqual(headings(apply(done.text, { type: 'inbox-add', line: parked })), ['active', 'inbox', 'unlanded', 'log'])
  // landed: land 브랜치에 들어간 태스크의 행만 지운다. 표가 비면 섹션도 없다.
  const two = apply(done.text, { type: 'task-done', tag: 'bbbb', task: 'T002', branch: 'feat/b', commit: '4444444', now: at(5) })
  const landed = applyEvent(two, { type: 'landed', tasks: ['T001', 'T404'] })
  assert.deepEqual([landed.changed, readSessions(landed.text).unlanded.map((row) => row.id)], [true, ['T002']])
  assert.deepEqual(applyEvent(landed.text, { type: 'landed', task: 'T001' }), { text: landed.text, changed: false })
  assert.deepEqual(headings(applyEvent(landed.text, { type: 'landed', task: 'T002' }).text), ['active', 'log'])
})

test('여섯 칸 active 행이 남은 SESSIONS도 읽고, 고치면 여덟 칸으로 넓힌다', () => {
  const legacy = `${EMPTY_SESSIONS}\n## active\n${ACTIVE_HEADER.join('\n')}\n| aaaa | mbp | autopilot | ${at(-5)} | ${at(-5)} | T001 |\n| bbbb | imac | pair | ${at(-5)} | ${at(-5)} | - |\n`
  assert.deepEqual(readSessions(legacy).active[0], { tag: 'aaaa', host: 'mbp', mode: 'autopilot', since: at(-5), at: at(-5), doing: 'T001', branch: '-', commit: '-' })
  assert.throws(() => claimTask(legacy, { tag: 'bbbb', task: 'T001', now: NOW }), (error) => error instanceof ClaimError && error.owner === 'aaaa')
  const beat = applyEvent(legacy, { type: 'beat', tag: 'bbbb', now: NOW, branch: 'feat/b', commit: 'abc1234' })
  assert.equal(beat.changed, true)
  assert.ok(beat.text.includes(SESSION_ACTIVE_HEADER.join('\n')))
  assert.ok(beat.text.includes(`| aaaa | mbp | autopilot | ${at(-5)} | ${at(-5)} | T001 | - | - |`))
  assert.deepEqual(readSessions(beat.text).active[1], { tag: 'bbbb', host: 'imac', mode: 'pair', since: at(-5), at: NOW, doing: '-', branch: 'feat/b', commit: 'abc1234' })
  // 한쪽은 여섯 칸, 한쪽은 여덟 칸이어도 합쳐지고 머리줄은 넓은 쪽이다.
  const merged = mergeSessions(legacy, legacy.replace(`| bbbb | imac | pair | ${at(-5)} | ${at(-5)} | - |`, `| bbbb | imac | pair | ${at(-5)} | ${at(-1)} | T002 |`), beat.text)
  assert.ok(merged.text.includes(SESSION_ACTIVE_HEADER[0]))
  assert.deepEqual(readSessions(merged.text).active.map((row) => `${row.tag}:${row.doing}:${row.branch}`), ['aaaa:T001:-', 'bbbb:-:feat/b'])
  assert.deepEqual(merged.lost, [])
})

test('sweepStale·refreshDue: 죽은 행만 걷고, 묵은 행의 heartbeat만 커밋할 가치가 있다', () => {
  const text = apply(EMPTY_SESSIONS, session('dead', { now: at(-STALE_MINUTES - 1) }), session('held', { now: at(-STALE_MINUTES - 1), doing: 'T002' }),
    session('edge', { now: at(-STALE_MINUTES) }), session('self', { now: at(-STALE_MINUTES - 30) }), session('live', { now: at(-1) }))
  const swept = sweepStale(text, { now: NOW, keep: 'self' })
  // 태스크를 쥔 오래된 행, 쓰는 세션 자신의 행, 경계에 있는 행은 남는다.
  assert.deepEqual(swept.removed, ['dead'])
  assert.deepEqual(readSessions(swept.text).active.map((row) => row.tag), ['held', 'edge', 'self', 'live'])
  assert.deepEqual(sweepStale(swept.text, { now: NOW, keep: 'self' }), { text: swept.text, removed: [] })
  assert.deepEqual(sweepStale(text, { now: NOW }).removed, ['dead', 'self'])
  // keep은 여러 tag일 수 있다: 쓰는 세션 자신과 이 쓰기가 막 선점을 푼 세션.
  assert.deepEqual(sweepStale(text, { now: NOW, keep: ['self', 'dead'] }).removed, [])
  assert.throws(() => sweepStale(text, { now: 'today' }), /ISO UTC/)
  assert.deepEqual([isStale({ at: at(-STALE_MINUTES) }, NOW), isStale({ at: at(-STALE_MINUTES - 1) }, NOW), isStale({ at: '-' }, NOW)], [false, true, false])
  // heartbeat: REFRESH_MINUTES가 지난 행만 at 갱신을 남길 만하다. 없는 행은 아니다.
  assert.equal(REFRESH_MINUTES, 30)
  assert.deepEqual(['live', 'edge', 'none'].map((tag) => refreshDue(text, tag, NOW)), [false, true, false])
  assert.equal(refreshDue(apply(EMPTY_SESSIONS, session('aaaa', { now: at(-REFRESH_MINUTES) })), 'aaaa', NOW), true)
  assert.equal(refreshDue(apply(EMPTY_SESSIONS, session('aaaa', { now: at(-REFRESH_MINUTES + 1) })), 'aaaa', NOW), false)
})

test('이관 전 STATE: 옛 섹션을 알아보고 SESSIONS에 없는 행·줄만 합쳐 읽는다', () => {
  const state = HEAD + ACTIVE + INBOX + MIDDLE + LOG
  assert.deepEqual(legacySections(state), ['active', 'inbox', 'log'])
  assert.deepEqual([legacySections(HEAD + MIDDLE), legacySections(null), legacySections('# STATE\n\n## logbook\n- keep\n')], [[], [], []])
  const sessions = apply(EMPTY_SESSIONS, session('aaaa', { doing: 'T009', branch: 'feat/a' }), session('bbbb'),
    { type: 'inbox-add', line: '- 261013 parked T002: needs a decision' }, { type: 'inbox-add', line: '- 261014 suggest -: tidy' }, { type: 'log', line: '- 261014 newest' })
  const remote = `# STATE\n\n## active\n${ACTIVE_HEADER.join('\n')}\n| cccc | imac | pair | 2026-10-13T01:00Z | 2026-10-13T03:00Z | T003 |\n| bbbb | old | pair | 2026-10-13T01:00Z | 2026-10-13T01:00Z | T004 |\n\n## inbox\n- 261011 parked T008: remote only\n`
  const merged = mergeLegacy(readSessions(sessions), state, { activeFrom: [remote] })
  // 같은 tag는 SESSIONS의 행이 이긴다. STATE에만 있는 행은 legacy로 표시되고 빠진 칸은 `-`다.
  assert.deepEqual(merged.active.map((row) => [row.tag, row.doing, row.branch, row.legacy ?? false]), [['aaaa', 'T009', 'feat/a', false], ['bbbb', '-', '-', false], ['cccc', 'T003', '-', true]])
  // 줄은 이 checkout의 STATE 것만 더한다(다른 사본의 inbox는 이미 해소된 줄을 되살린다). 같은 줄은 한 번.
  assert.deepEqual(merged.inbox, ['- 261013 parked T002: needs a decision', '- 261014 suggest -: tidy', '- 261013 decided ARCH-1: runtime → node (alt: deno)'])
  assert.deepEqual(merged.log, ['- 261014 newest', '- 261013 T000 done', '- 261012 gusta-create-task ARCH'])
  assert.deepEqual(merged.unlanded, [])
  // 옛 섹션이 없으면 SESSIONS 그대로다.
  assert.deepEqual(mergeLegacy(readSessions(sessions), HEAD + MIDDLE), readSessions(sessions))
  // inbox 줄은 id로 가리킨다: 같은 줄은 같은 id, 형식이 아닌 줄은 빠진다.
  const entries = inboxEntries(['- 261013 parked T002 T003: needs "a" | decision', '  - 261013 parked T002 T003: needs "a" | decision  ', 'not a line'])
  assert.deepEqual(entries.map(({ id, ...entry }) => entry), Array(2).fill({ line: '- 261013 parked T002 T003: needs "a" | decision', date: '261013', kind: 'parked', refs: ['T002', 'T003'], text: 'needs "a" | decision' }))
  assert.deepEqual([entries[0].id, entries[0].id.length], [lineId('- 261013 parked T002 T003: needs "a" | decision'), 8])
})
