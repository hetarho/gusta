import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { MIGRATIONS, runMigrations, sessionSections, migrateSpec } from '../src/migrate.mjs'
import { EMPTY_SESSIONS, SESSIONS_FILE, applyEvent, readSessions } from '../src/coord-doc.mjs'
import { COORD_BRANCH } from '../src/coord-branch.mjs'
import { SESSION_ACTIVE_HEADER } from '../src/state-doc.mjs'
import { parseSettings } from '../src/settings.mjs'
import { fixture, machines, execute, git, MACHINES_STATE } from './helpers/vibe-fixture.mjs'
import { vibeInbox } from '../src/vibe-inbox.mjs'
import { vibeBeat } from '../src/vibe.mjs'

const cli = fileURLToPath(new URL('../bin/gusta.mjs', import.meta.url))
const sessionsBranch = MIGRATIONS.find((entry) => entry.id === 'sessions-branch')
const branchSettings = MIGRATIONS.find((entry) => entry.id === 'branch-settings')
const apply = (text, ...events) => events.reduce((current, event) => applyEvent(current, event).text, text)

const HEAD = '# STATE\n> state\n\n## cfg\n- level: expert\n- lang: ko\n\n'
const ACTIVE = '## active\n| tag | host | mode | since | at | doing |\n|---|---|---|---|---|---|\n| k3f9 | mbp | autopilot | 2026-10-13T01:00Z | 2026-10-13T02:10Z | T002 |\n\n'
const INBOX = '## inbox\n- 261013 decided ARCH-1 T002: runtime unknown → node (alt: bun | deno)\n- 261013 parked T001: needs a force push\n\n'
const REST = '## ssot\n| id | rev | tasked | pending | [?] |\n|---|---|---|---|---|\n| ARCH | 1 | 1 | - | 0 |\n\n## tasks\n| id | title | ssot | dep | st |\n|---|---|---|---|---|\n| T002 | api | ARCH | - | doing@261013.k3f9 |\n\n## next\n- gusta-implement-task T002\n'
const LOG = '\n## log\n- 261013 T001 done\n- 261012 gusta-create-task ARCH\n'
const LEGACY = HEAD + ACTIVE + INBOX + REST + LOG
const K3F9 = { tag: 'k3f9', host: 'mbp', mode: 'autopilot', since: '2026-10-13T01:00Z', at: '2026-10-13T02:10Z', doing: 'T002', branch: '-', commit: '-' }

test('sessions-branch: STATE의 active·inbox·log를 조정 문서로 옮기고 여섯 칸 행을 여덟 칸으로 넓히며, 다시 돌려도 같다', () => {
  assert.deepEqual(MIGRATIONS.map((entry) => entry.id), ['branch-settings', 'sessions-branch'])
  const once = sessionsBranch.run({ state: LEGACY, settings: null, sessions: EMPTY_SESSIONS })
  // 남는 것: cfg·ssot·tasks(행의 doing@date.tag 포함)·next — 한 바이트도 바뀌지 않는다.
  assert.equal(once.state, HEAD + REST)
  assert.equal(once.settings, null)
  assert.ok(once.sessions.startsWith(EMPTY_SESSIONS) && once.sessions.includes(SESSION_ACTIVE_HEADER.join('\n')))
  assert.deepEqual(readSessions(once.sessions), { active: [K3F9], unlanded: [],
    inbox: ['- 261013 decided ARCH-1 T002: runtime unknown → node (alt: bun | deno)', '- 261013 parked T001: needs a force push'],
    log: ['- 261013 T001 done', '- 261012 gusta-create-task ARCH'] })
  // 멱등: 이관된 입력은 그 객체 그대로 돌아온다.
  assert.equal(sessionsBranch.run(once), once)
  assert.deepEqual(runMigrations(once), { result: once, applied: [] })
  // 조정 브랜치만 쓰고 죽은 뒤의 재실행: STATE는 아직 옛 모습, 조정 문서는 이미 옮겨진 상태 → 같은 결과.
  assert.deepEqual(sessionsBranch.run({ state: LEGACY, settings: null, sessions: once.sessions }), once)
  // 빈 섹션만 남은 STATE(옛 템플릿의 `## log`)는 섹션만 지우고 조정 문서를 건드리지 않는다.
  const empty = sessionsBranch.run({ state: `${HEAD}${REST}\n## log\n`, settings: null, sessions: 'held\n' })
  assert.deepEqual([empty.state, empty.sessions], [HEAD + REST, 'held\n'])
  assert.deepEqual(sessionSections(`${HEAD}${REST}\n## log\n`), { carries: false, sections: [{ section: 'log', lines: 0 }], dropped: [] })
  assert.deepEqual(sessionSections(LEGACY), { carries: true, sections: [{ section: 'active', rows: 1 }, { section: 'inbox', lines: 2 }, { section: 'log', lines: 2 }], dropped: [] })
})

test('sessions-branch: 조정 문서에 이미 있던 줄·행과 합집합으로 합친다', () => {
  const held = apply(EMPTY_SESSIONS,
    { type: 'beat', tag: 'zz11', host: 'imac', mode: 'pair', now: '2026-10-14T09:00Z', doing: 'T009', branch: 'feat/x', commit: 'abc1234' },
    { type: 'inbox-add', line: '- 261013 parked T001: needs a force push' },
    { type: 'inbox-add', line: '- 261014 suggest -: tidy the fixtures' },
    { type: 'task-done', tag: 'yy22', task: 'T005', branch: 'feat/y', commit: 'def5678', now: '2026-10-14T08:00Z' },
    { type: 'log', line: '- 261014 T009 start' })
  const merged = sessionsBranch.run({ state: LEGACY, settings: null, sessions: held })
  const doc = readSessions(merged.sessions)
  // 조정 문서의 여덟 칸 행은 그대로, STATE에서 온 행은 branch·commit이 `-`.
  assert.deepEqual(doc.active, [{ tag: 'zz11', host: 'imac', mode: 'pair', since: '2026-10-14T09:00Z', at: '2026-10-14T09:00Z', doing: 'T009', branch: 'feat/x', commit: 'abc1234' }, K3F9])
  // 같은 줄은 한 번만, 양쪽에만 있던 줄은 모두 남는다. log는 최신이 위.
  assert.deepEqual(doc.inbox, ['- 261013 parked T001: needs a force push', '- 261014 suggest -: tidy the fixtures', '- 261013 decided ARCH-1 T002: runtime unknown → node (alt: bun | deno)'])
  assert.deepEqual(doc.log, ['- 261014 T009 start', '- 261013 T001 done', '- 261012 gusta-create-task ARCH'])
  assert.deepEqual(doc.unlanded, [{ id: 'T005', tag: 'yy22', branch: 'feat/y', commit: 'def5678', at: '2026-10-14T08:00Z' }])
  assert.deepEqual(sessionsBranch.run({ state: LEGACY, settings: null, sessions: merged.sessions }), merged)
  // 같은 세션 행이 양쪽에 있으면 나중 at이 남는다: 조정 문서가 더 새로우면 그 branch·commit을 지킨다.
  const newer = apply(EMPTY_SESSIONS, { type: 'beat', tag: 'k3f9', host: 'mbp', mode: 'autopilot', now: '2026-10-13T03:00Z', doing: 'T002', branch: 'feat/api', commit: '0123abc' })
  assert.deepEqual(readSessions(sessionsBranch.run({ state: LEGACY, settings: null, sessions: newer }).sessions).active,
    [{ ...K3F9, since: '2026-10-13T03:00Z', at: '2026-10-13T03:00Z', branch: 'feat/api', commit: '0123abc' }])
  const older = apply(EMPTY_SESSIONS, { type: 'beat', tag: 'k3f9', host: 'mbp', mode: 'autopilot', now: '2026-10-13T00:30Z', doing: '-', branch: 'feat/api', commit: '0123abc' })
  assert.deepEqual(readSessions(sessionsBranch.run({ state: LEGACY, settings: null, sessions: older }).sessions).active, [K3F9])
})

test('sessions-branch: 조정 브랜치 히스토리에 있던 줄은 다시 옮기지 않고, 브랜치가 이미 있었으면 옛 active 행은 버린다', () => {
  const resolved = '- 261013 parked T001: needs a force push'
  // 다른 checkout이 먼저 이관했고, 그 뒤 owner가 parked 줄을 해소했고 k3f9 세션도 끝났다.
  const held = apply(EMPTY_SESSIONS, { type: 'inbox-add', line: '- 261014 suggest -: newer' }, { type: 'log', line: '- 261014 inbox confirmed' })
  const history = { existed: true, lines: [resolved, '- 261013 decided ARCH-1 T002: runtime unknown → node (alt: bun | deno)', '- 261013 T001 done', '- 261012 gusta-create-task ARCH', '- 261014 suggest -: newer'] }
  const moved = sessionsBranch.run({ state: LEGACY, settings: null, sessions: held, history })
  // STATE에서는 세 섹션이 모두 빠지고, 조정 문서에는 아무것도 되살아나지 않는다.
  assert.deepEqual([moved.state, moved.sessions], [HEAD + REST, held])
  // 히스토리에 없던 줄만 옮긴다(이 checkout에서만 쓰인 줄). 행은 최초 이관(브랜치가 없던 때)에만 옮긴다.
  const own = LEGACY.replace(INBOX, `${INBOX.trimEnd()}\n- 261015 suggest -: only here\n\n`)
  const doc = readSessions(sessionsBranch.run({ state: own, settings: null, sessions: held, history }).sessions)
  assert.deepEqual([doc.active, doc.inbox, doc.log], [[], ['- 261014 suggest -: newer', '- 261015 suggest -: only here'], ['- 261014 inbox confirmed']])
  const first = readSessions(sessionsBranch.run({ state: LEGACY, settings: null, sessions: EMPTY_SESSIONS, history: { existed: false, lines: [] } }).sessions)
  assert.deepEqual(first.active, [K3F9])
  assert.deepEqual(sessionSections(LEGACY, history).dropped, [{ section: 'active', rows: 1 }, { section: 'inbox', lines: 2 }, { section: 'log', lines: 2 }])
  assert.deepEqual(sessionSections(LEGACY).dropped, [])
})

test('MIGRATIONS 계약: sessions가 없으면(조정 브랜치를 둘 곳이 없으면) 건너뛰고, 다른 이관은 sessions를 그대로 통과시킨다', () => {
  for (const input of [{ state: LEGACY, settings: null }, { state: LEGACY, settings: null, sessions: null }, { state: null, settings: null, sessions: EMPTY_SESSIONS }]) {
    assert.equal(sessionsBranch.run(input), input)
  }
  const cfg = LEGACY.replace('- lang: ko\n', '- lang: ko\n- push: next\n- plan: trunk\n')
  const moved = branchSettings.run({ state: cfg, settings: null, sessions: 'held\n' })
  assert.equal(moved.sessions, 'held\n')
  assert.equal(moved.state, LEGACY)
  // 두 이관이 차례로: cfg는 SETTINGS로, 세션 섹션은 조정 문서로.
  const { result, applied } = runMigrations({ state: cfg, settings: null, sessions: EMPTY_SESSIONS })
  assert.deepEqual(applied.map((entry) => [entry.id, entry.changed]), [['branch-settings', ['state', 'settings']], ['sessions-branch', ['state', 'sessions']]])
  assert.equal(result.state, HEAD + REST)
  assert.deepEqual(parseSettings(result.settings).values, { land: 'next', push: true, plan: 'trunk' })
  assert.deepEqual(runMigrations(result), { result, applied: [] })
})

// A coordination branch that lives in memory: what migrateSpec asks of deps.coord.
function fakeCoord({ text = EMPTY_SESSIONS, onUpdate, dieAfterUpdate = false } = {}) {
  const store = { text, commit: text === EMPTY_SESSIONS ? null : 'c0', calls: [], die: dieAfterUpdate }
  store.open = async (context) => {
    store.calls.push(`open ${context.branch} push:${context.push}`)
    return {
      branch: context.branch,
      read: async () => { store.calls.push('read'); return { commit: store.commit, text: store.text } },
      update: async (mutate, options) => {
        const next = await mutate(store.text, { now: '2026-10-13T07:44Z', commit: store.commit })
        store.calls.push(`update ${options?.message}`)
        await onUpdate?.()
        const changed = next !== store.text
        if (changed) { store.text = next; store.commit = `c${store.calls.length}` }
        if (store.die) throw new Error('killed after the coordination write')
        return { commit: store.commit, text: store.text, changed }
      },
      publish: async () => { store.calls.push('publish'); return { pushed: false, reason: 'no-remote', lost: [] } },
    }
  }
  return store
}

async function legacyProject(t) {
  const made = await fixture(t, 1)
  const file = path.join(made.root, 'spec/STATE.md')
  const clean = await readFile(file, 'utf8')
  const legacy = `${clean.replace('## ssot', `${ACTIVE.replace('T002', 'T001')}${INBOX.replace('T002', 'T001')}## ssot`)}${LOG}`
  await writeFile(file, legacy)
  await git(made.root, 'commit', '-qam', 'legacy state')
  return { ...made, file, clean, legacy }
}

test('migrateSpec: 조정 브랜치를 먼저 쓰고 STATE를 나중에 쓴다 — 사이에 죽어도 다시 돌리면 같은 결과다', async (t) => {
  const { root, file, clean, legacy } = await legacyProject(t)
  const seen = []
  const coord = fakeCoord({ onUpdate: async () => seen.push(await readFile(file, 'utf8')), dieAfterUpdate: true })
  await assert.rejects(migrateSpec({ targetRoot: root }, { coord: coord.open }), /killed after the coordination write/)
  // 조정 문서는 옮겨졌고, 그 순간에도 그 뒤에도 STATE는 옛 모습 그대로다.
  assert.deepEqual(seen, [legacy])
  assert.equal(await readFile(file, 'utf8'), legacy)
  assert.deepEqual(readSessions(coord.text).log, ['- 261013 T001 done', '- 261012 gusta-create-task ARCH'])
  assert.deepEqual(coord.calls, [`open ${COORD_BRANCH} push:true`, 'read', 'update gusta: migrate sessions from STATE'])
  const [written, commit] = [coord.text, coord.commit]
  // 재실행: 조정 문서는 이미 같은 내용이라 다시 쓰지 않고, STATE만 마저 쓴다.
  coord.die = false
  coord.calls.length = 0
  const resumed = await migrateSpec({ targetRoot: root }, { coord: coord.open })
  assert.deepEqual(coord.calls, [`open ${COORD_BRANCH} push:true`, 'read', 'publish'])
  assert.equal(coord.text, written)
  assert.equal(await readFile(file, 'utf8'), clean)
  assert.deepEqual(resumed.applied, [{ id: 'sessions-branch', summary: sessionsBranch.summary, files: ['spec/STATE.md'] }])
  // 첫 실행이 브랜치를 만들었으므로 옛 active 행은 다시 옮기지 않는다(이미 옮겨져 있다).
  assert.deepEqual(resumed.sessions, { branch: COORD_BRANCH, moved: [{ section: 'active', rows: 1 }, { section: 'inbox', lines: 2 }, { section: 'log', lines: 2 }], commit,
    published: { pushed: false, reason: 'no-remote', error: null, lost: [] }, skipped: null, dropped: [{ section: 'active', rows: 1 }],
    note: `조정 브랜치 ${COORD_BRANCH}의 ${SESSIONS_FILE}로 옮겼습니다: active 1행 · inbox 2줄 · log 2줄. 그중 이미 조정 브랜치에 있던(그 뒤 해소된 것 포함) 줄과, 브랜치가 이미 있어 세션이 다시 등록할 옛 active 행은 옮기지 않았습니다: active 1행.` })
  assert.deepEqual([resumed.ok, resumed.lint.ok, resumed.lint.errors], [true, true, []])
  // 한 번에 끝낸 실행과 같은 두 문서다.
  await writeFile(file, legacy)
  const oneShot = fakeCoord()
  await migrateSpec({ targetRoot: root }, { coord: oneShot.open })
  assert.deepEqual([oneShot.text, await readFile(file, 'utf8')], [written, clean])
  assert.deepEqual(oneShot.calls, [`open ${COORD_BRANCH} push:true`, 'read', 'update gusta: migrate sessions from STATE', 'publish'])
  // 주입한 저장소만 썼다: 실제 조정 브랜치는 생기지 않았다.
  assert.equal(await git(root, 'branch', '--list', COORD_BRANCH), '')
  // 끝난 이관은 아무것도 읽고 쓰지 않는 것과 같다.
  oneShot.calls.length = 0
  const again = await migrateSpec({ targetRoot: root }, { coord: oneShot.open })
  assert.deepEqual([again.applied, again.sessions.moved, again.sessions.published, oneShot.calls], [[], [], null, [`open ${COORD_BRANCH} push:true`, 'read']])
  assert.match(again.sessions.note, /옮길 세션 섹션\(active·inbox·log\)이 없습니다/)
})

test('migrateSpec --dry-run: 조정 브랜치도 STATE도 쓰지 않고 무엇이 옮겨질지만 보고한다', async (t) => {
  const { root, file, legacy } = await legacyProject(t)
  const coord = fakeCoord()
  const planned = await migrateSpec({ targetRoot: root, dryRun: true }, { coord: coord.open })
  assert.deepEqual(coord.calls, [`open ${COORD_BRANCH} push:true`, 'read'])
  assert.deepEqual([coord.text, await readFile(file, 'utf8'), await git(root, 'status', '--porcelain')], [EMPTY_SESSIONS, legacy, ''])
  assert.deepEqual(planned.applied, [{ id: 'sessions-branch', summary: sessionsBranch.summary, files: ['spec/STATE.md', `${COORD_BRANCH}:${SESSIONS_FILE}`] }])
  assert.deepEqual([planned.dryRun, planned.lint, planned.sessions.commit, planned.sessions.published], [true, null, null, null])
  assert.deepEqual(planned.sessions.moved, [{ section: 'active', rows: 1 }, { section: 'inbox', lines: 2 }, { section: 'log', lines: 2 }])
  assert.match(planned.sessions.note, /조정 브랜치 gusta의 SESSIONS\.md로 옮길 예정입니다: active 1행 · inbox 2줄 · log 2줄\./)
  // SETTINGS coord·coord-push가 조정 브랜치 이름과 원격 사용 여부를 정한다.
  await writeFile(path.join(root, 'spec/SETTINGS.md'), '# SETTINGS\n- coord: team/sessions\n- coord-push: false\n')
  const named = fakeCoord()
  const renamed = await migrateSpec({ targetRoot: root, dryRun: true }, { coord: named.open })
  assert.deepEqual(named.calls, ['open team/sessions push:false', 'read'])
  assert.deepEqual([renamed.sessions.branch, renamed.applied[0].files], ['team/sessions', ['spec/STATE.md', `team/sessions:${SESSIONS_FILE}`]])
  // 잘못된 SETTINGS: 조정 브랜치를 열지도 않는다.
  await writeFile(path.join(root, 'spec/SETTINGS.md'), '# SETTINGS\n- prune-branches: maybe\n')
  const refused = await migrateSpec({ targetRoot: root }, { coord: coord.open })
  assert.deepEqual([refused.ok, refused.applied, refused.sessions, coord.calls.length], [false, [], null, 2])
  assert.equal(await readFile(file, 'utf8'), legacy)
})

test('gusta migrate: 실제 저장소에서 조정 브랜치에 SESSIONS.md가 생기고 STATE에서 세 섹션이 사라지며 다른 것은 그대로다', async (t) => {
  const { root, file, clean, legacy } = await legacyProject(t)
  await writeFile(path.join(root, 'untracked.txt'), 'untracked\n')
  const checkout = async () => ({ head: await git(root, 'rev-parse', 'HEAD'), branch: await git(root, 'symbolic-ref', 'HEAD'), staged: await git(root, 'ls-files', '-s'),
    files: await Promise.all(['spec/FORMAT.md', 'spec/ssot/ARCH.md', 'spec/tasks/T001.example.md', 'untracked.txt'].map((name) => readFile(path.join(root, name), 'utf8'))) })
  const before = await checkout()
  const run = async (...flags) => JSON.parse((await execute(process.execPath, [cli, 'migrate', '--target', root, ...flags])).stdout)
  const planned = await run('--dry-run')
  assert.deepEqual([planned.sessions.branch, planned.sessions.commit, planned.applied.map((entry) => entry.id)], [COORD_BRANCH, null, ['sessions-branch']])
  assert.equal(await git(root, 'branch', '--list', COORD_BRANCH), '')
  assert.equal(await readFile(file, 'utf8'), legacy)

  const result = await run()
  assert.deepEqual([result.ok, result.dryRun, result.lint.ok], [true, false, true])
  assert.deepEqual(result.applied, [{ id: 'sessions-branch', summary: sessionsBranch.summary, files: ['spec/STATE.md', `${COORD_BRANCH}:${SESSIONS_FILE}`] }])
  assert.deepEqual(result.sessions.moved, [{ section: 'active', rows: 1 }, { section: 'inbox', lines: 2 }, { section: 'log', lines: 2 }])
  assert.deepEqual([result.sessions.branch, result.sessions.skipped, result.sessions.published], [COORD_BRANCH, null, { pushed: false, reason: 'no-remote', error: null, lost: [] }])
  // 조정 브랜치: SESSIONS.md 하나뿐인 뿌리 커밋, 코드와 히스토리를 공유하지 않는다.
  assert.equal(await git(root, 'rev-parse', COORD_BRANCH), result.sessions.commit)
  assert.equal(await git(root, 'ls-tree', '--name-only', '-r', COORD_BRANCH), SESSIONS_FILE)
  assert.equal(await git(root, 'rev-list', '--count', COORD_BRANCH), '1')
  await assert.rejects(execute('git', ['-C', root, 'merge-base', COORD_BRANCH, 'HEAD']))
  const doc = readSessions(`${await git(root, 'show', `${COORD_BRANCH}:${SESSIONS_FILE}`)}\n`)
  assert.deepEqual(doc.active, [{ ...K3F9, doing: 'T001' }])
  assert.deepEqual([doc.inbox.length, doc.log], [2, ['- 261013 T001 done', '- 261012 gusta-create-task ARCH']])
  // 작업 트리: STATE만 바뀌었고 세 섹션이 없다. HEAD·브랜치·index·다른 파일은 그대로다.
  assert.equal(await readFile(file, 'utf8'), clean)
  assert.doesNotMatch(clean, /^## (active|inbox|log)$/m)
  assert.equal(await git(root, 'status', '--porcelain'), 'M spec/STATE.md\n?? untracked.txt')
  assert.deepEqual(await checkout(), before)
  // 다시 돌리면 아무것도 바꾸지 않는다.
  const again = await run()
  assert.deepEqual([again.applied, again.sessions.moved, again.sessions.commit], [[], [], result.sessions.commit])
  assert.equal(await git(root, 'rev-parse', COORD_BRANCH), result.sessions.commit)
})

test('gusta migrate: 원격이 있으면 옮긴 조정 브랜치를 올리고, cfg 이관과 함께 적용한다', async (t) => {
  const { a, remote } = await machines(t)
  const result = await migrateSpec({ targetRoot: a })
  assert.deepEqual(result.applied.map((entry) => [entry.id, entry.files]), [['branch-settings', ['spec/STATE.md', 'spec/SETTINGS.md']], ['sessions-branch', ['spec/STATE.md', `${COORD_BRANCH}:${SESSIONS_FILE}`]]])
  assert.deepEqual(result.sessions.moved, [{ section: 'log', lines: 1 }])
  assert.deepEqual(result.sessions.published, { pushed: true, reason: null, error: null, lost: [] })
  assert.equal((await execute('git', ['--git-dir', remote, 'rev-parse', COORD_BRANCH])).stdout.trim(), result.sessions.commit)
  assert.equal((await execute('git', ['--git-dir', remote, 'show', `${COORD_BRANCH}:${SESSIONS_FILE}`])).stdout, `${EMPTY_SESSIONS}\n## log\n- 261012 gusta-create-task ARCH\n`)
  // 코드 브랜치는 올리지 않았다: STATE·SETTINGS는 커밋되지 않은 작업 트리 변경으로 남는다.
  assert.equal((await execute('git', ['--git-dir', remote, 'rev-parse', 'main'])).stdout.trim(), await git(a, 'rev-parse', 'HEAD'))
  assert.equal(await git(a, 'status', '--porcelain'), 'M spec/STATE.md\n?? spec/SETTINGS.md')
  assert.doesNotMatch(await readFile(path.join(a, 'spec/STATE.md'), 'utf8'), /^## log$|^- push:/m)
})

test('gusta migrate: 두 번째 checkout은 이미 해소된 inbox 줄과 끝난 세션 행을 되살려 올리지 않는다 — fetch 전이어도', async (t) => {
  const legacy = MACHINES_STATE.replace('## ssot', `${ACTIVE.replace('k3f9', 'zz11').replace('T002', '-')}## inbox\n- 261013 parked T002: needs the owner\n- 261013 suggest -: keep me\n\n## ssot`)
  for (const fetchFirst of [true, false]) {
    const { a, b, remote } = await machines(t, { state: legacy })
    const remoteDoc = async () => readSessions(`${(await execute('git', ['--git-dir', remote, 'show', `${COORD_BRANCH}:${SESSIONS_FILE}`])).stdout}`)
    // A가 먼저 이관해 올리고, owner가 parked 줄을 해소하고, zz11 세션이 끝났다.
    assert.equal((await migrateSpec({ targetRoot: a })).sessions.published.pushed, true)
    assert.deepEqual((await remoteDoc()).active.map((row) => row.tag), ['zz11'])
    await vibeInbox({ targetRoot: a, step: 'resolve', line: '- 261013 parked T002: needs the owner', log: 'inbox confirmed: T002' })
    await vibeBeat({ targetRoot: a, tag: 'zz11', end: true })
    const settled = await remoteDoc()
    assert.deepEqual([settled.active, settled.inbox], [[], ['- 261013 suggest -: keep me']])
    // B의 STATE에는 아직 옛 섹션이 있다(이관 커밋을 받지 않은 브랜치).
    if (fetchFirst) await git(b, 'fetch', '-q', 'origin')
    const result = await migrateSpec({ targetRoot: b })
    assert.deepEqual([result.ok, result.applied.map((entry) => entry.id)], [true, ['branch-settings', 'sessions-branch']])
    assert.deepEqual(result.sessions.dropped, [{ section: 'active', rows: 1 }, { section: 'inbox', lines: 2 }, { section: 'log', lines: 1 }])
    assert.match(result.sessions.note, /이미 조정 브랜치에 있던/)
    // 원격에는 아무것도 되살아나지 않았고, B의 STATE에서는 섹션이 빠졌다.
    const doc = await remoteDoc()
    assert.deepEqual([doc.active, doc.inbox, doc.log.map((line) => line.slice(9))], [[], ['- 261013 suggest -: keep me'], ['inbox confirmed: T002', 'gusta-create-task ARCH']], `fetchFirst ${fetchFirst}`)
    assert.doesNotMatch(await readFile(path.join(b, 'spec/STATE.md'), 'utf8'), /^## (active|inbox|log)$/m)
    // 다시 돌려도 같다.
    assert.deepEqual((await migrateSpec({ targetRoot: b })).applied, [])
  }
})

test('migrateSpec: 히스토리 조회는 주입할 수 있다', async (t) => {
  const { root, file, clean } = await legacyProject(t)
  const coord = fakeCoord({ text: apply(EMPTY_SESSIONS, { type: 'log', line: '- 261020 later' }) })
  const asked = []
  const result = await migrateSpec({ targetRoot: root }, { coord: coord.open, history: async (store) => { asked.push(store.branch); return { existed: true, lines: ['- 261013 T001 done', '- 261012 gusta-create-task ARCH'] } } })
  // 읽은 뒤 브랜치가 그대로면 한 번만 묻는다.
  assert.deepEqual(asked, [COORD_BRANCH])
  const doc = readSessions(coord.text)
  assert.deepEqual([doc.active, doc.inbox.length, doc.log], [[], 2, ['- 261020 later']])
  assert.equal(await readFile(file, 'utf8'), clean)
  assert.deepEqual(result.sessions.dropped, [{ section: 'active', rows: 1 }, { section: 'log', lines: 2 }])
})

test('gusta migrate: Git 저장소가 아니면 세션 이관을 건너뛰고 이유를 보고한다', async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'gusta-migrate-plain-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(path.join(root, 'spec'), { recursive: true })
  const cfg = LEGACY.replace('- lang: ko\n', '- lang: ko\n- push: next\n')
  await writeFile(path.join(root, 'spec/STATE.md'), cfg)
  const opened = []
  const result = await migrateSpec({ targetRoot: root }, { coord: async (context) => { opened.push(context); throw new Error('no coordination branch outside Git') } })
  assert.deepEqual(opened, [])
  // 조정 브랜치가 필요 없는 이관은 그대로 적용되고, 세션 섹션은 STATE에 남는다.
  assert.deepEqual(result.applied.map((entry) => entry.id), ['branch-settings'])
  assert.equal(await readFile(path.join(root, 'spec/STATE.md'), 'utf8'), LEGACY)
  assert.deepEqual(result.sessions, { branch: null, moved: [], commit: null, published: null, skipped: 'not-git',
    note: 'Git checkout이 아니어서 STATE의 active·inbox·log를 옮기지 않았습니다 — 조정 브랜치는 Git 저장소에만 둘 수 있습니다.' })
})
