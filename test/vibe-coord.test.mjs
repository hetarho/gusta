import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { vibeStatus, vibeSync, vibePush, vibeClaim, vibeBeat, vibeCheckpoint, vibePreflight } from '../src/vibe.mjs'
import { vibeTask } from '../src/vibe-task.mjs'
import { vibeInbox, vibeLog } from '../src/vibe-inbox.mjs'
import { vibePrune } from '../src/prune.mjs'
import { vibeSettings } from '../src/settings.mjs'
import { readSessions, ClaimError } from '../src/coord-doc.mjs'
import { upsertActive } from '../src/state-doc.mjs'
import { fixture, machines, git, execute } from './helpers/vibe-fixture.mjs'

const cli = fileURLToPath(new URL('../bin/gusta.mjs', import.meta.url))
const NOW = '2026-10-13T07:44:00Z'
const clock = (iso) => ({ coord: { now: () => new Date(iso) } })
const minutes = (count) => `${new Date(Date.now() + count * 60000).toISOString().slice(0, 16)}Z`
const sessions = async (root, branch = 'gusta') => readSessions(await git(root, 'show', `${branch}:SESSIONS.md`))
const commits = (root) => git(root, 'rev-list', '--count', 'gusta')
const commitAll = async (root, message) => { await git(root, 'add', '-A'); await git(root, 'commit', '-q', '-m', message); return git(root, 'rev-parse', 'HEAD') }
const edit = async (file, change) => writeFile(file, change(await readFile(file, 'utf8')))
const finish = (content) => content.replace(/- \[ \]/g, '- [v]').replace(/## result\n*$/, '## result\n- outcome: works\n- at: -\n- verified: unit tests\n- limits: -\n')
const refused = (expected) => (error) => error instanceof ClaimError && Object.entries(expected).every(([key, value]) => error[key] === value)
const record = (root) => path.join(root, '.git/gusta/v1/coord.json')
// The remote backoff a failed publish left has run out (REMOTE_BACKOFF_MINUTES later).
const backoffOver = async (root) => {
  const current = JSON.parse(await readFile(record(root), 'utf8').catch(() => '{}'))
  delete current.backoff
  await writeFile(record(root), JSON.stringify(current))
}
// The remote cannot be reached while `run` runs; afterwards it is back and the backoff is over.
const offline = async (root, run) => {
  const url = await git(root, 'remote', 'get-url', 'origin')
  await git(root, 'remote', 'set-url', 'origin', path.join(path.dirname(url), 'gone.git'))
  try { return await run() } finally { await git(root, 'remote', 'set-url', 'origin', url); await backoffOver(root) }
}

test('같은 clone의 두 worktree: 동시 선점은 하나만 성공하고 push 없이 status에 서로 보인다', async (t) => {
  const { root, temporary } = await fixture(t)
  const trees = { aaaa: path.join(temporary, 'tree a'), bbbb: path.join(temporary, 'tree b') }
  for (const [tag, tree] of Object.entries(trees)) await git(root, 'worktree', 'add', '-q', '-b', `feat/${tag}`, tree)
  await Promise.all(Object.entries(trees).map(([tag, tree]) => vibeBeat({ targetRoot: tree, tag, mode: 'autopilot', host: `host-${tag}` })))
  const results = await Promise.allSettled(Object.entries(trees).map(([tag, tree]) => vibeClaim({ targetRoot: tree, tag, task: 'T001' })))
  const won = Object.keys(trees).filter((tag, index) => results[index].status === 'fulfilled')
  assert.equal(won.length, 1, results.map((result) => result.reason?.stack ?? result.status).join('\n'))
  const [winner] = won, loser = Object.keys(trees).find((tag) => tag !== winner)
  assert.ok(refused({ task: 'T001', owner: winner, reason: 'claimed', lost: false })(results.find((result) => result.status === 'rejected').reason))
  // 진 쪽의 status: 이긴 세션이 어디서(브랜치·커밋) 무엇을 하는지 보이고, 그 태스크는 실행 대상에서 빠진다.
  const status = await vibeStatus({ targetRoot: trees[loser], tag: loser })
  assert.deepEqual(status.others.map((row) => [row.tag, row.host, row.doing, row.branch, row.commit, row.pushed, row.stale]),
    [[winner, `host-${winner}`, 'T001', `feat/${winner}`, await git(root, 'rev-parse', '--short=12', 'HEAD'), null, false]])
  assert.deepEqual([status.self.doing, status.held, status.runnable, status.concurrency], ['-', [{ id: 'T001', tag: winner, reason: 'claimed' }], ['T002', 'T003'], 'strict'])
  assert.deepEqual([status.coordination.branch, status.coordination.legacy, status.coordination.lost, status.coordination.contested], ['gusta', [], [], []])
  assert.deepEqual([status.coordination.push.enabled, status.coordination.push.remote, status.coordination.push.reason, status.coordination.push.unpublished], [false, null, 'no-remote', false])
  // 이긴 쪽에는 자기 태스크가 그대로 실행 대상이다. 원래 checkout에서도 둘 다 보인다.
  const own = await vibeStatus({ targetRoot: trees[winner], tag: winner })
  assert.deepEqual([own.self.doing, own.held, own.runnable], ['T001', [], ['T001', 'T002', 'T003']])
  assert.deepEqual((await vibeStatus({ targetRoot: root })).others.map((row) => `${row.tag}:${row.doing}`).sort(), [`${winner}:T001`, `${loser}:-`].sort())
  // 조정 브랜치는 SESSIONS.md 하나뿐이고 어느 worktree도 그 브랜치로 바뀌지 않았다.
  assert.equal(await git(root, 'ls-tree', '-r', '--name-only', 'gusta'), 'SESSIONS.md')
  for (const tree of [root, ...Object.values(trees)]) assert.equal(await git(tree, 'status', '--porcelain'), '')
  // --doing -로 놓으면 다른 세션이 잡을 수 있다. vibe beat --doing T###도 선점이라 잡힌 것은 거절한다.
  await assert.rejects(vibeBeat({ targetRoot: trees[loser], tag: loser, doing: 'T001' }), refused({ owner: winner, reason: 'claimed' }))
  await vibeBeat({ targetRoot: trees[winner], tag: winner, doing: '-' })
  assert.equal((await vibeBeat({ targetRoot: trees[loser], tag: loser, doing: 'T001' })).row.doing, 'T001')
})

test('기기 a·b: push되지 않은 작업 브랜치의 세션이 다른 기기 status에 pushed:false로 보인다', async (t) => {
  const { a, b, remote } = await machines(t)
  await git(a, 'checkout', '-q', '-b', 'feat/x')
  await writeFile(path.join(a, 'x.txt'), 'local only\n')
  const head = await commitAll(a, 'work that is not pushed')
  const beat = await vibeBeat({ targetRoot: a, tag: 'aaaa', mode: 'pair', host: 'machine-a' })
  assert.deepEqual([beat.row.branch, beat.row.commit, beat.coordination.push, beat.coordination.unpublished], ['feat/x', head.slice(0, 12), { pushed: true }, false])
  // 원격에는 조정 브랜치만 올라갔다: 코드 브랜치도, 그 커밋도 없다.
  assert.equal(await git(remote, 'for-each-ref', '--format=%(refname:short)', 'refs/heads'), 'gusta\nmain')
  const seen = (await vibeStatus({ targetRoot: b, tag: 'bbbb' })).others
  assert.deepEqual(seen.map((row) => [row.tag, row.branch, row.commit, row.pushed]), [['aaaa', 'feat/x', head.slice(0, 12), false]])
  // 브랜치를 올리면 그 커밋이 원격에 있다고 보인다.
  await git(a, 'push', '-q', 'origin', 'feat/x')
  assert.equal((await vibeStatus({ targetRoot: b, tag: 'bbbb' })).others[0].pushed, true)
  // 커밋이 움직인 beat는 사건이다: 새 커밋이 다시 pushed:false로 보인다.
  await writeFile(path.join(a, 'x.txt'), 'more\n')
  const next = await commitAll(a, 'more local work')
  assert.equal((await vibeBeat({ targetRoot: a, tag: 'aaaa' })).changed, true)
  assert.deepEqual((await vibeStatus({ targetRoot: b, tag: 'bbbb' })).others.map((row) => [row.commit, row.pushed]), [[next.slice(0, 12), false]])
  // b의 작업 트리·브랜치는 그대로다(조정 브랜치를 받아 왔을 뿐).
  assert.deepEqual([await git(b, 'symbolic-ref', '--short', 'HEAD'), await git(b, 'status', '--porcelain')], ['main', ''])
})

test('원격 선점: 먼저 올린 쪽이 이기고, 닿지 못한 push는 작업을 막지 않고 unpublished로 남는다', async (t) => {
  const { a, b, remote } = await machines(t)
  await vibeBeat({ targetRoot: a, tag: 'aaaa', mode: 'autopilot' })
  await vibeStatus({ targetRoot: b, tag: 'bbbb' })
  await vibeBeat({ targetRoot: b, tag: 'bbbb', mode: 'autopilot' })
  await vibeStatus({ targetRoot: a, tag: 'aaaa' })
  // a는 원격에 닿지 못한 채 선점하고 시작한다: 로컬 선점은 유지되고 unpublished로 알린다.
  const started = await offline(a, () => vibeTask({ targetRoot: a, step: 'start', task: 'T001', tag: 'aaaa' }))
  assert.deepEqual([started.st.startsWith('doing@'), started.coordination.changed, started.coordination.push.pushed, started.coordination.unpublished], [true, true, false, true])
  assert.ok(['network', 'fetch-failed'].includes(started.coordination.push.reason), JSON.stringify(started.coordination.push))
  assert.equal((await sessions(a)).active.find((row) => row.tag === 'aaaa').doing, 'T001')
  // 그사이 b가 같은 태스크를 잡아 먼저 올린다.
  const claimed = await vibeClaim({ targetRoot: b, tag: 'bbbb', task: 'T001' })
  assert.deepEqual([claimed.claimed, claimed.unpublished, claimed.coordination.push.pushed], [true, false, true])
  // a가 다시 닿으면 원격이 이긴다: 선점은 풀리고 lost로 알린다 — 그 뒤에도 계속(작업 트리는 여전히 자기 것이라 말하므로).
  const first = await vibeStatus({ targetRoot: a, tag: 'aaaa' })
  assert.deepEqual(first.coordination.lost, [{ task: 'T001', owner: 'bbbb', reason: 'claimed' }])
  assert.deepEqual([first.coordination.sync.action, first.self.doing, first.held, first.runnable, first.implementation.resume], ['merge', '-', [{ id: 'T001', tag: 'bbbb', reason: 'claimed' }], ['T002'], ['T001']])
  assert.deepEqual((await vibeStatus({ targetRoot: a, tag: 'aaaa' })).coordination.lost, [{ task: 'T001', owner: 'bbbb', reason: 'claimed' }])
  await assert.rejects(vibeClaim({ targetRoot: a, tag: 'aaaa', task: 'T001' }), refused({ owner: 'bbbb', reason: 'claimed', lost: false }))
  // 다음 사건이 밀린 것까지 올린다.
  const parked = await vibeInbox({ targetRoot: a, step: 'add', kind: 'parked', ref: ['T001'], text: 'lost to bbbb; reverted', tag: 'aaaa' })
  assert.deepEqual([parked.coordination.push.pushed, parked.coordination.unpublished], [true, false])
  assert.equal(await git(remote, 'rev-parse', 'gusta'), await git(a, 'rev-parse', 'gusta'))
  assert.deepEqual((await sessions(remote)).active.map((row) => `${row.tag}:${row.doing}`).sort(), ['aaaa:-', 'bbbb:T001'])
})

test('coord-push false: 이 clone 안에서만 조정하고 조정 브랜치를 fetch·push하지 않는다', async (t) => {
  const { a, remote, temporary } = await machines(t)
  await writeFile(path.join(a, 'spec/SETTINGS.md'), '# SETTINGS\n- land: main\n- push: true\n- coord-push: false\n')
  await commitAll(a, 'settings')
  const never = { coord: { remote: async () => { throw new Error('the coordination branch must not reach the remote') } } }
  await vibeBeat({ targetRoot: a, tag: 'aaaa', mode: 'pair' }, never)
  const claimed = await vibeClaim({ targetRoot: a, tag: 'aaaa', task: 'T001' }, never)
  assert.deepEqual([claimed.claimed, claimed.unpublished, claimed.coordination.push], [true, false, { pushed: false, reason: 'disabled' }])
  await vibeInbox({ targetRoot: a, step: 'add', kind: 'suggest', text: 'tidy the fixtures' }, never)
  const status = await vibeStatus({ targetRoot: a, tag: 'aaaa' }, never)
  assert.deepEqual([status.coordination.push, status.coordination.sync], [{ enabled: false, remote: 'origin', reason: 'disabled', unpublished: false, last: status.coordination.push.last }, { action: 'none', reason: 'disabled' }])
  assert.equal(status.self.doing, 'T001')
  // 코드 push는 제 설정대로 간다: land는 올라가고 조정 브랜치는 원격에 없다.
  const pushed = await vibePush({ targetRoot: a })
  assert.equal(pushed.pushed, await git(a, 'rev-parse', 'HEAD'))
  assert.equal(await git(remote, 'for-each-ref', '--format=%(refname:short)', 'refs/heads'), 'main')
  assert.equal(await git(a, 'for-each-ref', 'refs/remotes/origin/gusta'), '')
  // 같은 clone의 다른 worktree는 그대로 본다.
  const other = path.join(temporary, 'other tree')
  await git(a, 'worktree', 'add', '-q', '-b', 'feat/other', other)
  assert.deepEqual((await vibeStatus({ targetRoot: other, tag: 'bbbb' }, never)).held, [{ id: 'T001', tag: 'aaaa', reason: 'claimed' }])
})

test('vibe inbox add·resolve·list와 vibe log: 쓰는 시점에 형식과 참조를 검사하고 한 번 호출로 끝난다', async (t) => {
  const { root, temporary } = await fixture(t)
  const at = clock(NOW)
  // 따옴표·|·백틱이 섞인 본문은 파일로 받는다.
  const bodyFile = path.join(temporary, 'body.txt')
  await writeFile(bodyFile, 'runtime → node "LTS" | alt: `deno` (owner\'s call: yes/no)\n')
  const decided = await vibeInbox({ targetRoot: root, step: 'add', kind: 'decided', ref: ['ARCH-1', 'T001'], file: bodyFile, tag: 'aaaa' }, at)
  assert.deepEqual([decided.ok, decided.added, decided.line], [true, true, '- 261013 decided ARCH-1 T001: runtime → node "LTS" | alt: `deno` (owner\'s call: yes/no)'])
  assert.deepEqual([decided.coordination.branch, decided.coordination.changed, decided.coordination.push], ['gusta', true, { pushed: false, reason: 'no-remote' }])
  assert.match(decided.id, /^[0-9a-f]{8}$/)
  // 같은 줄은 두 번 쌓이지 않는다.
  assert.equal((await vibeInbox({ targetRoot: root, step: 'add', kind: 'decided', ref: ['ARCH-1', 'T001'], file: bodyFile }, at)).added, false)
  const parked = await vibeInbox({ targetRoot: root, step: 'add', kind: 'parked', ref: ['T002'], text: 'needs the owner: billing change' }, at)
  const plain = await vibeInbox({ targetRoot: root, step: 'add', kind: 'suggest', text: 'tidy the fixtures' }, at)
  assert.equal(plain.line, '- 261013 suggest -: tidy the fixtures')
  // 형식·참조 오류는 아무것도 쓰지 않는다: 이 checkout에 없는 태스크·결정·문서, 알 수 없는 kind, 여러 줄, 빈 본문.
  const before = await commits(root)
  const add = (extra) => vibeInbox({ targetRoot: root, step: 'add', kind: 'parked', text: 'x', ...extra }, at)
  await assert.rejects(add({ ref: ['T999'] }), (error) => /이 checkout에 없습니다/.test(error.message) && /T999/.test(error.details[0]))
  await assert.rejects(add({ ref: ['ARCH-9'] }), (error) => /ARCH-9: 이 checkout의 ssot에 없는 결정/.test(error.details[0]))
  await assert.rejects(add({ ref: ['review/missing'] }), (error) => /review\/missing: 문서가 없습니다/.test(error.details[0]))
  await assert.rejects(add({ ref: ['whatever'] }), (error) => /알 수 없는 참조/.test(error.details[0]))
  await assert.rejects(add({ kind: 'done' }), /--kind는 decided\|parked\|suggest/)
  await assert.rejects(add({ text: 'two\nlines' }), /한 줄입니다/)
  await assert.rejects(add({ text: '   ' }), /비어 있습니다/)
  await assert.rejects(add({ text: undefined }), /비어 있습니다/)
  await assert.rejects(add({ file: path.join(temporary, 'missing.txt'), text: undefined }), /--file을 읽지 못했습니다/)
  await assert.rejects(vibeInbox({ targetRoot: root, step: 'add', line: 'parked without a date' }, at), /inbox 줄 형식 오류/)
  await assert.rejects(vibeInbox({ targetRoot: root, step: 'add', line: '- 261013 parked T999: gone' }, at), /이 checkout에 없습니다/)
  await assert.rejects(vibeInbox({ targetRoot: root, step: 'move' }, at), /vibe inbox add/)
  assert.equal(await commits(root), before)
  // 완성된 줄(--line)은 그대로 들어간다. 완료 태스크도 참조할 수 있다.
  await mkdir(path.join(root, 'spec/tasks/done'), { recursive: true })
  await writeFile(path.join(root, 'spec/tasks/done/T000.seed.md'), '# T000 seed\n> st:done@261001 | ssot:ARCH-1 | base:ARCH@1 | dep:-\n')
  assert.equal((await vibeInbox({ targetRoot: root, step: 'add', line: '- 261001 decided T000: kept as is (alt: redo)' }, at)).added, true)
  // list: id·kind·refs·text, kind·ref로 거른다.
  const listed = await vibeInbox({ targetRoot: root, step: 'list' })
  assert.deepEqual(listed.inbox.map((entry) => [entry.kind, entry.refs, entry.id.length]), [['decided', ['ARCH-1', 'T001'], 8], ['parked', ['T002'], 8], ['suggest', ['-'], 8], ['decided', ['T000'], 8]])
  assert.deepEqual([listed.count, listed.coordination.branch, listed.coordination.legacy], [4, 'gusta', []])
  assert.deepEqual((await vibeInbox({ targetRoot: root, step: 'list', kind: 'parked' })).inbox.map((entry) => entry.line), [parked.line])
  assert.deepEqual((await vibeInbox({ targetRoot: root, step: 'list', ref: ['T001'] })).inbox.map((entry) => entry.id), [decided.id])
  // status: 결정함 요약과 주차된 태스크 제외가 조정 브랜치의 inbox를 따른다.
  const status = await vibeStatus({ targetRoot: root, tag: 'aaaa' })
  assert.deepEqual([status.counts.inbox, status.counts.parked, status.runnable, status.inbox[0].id, status.inboxMore], [4, 1, ['T001', 'T003'], decided.id, true])
  assert.deepEqual((await vibeStatus({ targetRoot: root, section: 'inbox' })).inbox.map((entry) => entry.line), listed.inbox.map((entry) => entry.line))
  // resolve: id로 지우고 같은 호출에서 log 한 줄을 남긴다.
  const resolved = await vibeInbox({ targetRoot: root, step: 'resolve', id: [decided.id, parked.id], log: 'inbox confirmed: ARCH-1 node, T002 billing', tag: 'aaaa' }, at)
  assert.deepEqual([resolved.ok, resolved.resolved, resolved.missing, resolved.logged], [true, [decided.line, parked.line], [], true])
  assert.deepEqual((await sessions(root)).inbox, [plain.line, '- 261001 decided T000: kept as is (alt: redo)'])
  assert.deepEqual((await sessions(root)).log, ['- 261013 inbox confirmed: ARCH-1 node, T002 billing'])
  // 이미 없는 줄은 missing으로 알리고 log도 남기지 않는다. --line·--file로도 지운다.
  const gone = await vibeInbox({ targetRoot: root, step: 'resolve', id: [decided.id], log: 'again' }, at)
  assert.deepEqual([gone.ok, gone.resolved, gone.missing, gone.logged, gone.coordination.changed], [false, [], [decided.id], false, false])
  const linesFile = path.join(temporary, 'lines.txt')
  await writeFile(linesFile, `${plain.line}\n`)
  assert.deepEqual((await vibeInbox({ targetRoot: root, step: 'resolve', file: linesFile }, at)).resolved, [plain.line])
  assert.deepEqual((await vibeInbox({ targetRoot: root, step: 'resolve', line: '- 261001 decided T000: kept as is (alt: redo)' }, at)).resolved, ['- 261001 decided T000: kept as is (alt: redo)'])
  await assert.rejects(vibeInbox({ targetRoot: root, step: 'resolve' }, at), /--id <id>/)
  assert.deepEqual((await sessions(root)).inbox, [])
  // log: 최신이 위. 본문 없이 부르면 목록이다. 본문은 --file로도.
  const logged = await vibeLog({ targetRoot: root, text: 'fix build: pin the "node" image | ci' }, at)
  assert.deepEqual([logged.ok, logged.line, logged.coordination.push.reason], [true, '- 261013 fix build: pin the "node" image | ci', 'deferred'])
  await writeFile(bodyFile, 'design hero: larger type\n')
  await vibeLog({ targetRoot: root, file: bodyFile }, clock('2026-10-14T01:00:00Z'))
  assert.deepEqual((await vibeLog({ targetRoot: root })).log, ['- 261014 design hero: larger type', '- 261013 fix build: pin the "node" image | ci', '- 261013 inbox confirmed: ARCH-1 node, T002 billing'])
  await assert.rejects(vibeLog({ targetRoot: root, text: 'two\nlines' }), /한 줄입니다/)
  // 작업 트리에는 아무것도 쓰지 않았다(테스트가 둔 완료 태스크 파일만 미추적).
  assert.equal(await git(root, 'status', '--porcelain'), '?? spec/tasks/done/')
})

test('task-done → unlanded → landed: 끝낸 태스크는 land에 들어갈 때까지 다른 세션이 다시 집지 못한다', async (t) => {
  const { a, b } = await machines(t)
  await vibeBeat({ targetRoot: a, tag: 'aaaa', mode: 'autopilot' })
  await vibeTask({ targetRoot: a, step: 'start', task: 'T001', tag: 'aaaa' })
  await writeFile(path.join(a, 'first.txt'), 'done\n')
  const work = await commitAll(a, 'T001 work')
  await edit(path.join(a, 'spec/tasks/T001.first.md'), finish)
  const closed = await vibeTask({ targetRoot: a, step: 'done', task: 'T001', tag: 'aaaa', at: 'HEAD' })
  assert.deepEqual([closed.st.startsWith('done@'), closed.coordination.changed, closed.coordination.push.pushed], [true, true, true])
  const doc = await sessions(a)
  assert.deepEqual(doc.unlanded.map((row) => [row.id, row.tag, row.branch, row.commit]), [['T001', 'aaaa', 'main', work.slice(0, 12)]])
  assert.deepEqual([doc.active.map((row) => `${row.tag}:${row.doing}`), doc.log.length], [['aaaa:-'], 1])
  // b의 checkout은 아직 T001이 todo다. 조정 브랜치가 막는다: 실행 대상에서 빠지고 선점도 거절된다.
  let status = await vibeStatus({ targetRoot: b, tag: 'bbbb' })
  assert.deepEqual([status.implementation.todo, status.held, status.runnable], [['T001', 'T002'], [{ id: 'T001', tag: 'aaaa', reason: 'unlanded' }], ['T002']])
  assert.deepEqual(status.unlanded.map((row) => [row.id, row.tag, row.branch, row.pushed]), [['T001', 'aaaa', 'main', false]])
  await assert.rejects(vibeClaim({ targetRoot: b, tag: 'bbbb', task: 'T001', mode: 'pair' }), refused({ owner: 'aaaa', reason: 'unlanded' }))
  // 끝낸 세션 자신에게는 막힌 일이 아니다.
  assert.deepEqual((await vibeStatus({ targetRoot: a, tag: 'aaaa' })).held, [])
  // a가 마감 커밋을 land에 올리면 unlanded에서 빠진다(원격에도).
  await commitAll(a, 'T001 done')
  const pushed = await vibePush({ targetRoot: a })
  assert.deepEqual([pushed.coordination.landed, pushed.coordination.waiting, pushed.coordination.push.pushed], [['T001'], [], true])
  assert.deepEqual((await sessions(a)).unlanded, [])
  // 올릴 것이 없는 push는 조정 브랜치를 건드리지 않고 결과에 coordination도 없다.
  const idle = await commits(a)
  assert.equal((await vibePush({ targetRoot: a })).coordination, undefined)
  assert.equal(await commits(a), idle)
  // b는 land를 아직 받지 않았다: 이제 land에 보관된 태스크라 받을 때까지 막는다(landed).
  status = await vibeStatus({ targetRoot: b, tag: 'bbbb' })
  assert.deepEqual([status.unlanded, status.git.behind, status.held, status.runnable], [[], 2, [{ id: 'T001', tag: null, reason: 'landed' }], ['T002']])
  await vibeSync({ targetRoot: b })
  status = await vibeStatus({ targetRoot: b, tag: 'bbbb' })
  assert.deepEqual([status.remaining.map((task) => task.id), status.held, status.runnable], [['T002'], [], ['T002']])
})

test('로컬 land(push false)와 land가 현재 브랜치인 경우에도 반영되면 unlanded에서 빠진다', async (t) => {
  const { root } = await fixture(t, 2)
  await writeFile(path.join(root, 'spec/SETTINGS.md'), '# SETTINGS\n- land: next\n- push: false\n')
  await commitAll(root, 'settings')
  await git(root, 'branch', 'next')
  await git(root, 'checkout', '-q', '-b', 'feat/one')
  const close = async (id) => {
    await vibeTask({ targetRoot: root, step: 'start', task: id, tag: 'aaaa' })
    await edit(path.join(root, `spec/tasks/${id}.example.md`), finish)
    return vibeTask({ targetRoot: root, step: 'done', task: id, tag: 'aaaa' })
  }
  // 등록하지 않은 세션이어도 끝낸 태스크는 unlanded에 남는다.
  assert.equal((await close('T001')).coordination.changed, true)
  assert.deepEqual((await sessions(root)).unlanded.map((row) => [row.id, row.tag, row.branch]), [['T001', 'aaaa', 'feat/one']])
  // 마감을 커밋하기 전에는 land에 올려도 그 태스크는 아직 반영된 것이 아니다.
  await git(root, 'stash', '-q', '--include-untracked')
  const early = await vibePush({ targetRoot: root })
  assert.deepEqual([early.mode, early.coordination.landed, early.coordination.waiting], ['local', [], ['T001']])
  await git(root, 'stash', 'pop', '-q')
  await commitAll(root, 'T001 done')
  const landed = await vibePush({ targetRoot: root })
  assert.deepEqual([landed.mode, landed.target, landed.coordination.landed], ['local', 'next', ['T001']])
  assert.deepEqual((await sessions(root)).unlanded, [])
  // land가 지금 브랜치(current)면 커밋된 것이 곧 반영이다.
  await vibeSettings({ targetRoot: root, set: ['land=current'] })
  await close('T002')
  await commitAll(root, 'T002 done')
  const stayed = await vibePush({ targetRoot: root })
  assert.deepEqual([stayed.reason, stayed.coordination.landed], ['push-disabled', ['T002']])
})

test('at만 바뀐 beat는 커밋하지 않고, 세션 시작·끝과 doing·커밋이 바뀐 beat만 남는다', async (t) => {
  const { a, remote } = await machines(t)
  const first = await vibeBeat({ targetRoot: a, tag: 'aaaa', mode: 'pair', host: 'mbp' }, clock(NOW))
  assert.deepEqual([first.changed, first.row.since, first.row.at, first.coordination.push.pushed], [true, '2026-10-13T07:44Z', '2026-10-13T07:44Z', true])
  const count = await commits(a)
  const idle = await vibeBeat({ targetRoot: a, tag: 'aaaa' }, clock('2026-10-13T08:10:00Z'))
  assert.deepEqual([idle.changed, idle.row.at, idle.coordination.changed, idle.coordination.push], [false, '2026-10-13T07:44Z', false, { pushed: false, reason: 'unchanged' }])
  assert.equal(await commits(a), count)
  // 다시 등록해도(같은 mode) 달라진 것이 없으면 마찬가지다.
  assert.equal((await vibeBeat({ targetRoot: a, tag: 'aaaa', mode: 'pair' }, clock('2026-10-13T08:13:00Z'))).changed, false)
  assert.equal(await commits(a), count)
  // 커밋이 움직이면 사건이다: at도 함께 간다.
  await writeFile(path.join(a, 'work.txt'), 'x\n')
  const head = await commitAll(a, 'work')
  const moved = await vibeBeat({ targetRoot: a, tag: 'aaaa' }, clock('2026-10-13T08:20:00Z'))
  assert.deepEqual([moved.changed, moved.row.commit, moved.row.since, moved.row.at], [true, head.slice(0, 12), '2026-10-13T07:44Z', '2026-10-13T08:20Z'])
  assert.equal(Number(await commits(a)), Number(count) + 1)
  // 행이 30분 넘게 묵으면 at만 바뀐 beat도 생존 신호로 남긴다(잠시 멈췄다 돌아온 세션이 죽은 세션으로 보이지 않게).
  const alive = await vibeBeat({ targetRoot: a, tag: 'aaaa' }, clock('2026-10-13T08:51:00Z'))
  assert.deepEqual([alive.changed, alive.row.at, alive.coordination.push.pushed], [true, '2026-10-13T08:51Z', true])
  assert.equal((await vibeBeat({ targetRoot: a, tag: 'aaaa' }, clock('2026-10-13T09:10:00Z'))).changed, false)
  assert.equal(Number(await commits(a)), Number(count) + 2)
  // checkpoint는 at만 바뀌어도 사건이다: 행을 갱신해 올리고, 다른 기기의 오래된 세션 오판을 막는다.
  const snapshot = await vibeCheckpoint({ targetRoot: a, tag: 'aaaa' }, clock('2026-10-13T09:30:00Z'))
  assert.deepEqual([snapshot.coordination.changed, snapshot.coordination.push.pushed], [true, true])
  assert.equal((await sessions(remote)).active[0].at, '2026-10-13T09:30Z')
  // 행이 없는 세션의 checkpoint도 생존 신호다: 등록 이력이 없으면 pair로 등록하고 올린다.
  const unseen = await vibeCheckpoint({ targetRoot: a, tag: 'zzzz' }, clock('2026-10-13T09:31:00Z'))
  assert.deepEqual([unseen.coordination.skipped, unseen.coordination.changed, (await sessions(remote)).active.find((row) => row.tag === 'zzzz')?.mode], [undefined, true, 'pair'])
  await vibeBeat({ targetRoot: a, tag: 'zzzz', end: true }, clock('2026-10-13T09:32:00Z'))
  // 새 세션 행에는 mode가 필요하고, 끝내면 행이 사라진다.
  await assert.rejects(vibeBeat({ targetRoot: a, tag: 'bbbb' }), /--mode가 필요합니다/)
  const ended = await vibeBeat({ targetRoot: a, tag: 'aaaa', end: true })
  assert.deepEqual([ended.removed, ended.coordination.push.pushed], [true, true])
  assert.deepEqual((await sessions(remote)).active, [])
  assert.equal((await vibeBeat({ targetRoot: a, tag: 'aaaa', end: true })).removed, false)
})

test('죽은 세션 행은 다른 세션이 쓸 때 걷어 내고, 태스크를 쥔 오래된 행은 남긴다', async (t) => {
  const { root } = await fixture(t)
  await vibeBeat({ targetRoot: root, tag: 'dead', mode: 'pair' }, clock(minutes(-200)))
  await vibeBeat({ targetRoot: root, tag: 'held', mode: 'autopilot', doing: 'T002' }, clock(minutes(-200)))
  const written = await vibeBeat({ targetRoot: root, tag: 'aaaa', mode: 'pair' })
  assert.deepEqual(written.coordination.swept, ['dead'])
  assert.deepEqual((await sessions(root)).active.map((row) => `${row.tag}:${row.doing}`), ['held:T002', 'aaaa:-'])
  // 오래된 선점은 status에 stale로 보이고 실행 대상을 막지 않으며, 잡으면 풀린다.
  const status = await vibeStatus({ targetRoot: root, tag: 'aaaa' })
  assert.deepEqual([status.others.map((row) => [row.tag, row.stale]), status.held, status.concurrency], [[['held', true]], [], 'solo'])
  const taken = await vibeClaim({ targetRoot: root, tag: 'aaaa', task: 'T002' })
  assert.deepEqual([taken.released, taken.coordination.swept], [['held'], undefined])
  // 누가 쥐고 있었는지 남는다: 그 행은 같은 쓰기에서 걷지 않고(doing -), log에 한 줄.
  const doc = await sessions(root)
  assert.deepEqual([doc.active.map((row) => `${row.tag}:${row.doing}`), doc.log.map((line) => line.slice(9))], [['held:-', 'aaaa:T002'], ['released stale held from T002']])
  // tag를 모르는 쓰기는 아무 행도 걷지 않는다(자기 행일 수 있다). 다음 tag 있는 쓰기가 걷는다.
  await vibeInbox({ targetRoot: root, step: 'add', kind: 'suggest', text: 'tidy' })
  assert.deepEqual((await sessions(root)).active.map((row) => row.tag), ['held', 'aaaa'])
  assert.deepEqual((await vibeBeat({ targetRoot: root, tag: 'aaaa', doing: '-' })).coordination.swept, ['held'])
})

test('등록했던 세션의 행이 걷힌 뒤에도 task start·claim·checkpoint는 건너뛰지 않고 재등록해 선점한다', async (t) => {
  const { root, temporary } = await fixture(t)
  const other = path.join(temporary, 'other tree')
  await git(root, 'worktree', 'add', '-q', '-b', 'feat/other', other)
  // aa가 등록하고 90분 넘게 쉬었다. 그사이 tag 없는 자기 쓰기(inbox, vibe push의 landed 기록)는 aa 행을 걷지 않는다.
  await vibeBeat({ targetRoot: root, tag: 'aa', mode: 'autopilot', host: 'mbp' }, clock(minutes(-120)))
  await vibeInbox({ targetRoot: root, step: 'add', kind: 'suggest', text: 'tidy the fixtures' })
  await vibePush({ targetRoot: root })
  assert.deepEqual((await sessions(root)).active.map((row) => row.tag), ['aa'])
  // 다른 세션의 쓰기가 aa 행을 걷는다.
  assert.deepEqual((await vibeBeat({ targetRoot: other, tag: 'bb', mode: 'pair' })).coordination.swept, ['aa'])
  // aa의 task start: 건너뛰지 않는다 — 이 clone이 기억하는 host·mode로 다시 등록하고 선점한다.
  const started = await vibeTask({ targetRoot: root, step: 'start', task: 'T001', tag: 'aa' })
  assert.deepEqual([started.coordination.skipped, started.coordination.changed], [undefined, true])
  assert.deepEqual((await sessions(root)).active.map((row) => `${row.tag} ${row.host} ${row.mode} ${row.doing}`), ['bb ' + (await sessions(root)).active[0].host + ' pair -', 'aa mbp autopilot T001'])
  // 다른 worktree의 bb는 같은 태스크를 시작하지 못하고, 그 checkout의 파일도 그대로다.
  const before = await readFile(path.join(other, 'spec/tasks/T001.example.md'), 'utf8')
  await assert.rejects(vibeTask({ targetRoot: other, step: 'start', task: 'T001', tag: 'bb' }), refused({ owner: 'aa', reason: 'claimed' }))
  assert.equal(await readFile(path.join(other, 'spec/tasks/T001.example.md'), 'utf8'), before)
  // 등록 이력이 없는 tag는 pair로 등록된다(claim·checkpoint 모두).
  const fresh = await vibeClaim({ targetRoot: other, tag: 'cc', task: 'T002' })
  assert.deepEqual([fresh.claimed, fresh.row.mode], [true, 'pair'])
  // 끝낸 세션(beat --end)은 이력도 지운다: 같은 tag가 다시 오면 새 세션이다.
  await vibeBeat({ targetRoot: root, tag: 'aa', end: true })
  assert.equal(JSON.parse(await readFile(record(root), 'utf8')).sessions.aa, undefined)
  assert.equal((await vibeCheckpoint({ targetRoot: root, tag: 'aa' })).changed, true)
  assert.equal((await sessions(root)).active.find((row) => row.tag === 'aa').mode, 'pair')
})

test('작업 묶음의 unlanded tag work는 예약어다: 세션이 그 tag로 등록·선점·기록하지 못한다', async (t) => {
  const { root } = await fixture(t)
  for (const run of [() => vibeBeat({ targetRoot: root, tag: 'work', mode: 'pair' }), () => vibeClaim({ targetRoot: root, tag: 'work', task: 'T001' }),
    () => vibeTask({ targetRoot: root, step: 'start', task: 'T001', tag: 'work' }), () => vibeCheckpoint({ targetRoot: root, tag: 'work' }),
    () => vibeInbox({ targetRoot: root, step: 'add', kind: 'suggest', text: 'x', tag: 'work' })]) await assert.rejects(run(), /세션 tag work는 예약어/)
  assert.equal(await git(root, 'status', '--porcelain'), '')
  assert.equal(await git(root, 'branch', '--list', 'gusta'), '')
})

test('원격 backoff: 닿지 못한 publish 뒤 10분은 원격을 부르지 않고, status·preflight가 이유와 다시 시도할 시각을 보이며 claim은 로컬 선점으로 남는다', async (t) => {
  const { a, remote } = await machines(t)
  await vibeBeat({ targetRoot: a, tag: 'aaaa', mode: 'autopilot' })
  const url = await git(a, 'remote', 'get-url', 'origin')
  await git(a, 'remote', 'set-url', 'origin', path.join(path.dirname(url), 'gone.git'))
  const failed = await vibeInbox({ targetRoot: a, step: 'add', kind: 'suggest', text: 'first', tag: 'aaaa' })
  assert.equal(failed.coordination.push.reason, 'network')
  // 원격이 돌아와도 backoff 동안은 부르지 않는다: claim은 로컬에서 이기고 unpublished로 남는다.
  await git(a, 'remote', 'set-url', 'origin', url)
  const claimed = await vibeClaim({ targetRoot: a, tag: 'aaaa', task: 'T001' })
  assert.deepEqual([claimed.claimed, claimed.unpublished, claimed.coordination.push.reason, claimed.coordination.push.backoff.reason], [true, true, 'backoff', 'network'])
  const status = await vibeStatus({ targetRoot: a, tag: 'aaaa' })
  assert.deepEqual([status.coordination.sync.reason, status.coordination.push.backoff.reason], ['backoff', 'network'])
  assert.match(status.coordination.push.backoff.until, /^\d{4}-\d\d-\d\dT\d\d:\d\dZ$/)
  const check = (await vibePreflight({ targetRoot: a })).checks.find((entry) => entry.name === 'coord-push')
  assert.equal(check.ok, true)
  assert.match(check.detail, new RegExp(`remote backoff \\(network\\) until ${status.coordination.push.backoff.until}`))
  assert.deepEqual((await sessions(remote)).active.map((row) => `${row.tag}:${row.doing}`), ['aaaa:-'])
  // 시간이 지나면 다음 사건이 밀린 것까지 올리고 backoff는 사라진다.
  await backoffOver(a)
  const next = await vibeLog({ targetRoot: a, text: 'back', tag: 'aaaa' })
  assert.equal(next.coordination.push.reason, 'deferred')
  const beat = await vibeBeat({ targetRoot: a, tag: 'aaaa', doing: '-' })
  assert.deepEqual([beat.coordination.push.pushed, beat.coordination.unpublished], [true, false])
  assert.equal((await vibeStatus({ targetRoot: a, tag: 'aaaa' })).coordination.push.backoff, undefined)
})

test('preflight는 조정 브랜치에 쓸 수 있는지(ref 이름 충돌·checkout) 본다', async (t) => {
  const { root, temporary } = await fixture(t)
  const coordCheck = async () => (await vibePreflight({ targetRoot: root })).checks.find((entry) => entry.name === 'coord-push')
  await git(root, 'branch', 'gusta/feature', 'main')
  const conflict = await coordCheck()
  assert.deepEqual([conflict.ok, conflict.needsUser], [false, true])
  assert.match(conflict.detail, /ref 이름이 충돌.*coord를 다른 이름으로/)
  await assert.rejects(vibeBeat({ targetRoot: root, tag: 'aaaa', mode: 'pair' }), /ref 이름이 충돌/)
  await git(root, 'branch', '-D', '-q', 'gusta/feature')
  assert.equal((await coordCheck()).ok, true)
  await vibeBeat({ targetRoot: root, tag: 'aaaa', mode: 'pair' })
  await git(root, 'worktree', 'add', '-q', path.join(temporary, 'coordination'), 'gusta')
  const held = await coordCheck()
  assert.deepEqual([held.ok, held.needsUser], [false, true])
  assert.match(held.detail, /checkout돼 있어/)
})

test('land 미정이면 land=current처럼: 현재 브랜치 HEAD에 보관된 태스크는 unlanded에서 빠진다', async (t) => {
  const { root } = await fixture(t, 2)
  await writeFile(path.join(root, 'spec/SETTINGS.md'), '# SETTINGS\n- land: ?\n- push: false\n')
  await commitAll(root, 'land undecided')
  await vibeTask({ targetRoot: root, step: 'start', task: 'T001', tag: 'aaaa' })
  await edit(path.join(root, 'spec/tasks/T001.example.md'), finish)
  await vibeTask({ targetRoot: root, step: 'done', task: 'T001', tag: 'aaaa' })
  assert.deepEqual((await sessions(root)).unlanded.map((row) => row.id), ['T001'])
  // 마감을 커밋하기 전에는 아직이다.
  const early = await vibePush({ targetRoot: root })
  assert.deepEqual([early.reason, early.coordination.landed, early.coordination.waiting], ['land-unset', [], ['T001']])
  await commitAll(root, 'T001 done')
  const landed = await vibePush({ targetRoot: root })
  assert.deepEqual([landed.ok, landed.pushed, landed.reason, landed.coordination.landed], [true, null, 'land-unset', ['T001']])
  assert.deepEqual((await sessions(root)).unlanded, [])
})

test('워커·리뷰어 checkout에서는 inbox·log·beat·claim을 거절하고 읽기와 태스크 수명주기는 막지 않는다', async (t) => {
  const { root, temporary } = await fixture(t)
  const worker = path.join(temporary, 'worker'), reviewer = path.join(temporary, 'reviewer')
  await git(root, 'worktree', 'add', '-q', '-b', 'task/demo/T001', worker)
  await git(root, 'worktree', 'add', '-q', '--detach', reviewer)
  await mkdir(path.join(root, '.git/gusta/v1'), { recursive: true })
  await writeFile(path.join(root, '.git/gusta/v1/state.json'), JSON.stringify({ schemaVersion: 1, groups: {}, history: [],
    attempts: { open: { id: 'open', workspace: worker }, old: { id: 'old', workspace: path.join(temporary, 'gone'), cleanedAt: '2026-10-13T00:00:00Z', review: { workspace: reviewer } } } }))
  for (const checkout of [worker, reviewer]) {
    for (const run of [
      () => vibeBeat({ targetRoot: checkout, tag: 'wwww', mode: 'autopilot' }),
      () => vibeClaim({ targetRoot: checkout, tag: 'wwww', task: 'T001', mode: 'autopilot' }),
      () => vibeInbox({ targetRoot: checkout, step: 'add', kind: 'parked', ref: ['T001'], text: 'needs a decision' }),
      () => vibeInbox({ targetRoot: checkout, step: 'list' }),
      () => vibeLog({ targetRoot: checkout, text: 'worker note' }),
    ]) await assert.rejects(run(), /워커·리뷰어 checkout에서는 vibe (beat|claim|inbox|log)를 쓰지 않습니다/)
  }
  assert.equal(await git(root, 'branch', '--list', 'gusta'), '')
  // 읽기는 된다. 워커의 checkpoint·task는 제 일만 하고 조정 브랜치에는 쓰지 않는다.
  assert.equal((await vibeStatus({ targetRoot: worker, tag: 'wwww' })).coordination.branch, 'gusta')
  assert.deepEqual((await vibeCheckpoint({ targetRoot: worker, tag: 'wwww' })).coordination, { skipped: 'worker-checkout' })
  assert.deepEqual((await vibeTask({ targetRoot: worker, step: 'start', task: 'T001', tag: 'wwww' })).coordination, { skipped: 'worker-checkout' })
  assert.equal(await git(root, 'branch', '--list', 'gusta'), '')
  // 조정자의 checkout(원래 checkout)은 그대로 쓴다.
  assert.equal((await vibeBeat({ targetRoot: root, tag: 'aaaa', mode: 'autopilot' })).changed, true)
})

test('조정 쓰기 뒤에도 작업 트리·HEAD·index는 그대로다', async (t) => {
  const { a, temporary } = await machines(t)
  await writeFile(path.join(a, 'untracked.txt'), 'untracked\n')
  await writeFile(path.join(a, 'spec/FORMAT.md'), '# FORMAT\nstaged\n')
  await git(a, 'add', 'spec/FORMAT.md')
  await edit(path.join(a, 'spec/STATE.md'), (text) => `${text}\nunstaged\n`)
  const index = async () => createHash('sha256').update(await readFile(path.join(a, '.git/index'))).digest('hex')
  const checkout = async () => ({ status: await git(a, 'status', '--porcelain'), head: await git(a, 'rev-parse', 'HEAD'), branch: await git(a, 'symbolic-ref', 'HEAD'), staged: await git(a, 'ls-files', '-s'),
    state: await readFile(path.join(a, 'spec/STATE.md'), 'utf8') })
  const before = await checkout(), indexBefore = await index()
  const bodyFile = path.join(temporary, 'body.txt')
  await writeFile(bodyFile, 'decided "x" | y\n')
  await vibeBeat({ targetRoot: a, tag: 'aaaa', mode: 'autopilot' })
  await vibeClaim({ targetRoot: a, tag: 'aaaa', task: 'T001' })
  await vibeInbox({ targetRoot: a, step: 'add', kind: 'decided', ref: ['ARCH-1'], file: bodyFile, tag: 'aaaa' })
  const listed = await vibeInbox({ targetRoot: a, step: 'list' })
  await vibeInbox({ targetRoot: a, step: 'resolve', id: [listed.inbox[0].id], log: 'confirmed' })
  await vibeLog({ targetRoot: a, text: 'note', tag: 'aaaa' })
  await vibeStatus({ targetRoot: a, tag: 'aaaa' })
  await vibeBeat({ targetRoot: a, tag: 'aaaa', doing: '-' })
  await vibeBeat({ targetRoot: a, tag: 'aaaa', end: true })
  assert.equal(await index(), indexBefore)
  assert.deepEqual(await checkout(), before)
  // 조정 브랜치는 코드와 히스토리를 나누지 않는다.
  await assert.rejects(execute('git', ['-C', a, 'merge-base', 'gusta', 'main']), (error) => error.code === 1)
})

test('이관 전 프로젝트: 조정 문서와 STATE의 옛 active·inbox·log를 합쳐 읽고, 쓰기는 조정 브랜치에만 한다', async (t) => {
  const { root } = await fixture(t)
  const stateFile = path.join(root, 'spec/STATE.md')
  await edit(stateFile, (text) => upsertActive(upsertActive(text, { tag: 'zzzz', host: 'old-host', mode: 'autopilot', since: minutes(-5), at: minutes(-5), doing: 'T002' }),
    { tag: 'aaaa', host: 'old-mbp', mode: 'pair', since: minutes(-9), at: minutes(-9), doing: '-' })
    .replace('## ssot', '## inbox\n- 261012 parked T003: waits for the owner\n\n## ssot').concat('\n## log\n- 261012 legacy line\n'))
  await commitAll(root, 'a project from before the coordination branch')
  const state = await readFile(stateFile, 'utf8')
  // 읽기: 옛 섹션만으로도 다른 세션·결정함·주차가 보인다. 아직 조정 브랜치는 없다.
  let status = await vibeStatus({ targetRoot: root, tag: 'aaaa' })
  assert.deepEqual(status.coordination.legacy, ['active', 'inbox', 'log'])
  assert.deepEqual(status.others.map((row) => [row.tag, row.host, row.doing, row.branch, row.commit, row.pushed, row.legacy, row.stale]), [['zzzz', 'old-host', 'T002', '-', '-', null, true, false]])
  assert.deepEqual([status.self.host, status.self.legacy, status.held, status.counts.parked, status.runnable], ['old-mbp', true, [{ id: 'T002', tag: 'zzzz', reason: 'claimed' }], 1, ['T001']])
  assert.equal(await git(root, 'branch', '--list', 'gusta'), '')
  // 옛 active 행이 쥔 태스크도 선점을 막는다.
  await assert.rejects(vibeClaim({ targetRoot: root, tag: 'aaaa', task: 'T002' }), refused({ owner: 'zzzz', reason: 'claimed' }))
  // 첫 쓰기가 조정 브랜치를 만든다(묻지 않는다). 새 행의 host·mode는 옛 행에서 잇는다.
  const beat = await vibeBeat({ targetRoot: root, tag: 'aaaa' })
  assert.deepEqual([beat.changed, beat.row.host, beat.row.mode, beat.row.branch], [true, 'old-mbp', 'pair', 'main'])
  const added = await vibeInbox({ targetRoot: root, step: 'add', kind: 'decided', ref: ['ARCH-1'], text: 'runtime → node (alt: deno)', tag: 'aaaa' }, clock(NOW))
  await vibeLog({ targetRoot: root, text: 'new line', tag: 'aaaa' }, clock(NOW))
  assert.equal((await vibeClaim({ targetRoot: root, tag: 'aaaa', task: 'T001' })).row.doing, 'T001')
  // 합쳐 읽기: 같은 tag는 조정 브랜치의 행이 이긴다. inbox·log는 둘 다 보인다.
  status = await vibeStatus({ targetRoot: root, tag: 'aaaa' })
  assert.deepEqual([status.self.doing, status.self.legacy, status.others.map((row) => row.tag), status.counts.inbox], ['T001', undefined, ['zzzz'], 2])
  const listed = await vibeInbox({ targetRoot: root, step: 'list' })
  assert.deepEqual(listed.inbox.map((entry) => [entry.line, entry.legacy]), [[added.line, undefined], ['- 261012 parked T003: waits for the owner', true]])
  assert.deepEqual(listed.coordination.legacy, ['active', 'inbox', 'log'])
  assert.deepEqual((await vibeLog({ targetRoot: root })).log, ['- 261013 new line', '- 261012 legacy line'])
  // STATE의 옛 줄은 여기서 지우지 않는다: 어디 있는지 알리고 이관을 안내한다.
  const legacy = await vibeInbox({ targetRoot: root, step: 'resolve', id: [listed.inbox[1].id] })
  assert.deepEqual([legacy.ok, legacy.resolved, legacy.missing, legacy.legacy], [false, [], [], ['- 261012 parked T003: waits for the owner']])
  assert.match(legacy.hint, /gusta migrate/)
  // 쓰기는 조정 브랜치에만 갔다: STATE는 한 바이트도 바뀌지 않았다.
  assert.equal(await readFile(stateFile, 'utf8'), state)
  assert.equal(await git(root, 'status', '--porcelain'), '')
  const doc = await sessions(root)
  assert.deepEqual([doc.active.map((row) => `${row.tag}:${row.doing}`), doc.inbox, doc.log], [['aaaa:T001'], [added.line], ['- 261013 new line']])
})

test('조정 브랜치를 쓸 수 없으면 쓰기는 멈추고 status는 사유를 싣고 계속된다', async (t) => {
  const { root } = await fixture(t)
  // 같은 이름의 코드 브랜치가 이미 있다: 덮어쓰지 않는다.
  await git(root, 'branch', 'gusta', 'main')
  const tip = await git(root, 'rev-parse', 'gusta')
  await assert.rejects(vibeBeat({ targetRoot: root, tag: 'aaaa', mode: 'pair' }), /gusta 브랜치가 이미 다른 용도로 있습니다.*coord를 다른 이름으로/)
  await assert.rejects(vibeInbox({ targetRoot: root, step: 'list' }), /이미 다른 용도/)
  let status = await vibeStatus({ targetRoot: root, tag: 'aaaa' })
  assert.match(status.coordination.error, /이미 다른 용도.*refs\/heads\/gusta/)
  assert.deepEqual([status.route, status.runnable, status.others, status.coordination.branch], ['implementation', ['T001', 'T002', 'T003'], [], 'gusta'])
  const preflight = await vibePreflight({ targetRoot: root })
  const check = preflight.checks.find((entry) => entry.name === 'coord-push')
  assert.deepEqual([check.ok, check.needsUser], [false, true])
  assert.match(check.detail, /이미 다른 용도/)
  assert.equal(await git(root, 'rev-parse', 'gusta'), tip)
  // 태스크 수명주기는 조정 실패에 막히지 않는다: 파일은 쓰고 사유를 결과에 싣는다.
  const started = await vibeTask({ targetRoot: root, step: 'start', task: 'T003', tag: 'aaaa' })
  assert.deepEqual([started.st.startsWith('doing@'), started.files.length], [true, 2])
  assert.match(started.coordination.error, /이미 다른 용도/)
  // 이름을 바꾸면 그 이름으로 쓴다. 그 뒤 이 clone의 조정 브랜치 이름이 기록된다.
  await vibeSettings({ targetRoot: root, set: ['coord=gusta-sessions'] })
  assert.equal((await vibeBeat({ targetRoot: root, tag: 'aaaa', mode: 'pair' })).coordination.branch, 'gusta-sessions')
  assert.equal(JSON.parse(await readFile(path.join(root, '.git/gusta/v1/coord.json'), 'utf8')).branch, 'gusta-sessions')
  status = await vibeStatus({ targetRoot: root, tag: 'aaaa' })
  assert.deepEqual([status.coordination.error, status.coordination.branch, status.self.tag], [undefined, 'gusta-sessions', 'aaaa'])
  assert.match((await vibePreflight({ targetRoot: root })).checks.find((entry) => entry.name === 'coord-push').detail, /^gusta-sessions \(this clone only: no remote\) · last publish .*: no-remote$/)
  // SETTINGS가 브랜치마다 다른 이름을 말하면 추측하지 않는다.
  await vibeSettings({ targetRoot: root, set: ['coord=elsewhere'] })
  await assert.rejects(vibeClaim({ targetRoot: root, tag: 'aaaa', task: 'T001' }), /이 clone의 조정 브랜치는 gusta-sessions인데.*coord는 elsewhere/)
  assert.match((await vibeStatus({ targetRoot: root, tag: 'aaaa' })).coordination.error, /gusta-sessions인데/)
  assert.equal(await git(root, 'branch', '--list', 'elsewhere'), '')
  // 코드 브랜치 이름도 받지 않는다.
  await vibeSettings({ targetRoot: root, set: ['coord=main'] })
  await assert.rejects(vibeBeat({ targetRoot: root, tag: 'aaaa' }), /조정 브랜치 이름 main.*land·deploy·plan 브랜치와 같습니다/)
  await vibeSettings({ targetRoot: root, set: ['coord=release', 'deploy=release'] })
  await assert.rejects(vibeBeat({ targetRoot: root, tag: 'aaaa' }), /조정 브랜치 이름 release.*land·deploy·plan 브랜치와 같습니다/)
  await vibeSettings({ targetRoot: root, set: ['deploy=-'] })
  // 예전 조정 브랜치가 사라졌으면(이름을 옮긴 뒤) 새 이름을 받는다.
  await vibeSettings({ targetRoot: root, set: ['coord=elsewhere'] })
  await git(root, 'branch', '-D', '-q', 'gusta-sessions')
  assert.equal((await vibeBeat({ targetRoot: root, tag: 'aaaa', mode: 'pair' })).coordination.branch, 'elsewhere')
})

test('우리가 끝낸 태스크를 원격이 잡고 있으면 contested로 알린다 (저장 계층의 알려진 공백)', async (t) => {
  const { a, b } = await machines(t)
  await vibeBeat({ targetRoot: a, tag: 'aaaa', mode: 'autopilot' })
  await vibeStatus({ targetRoot: b, tag: 'bbbb' })
  // a는 원격에 닿지 못한 채 T001을 끝낸다. 그사이 b가 같은 태스크를 잡아 올린다.
  await offline(a, async () => {
    await vibeTask({ targetRoot: a, step: 'start', task: 'T001', tag: 'aaaa' })
    await edit(path.join(a, 'spec/tasks/T001.first.md'), finish)
    assert.equal((await vibeTask({ targetRoot: a, step: 'done', task: 'T001', tag: 'aaaa' })).coordination.unpublished, true)
  })
  await vibeClaim({ targetRoot: b, tag: 'bbbb', task: 'T001', mode: 'autopilot' })
  const status = await vibeStatus({ targetRoot: a, tag: 'aaaa' })
  assert.deepEqual([status.coordination.contested, status.coordination.lost, status.unlanded.map((row) => row.id)], [[{ task: 'T001', owner: 'bbbb' }], [], ['T001']])
})

test('prune은 조정 브랜치의 세션 행을 보고 wip를 지키며, 조정 브랜치 자체는 정리하지 않는다', async (t) => {
  const { a } = await machines(t)
  await vibeBeat({ targetRoot: a, tag: 'aaaa', mode: 'autopilot' })
  await vibeCheckpoint({ targetRoot: a, tag: 'aaaa' })
  let result = await vibePrune({ targetRoot: a, tag: 'aaaa' })
  assert.deepEqual([result.pruned, result.kept.map((entry) => entry.reason)], [[], ['이 tag의 active 행이 남아 있습니다(beat --end 전).']])
  await vibeBeat({ targetRoot: a, tag: 'aaaa', end: true })
  result = await vibePrune({ targetRoot: a, tag: 'aaaa' })
  assert.deepEqual(result.pruned, ['wip/aaaa', 'origin/wip/aaaa'])
  assert.equal(await git(a, 'branch', '--list', 'gusta'), 'gusta')
  assert.equal((await vibePreflight({ targetRoot: a })).checks.find((entry) => entry.name === 'coord-push').ok, true)
})

// A repository that only ran `git init`: the bootstrap (gusta-create-architecture) records its start
// before the first commit exists.
async function unborn(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'gusta-unborn-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  await git(root, 'init', '-q', '-b', 'main')
  for (const [key, value] of [['user.name', 'Test'], ['user.email', 'test@example.com'], ['commit.gpgsign', 'false'], ['core.hooksPath', '/dev/null']]) await git(root, 'config', key, value)
  await mkdir(path.join(root, 'spec/ssot'), { recursive: true })
  await mkdir(path.join(root, 'spec/tasks'), { recursive: true })
  const state = (await readFile(new URL('../skills/gusta-create-architecture/assets/STATE.md', import.meta.url), 'utf8')).replace('## next', '| T001 | first | ARCH | - | todo |\n\n## next')
  await writeFile(path.join(root, 'spec/STATE.md'), state)
  await writeFile(path.join(root, 'spec/tasks/T001.first.md'), '# T001 first\n> st:todo | ssot:- | base:ARCH@1 | dep:-\n\n## goal\nfirst\n\n## acceptance\n- [ ] works\n\n## impl notes\n- -\n\n## result\n')
  return { root, state }
}

test('커밋이 없는 git 저장소: beat·log·inbox·claim은 조정 브랜치(orphan)에 쓰고 STATE에 옛 섹션을 만들지 않는다', async (t) => {
  const { root, state } = await unborn(t)
  const logged = await vibeLog({ targetRoot: root, text: 'gusta-create-architecture start' })
  assert.deepEqual([logged.coordination.branch, logged.coordination.backend], ['gusta', undefined])
  const beat = await vibeBeat({ targetRoot: root, tag: 'ab12', mode: 'pair', host: 'mbp' })
  // Where the session stands before the first commit: the unborn branch, no commit.
  assert.deepEqual([beat.row.branch, beat.row.commit, beat.row.doing], ['main', '-', '-'])
  await vibeInbox({ targetRoot: root, step: 'add', tag: 'ab12', kind: 'suggest', text: 'name the first domain' })
  const claimed = await vibeClaim({ targetRoot: root, tag: 'ab12', task: 'T001' })
  assert.deepEqual([claimed.claimed, claimed.row.doing, claimed.row.commit], [true, 'T001', '-'])
  // Everything is on the orphan branch, which holds SESSIONS.md alone; STATE is byte for byte as it was.
  assert.equal(await git(root, 'ls-tree', '--name-only', 'gusta'), 'SESSIONS.md')
  const doc = await sessions(root)
  assert.deepEqual([doc.active.map((row) => `${row.tag} ${row.mode} ${row.doing} ${row.branch} ${row.commit}`), doc.inbox.map((line) => line.replace(/^- \d{6} /, '')), doc.log.map((line) => line.replace(/^- \d{6} /, ''))],
    [['ab12 pair T001 main -'], ['suggest -: name the first domain'], ['gusta-create-architecture start']])
  assert.equal(await readFile(path.join(root, 'spec/STATE.md'), 'utf8'), state)
  assert.doesNotMatch(state, /^## (active|inbox|log)\b/m)
  // HEAD is still unborn and nothing was staged: the first commit is the project's own.
  assert.equal(await git(root, 'rev-parse', '--verify', '--quiet', 'HEAD').catch(() => 'unborn'), 'unborn')
  assert.equal(await git(root, 'diff', '--cached', '--name-only'), '')
  // Reads see the same branch: status, the inbox and the log list.
  const status = await vibeStatus({ targetRoot: root, tag: 'ab12' })
  assert.deepEqual([status.self.doing, status.git.head, status.coordination.branch, status.coordination.legacy, status.counts.inbox], ['T001', null, 'gusta', [], 1])
  assert.deepEqual((await vibeLog({ targetRoot: root })).log, doc.log)
  // The task lifecycle before the first commit coordinates there too (no `## log` from task done).
  await vibeTask({ step: 'start', task: 'T001', tag: 'ab12', targetRoot: root })
  await edit(path.join(root, 'spec/tasks/T001.first.md'), finish)
  const closed = await vibeTask({ step: 'done', task: 'T001', tag: 'ab12', targetRoot: root })
  assert.equal(closed.coordination.branch, 'gusta')
  assert.doesNotMatch(await readFile(path.join(root, 'spec/STATE.md'), 'utf8'), /^## (active|inbox|log)\b/m)
  assert.deepEqual((await sessions(root)).unlanded.map((row) => `${row.id} ${row.tag} ${row.branch} ${row.commit}`), ['T001 ab12 main -'])
  // The session ends; once the project commits, the same rows are simply read on.
  await vibeBeat({ targetRoot: root, tag: 'ab12', end: true })
  await commitAll(root, 'first commit')
  assert.deepEqual([(await sessions(root)).active, (await vibeStatus({ targetRoot: root, tag: 'cd34' })).unlanded.map((row) => row.id)], [[], ['T001']])
})

test('커밋이 없는 git 저장소에 git 사용자 정보가 없으면 조정 쓰기는 원인을 말하고 멈춘다', async (t) => {
  const { root, state } = await unborn(t)
  // No identity anywhere Git may look: empty local values, and nothing guessed from the machine.
  for (const [key, value] of [['user.name', ''], ['user.email', ''], ['user.useConfigOnly', 'true']]) await git(root, 'config', key, value)
  const identity = ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'EMAIL']
  const saved = identity.map((key) => [key, process.env[key]])
  for (const key of identity) delete process.env[key]
  t.after(() => { for (const [key, value] of saved) if (value !== undefined) process.env[key] = value })
  for (const write of [() => vibeLog({ targetRoot: root, text: 'start' }), () => vibeBeat({ targetRoot: root, tag: 'ab12', mode: 'pair' })]) {
    await assert.rejects(write(), (error) => /Git 사용자 정보\(user\.name·user\.email\)가 없어 조정 브랜치 gusta에 기록하지 못했습니다/.test(error.message) && error.details.length === 1)
  }
  // Nothing was written anywhere: no branch, and STATE did not take the line instead.
  assert.equal(await git(root, 'for-each-ref', 'refs/heads/gusta'), '')
  assert.equal(await readFile(path.join(root, 'spec/STATE.md'), 'utf8'), state)
  const cliRun = await execute(process.execPath, [cli, 'vibe', 'log', '--target', root, '--text', 'start', '--json']).catch((error) => error)
  assert.equal(cliRun.code, 1); assert.match(JSON.parse(cliRun.stdout).error, /Git 사용자 정보/)
})

test('vibe CLI: inbox·log·claim은 JSON을 출력하고 거절된 선점은 누가 왜인지 싣는다', async (t) => {
  const { root, temporary } = await fixture(t)
  const run = async (...args) => {
    const result = await execute(process.execPath, [cli, 'vibe', ...args, '--target', root], { encoding: 'utf8' }).catch((error) => error)
    return { code: result.code ?? 0, json: JSON.parse(result.stdout) }
  }
  const bodyFile = path.join(temporary, 'body.txt')
  await writeFile(bodyFile, 'cache key → "user|locale" (alt: `user` only)\n')
  const added = await run('inbox', 'add', '--kind', 'decided', '--ref', 'ARCH-1', '--ref', 'T001', '--file', bodyFile, '--tag', 'aaaa')
  assert.deepEqual([added.code, added.json.added, added.json.line.endsWith('decided ARCH-1 T001: cache key → "user|locale" (alt: `user` only)')], [0, true, true])
  const invalid = await run('inbox', 'add', '--kind', 'parked', '--ref', 'T999', '--text', 'nothing here')
  assert.deepEqual([invalid.code, invalid.json.ok], [1, false])
  assert.match(invalid.json.details[0], /T999/)
  const listed = await run('inbox', 'list', '--kind', 'decided', '--no-fetch')
  assert.deepEqual(listed.json.inbox.map((entry) => entry.id), [added.json.id])
  const resolved = await run('inbox', 'resolve', '--id', added.json.id, '--log', 'inbox confirmed')
  assert.deepEqual([resolved.code, resolved.json.resolved.length, resolved.json.logged], [0, 1, true])
  assert.equal((await run('inbox', 'resolve', '--id', added.json.id)).code, 1)
  assert.equal((await run('log', '--text', 'fix docs: typo')).json.line.endsWith('fix docs: typo'), true)
  assert.deepEqual((await run('log')).json.log.map((line) => line.slice(9)), ['fix docs: typo', 'inbox confirmed'])
  // claim: 한 번 호출로 등록과 선점, 거절은 exit 1과 claim { task, owner, reason, lost }.
  const claimed = await run('claim', '--tag', 'aaaa', '--task', 'T001', '--mode', 'autopilot', '--host', 'mbp')
  assert.deepEqual([claimed.code, claimed.json.claimed, claimed.json.row.host, claimed.json.unpublished], [0, true, 'mbp', false])
  const refusedClaim = await run('claim', '--tag', 'bbbb', '--task', 'T001', '--mode', 'pair')
  assert.deepEqual([refusedClaim.code, refusedClaim.json.ok, refusedClaim.json.claim], [1, false, { task: 'T001', owner: 'aaaa', reason: 'claimed', lost: false }])
  const status = await run('status', '--tag', 'bbbb', '--no-fetch')
  assert.deepEqual([status.json.held, status.json.coordination.sync], [[{ id: 'T001', tag: 'aaaa', reason: 'claimed' }], { action: 'none', reason: 'no-fetch' }])
  const help = (await execute(process.execPath, [cli, 'vibe', '--help'], { encoding: 'utf8' })).stdout
  for (const usage of ['vibe inbox add --kind decided|parked|suggest', 'vibe inbox resolve (--id <id> ... | --line <line> | --file <lines>)', 'vibe inbox list', 'vibe log [--text <text> | --file <path>]', 'vibe claim --tag <tag> [--task T###] [--mode pair|autopilot]']) assert.ok(help.includes(usage), usage)
})
