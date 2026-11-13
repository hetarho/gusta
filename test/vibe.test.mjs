import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath, chmod } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { vibePush } from './helpers/unit-policy.mjs'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { mergeState, upsertActive, activeRows } from '../src/state-doc.mjs'
import { vibeStatus, vibeSync, vibeDeploy, vibeClaim, vibeBeat, vibeCheckpoint, vibePreflight, vibeCheck, exploreTimeboxes } from '../src/vibe.mjs'
import { withHeavyLock } from '../src/check-cache.mjs'
import { lintSpec } from '../src/spec-lint.mjs'
import { vibeDesign } from '../src/vibe-design.mjs'
import { vibePrune } from '../src/prune.mjs'
import { readSessions } from '../src/coord-doc.mjs'
import { archiveTask, machines, MACHINES_STATE as STATE } from './helpers/vibe-fixture.mjs'

const execute = promisify(execFile)
const cli = fileURLToPath(new URL('../bin/gusta.mjs', import.meta.url))
const git = (cwd, ...args) => execute('git', ['-C', cwd, ...args], { encoding: 'utf8' })
const commitAll = async (cwd, message) => {
  await git(cwd, 'add', '-A')
  await git(cwd, 'commit', '-q', '-m', message)
  return (await git(cwd, 'rev-parse', 'HEAD')).stdout.trim()
}
const minutesAgo = (minutes) => `${new Date(Date.now() - minutes * 60000).toISOString().slice(0, 16)}Z`

const task = (id, extra = '') => `# ${id} example\n> st:todo | ssot:ARCH-1 | base:ARCH@1 | dep:-${extra}\n\n## goal\nimplement ${id}\n\n## acceptance\n- [ ] works\n\n## impl notes\n- -\n\n## result\n`

const remoteGit = async (remote, ...args) => (await execute('git', ['--git-dir', remote, ...args], { encoding: 'utf8' })).stdout
const sessionsAt = async (show) => readSessions(await show('gusta:SESSIONS.md'))
// A clock for the coordination branch: `minutes` from now.
const clock = (minutes) => ({ coord: { now: () => new Date(Date.now() + minutes * 60000) } })

test('STATE 병합: log·inbox는 합치고, 행은 ID별로, active는 최신 at이 이긴다', () => {
  const base = STATE
  const ours = upsertActive(STATE.replace('- 261012 gusta-create-task ARCH', '- 261013 T001 doing\n- 261012 gusta-create-task ARCH')
    .replace('| T001 | first | ARCH | - | todo |', '| T001 | first | ARCH | - | doing@261013.aaaa |'), { tag: 'aaaa', host: 'a', mode: 'autopilot', since: '2026-10-13T01:00Z', at: '2026-10-13T02:00Z', doing: 'T001' })
  const theirs = upsertActive(STATE.replace('- 261012 gusta-create-task ARCH', '- 261013 T002 done\n- 261012 gusta-create-task ARCH')
    .replace('| T002 | second | ARCH | - | todo |\n', '').replace('## next\n', '## inbox\n- 261013 parked T001: needs a decision\n\n## next\n'), { tag: 'bbbb', host: 'b', mode: 'pair', since: '2026-10-13T01:30Z', at: '2026-10-13T01:30Z', doing: '-' })
  const { text, conflicts } = mergeState(base, ours, theirs)
  assert.deepEqual(conflicts, [])
  assert.match(text, /- 261013 T001 doing/)
  assert.match(text, /- 261013 T002 done/)
  assert.match(text, /\| T001 \| first \| ARCH \| - \| doing@261013\.aaaa \|/)
  assert.doesNotMatch(text, /\| T002 \|/)
  assert.match(text, /\| aaaa \| a \| autopilot/)
  assert.match(text, /\| bbbb \| b \| pair/)
  assert.match(text, /## inbox\n- 261013 parked T001/)
  // Both sides moving one presence row: the later heartbeat wins.
  const later = upsertActive(ours, { tag: 'aaaa', host: 'a', mode: 'autopilot', at: '2026-10-13T05:00Z' })
  const earlier = upsertActive(ours, { tag: 'aaaa', host: 'a', mode: 'pair', at: '2026-10-13T03:00Z' })
  assert.match(mergeState(ours, earlier, later).text, /\| aaaa \| a \| autopilot \| 2026-10-13T01:00Z \| 2026-10-13T05:00Z/)
  assert.ok(lintSpec)
})

test('STATE 병합: 같은 SSOT 행을 양쪽이 다르게 바꾸면 충돌로 남긴다', () => {
  const ours = STATE.replace('| ARCH | 1 | 1 | - | 0 |', '| ARCH | 2 | 1 | ARCH-2+ | 0 |')
  const theirs = STATE.replace('| ARCH | 1 | 1 | - | 0 |', '| ARCH | 2 | 1 | ARCH-1✎ | 0 |')
  const { text, conflicts } = mergeState(STATE, ours, theirs)
  assert.deepEqual(conflicts, ['ssot'])
  assert.match(text, /<<<<<<< ours[\s\S]*ARCH-2\+[\s\S]*=======[\s\S]*ARCH-1✎[\s\S]*>>>>>>> theirs/)
})

test('active 행: cfg 뒤에 만들고, 갱신해도 since를 지키고, 마지막 행을 지우면 섹션도 지운다', () => {
  const first = upsertActive(STATE, { tag: 'k3f9', host: 'mbp', mode: 'pair', since: '2026-10-13T01:00Z', at: '2026-10-13T01:00Z', doing: '-' })
  assert.match(first, /- push: main\n\n## active\n\| tag \| host \| mode \| since \| at \| doing \|\n\|---\|---\|---\|---\|---\|---\|\n\| k3f9 \| mbp \| pair \| 2026-10-13T01:00Z \| 2026-10-13T01:00Z \| - \|\n\n## ssot/)
  const moved = upsertActive(first, { tag: 'k3f9', host: 'mbp', mode: 'autopilot', since: '2026-10-13T09:00Z', at: '2026-10-13T02:00Z', doing: 'T001' })
  assert.deepEqual(activeRows(moved), [{ tag: 'k3f9', host: 'mbp', mode: 'autopilot', since: '2026-10-13T01:00Z', at: '2026-10-13T02:00Z', doing: 'T001' }])
  assert.equal(upsertActive(moved, { tag: 'k3f9' }, { remove: true }), STATE)
})

test('다른 기기의 진행을 조정 브랜치에서 감지하고, checkpoint가 오래된 행을 살려 둔다 (시나리오 c)', async (t) => {
  const { a, b, remote } = await machines(t)
  // Machine A registers three hours ago, takes T001 and works on a branch it has not pushed.
  await git(a, 'checkout', '-q', '-b', 'feat/first')
  await writeFile(path.join(a, 'first.txt'), 'half way\n')
  await commitAll(a, 'T001 work in progress')
  const claimed = await vibeBeat({ targetRoot: a, tag: 'aaaa', mode: 'autopilot', doing: 'T001', host: 'machine-a' }, clock(-180))
  assert.deepEqual([claimed.row.doing, claimed.row.branch, claimed.coordination.push.pushed], ['T001', 'feat/first', true])
  // Nothing of A's code or STATE reached the remote: only the coordination branch did.
  assert.equal((await remoteGit(remote, 'for-each-ref', '--format=%(refname:short)', 'refs/heads')).trim(), 'gusta\nmain')
  assert.doesNotMatch(await remoteGit(remote, 'show', 'main:spec/STATE.md'), /doing@|## active/)
  // Machine B starts: it sees A, where it works, that its commit is not pushed, and routes to the rest.
  const status = await vibeStatus({ targetRoot: b, tag: 'bbbb' })
  assert.equal(status.git.behind, 0)
  assert.equal(status.others.length, 1)
  assert.deepEqual([status.others[0].tag, status.others[0].doing, status.others[0].branch, status.others[0].pushed, status.others[0].stale], ['aaaa', 'T001', 'feat/first', false, true])
  assert.equal(status.others[0].commit, (await git(a, 'rev-parse', '--short=12', 'HEAD')).stdout.trim())
  assert.deepEqual(status.orphanDoing, [])
  assert.equal(status.route, 'implementation')
  assert.deepEqual(status.implementation.explore, [{ id: 'T002', timebox: '2h' }])
  // Stale: a session that has not been heard of for three hours holds nothing back.
  assert.deepEqual([status.concurrency, status.runnable, status.held], ['solo', ['T001', 'T002'], []])
  // A checkpoint is A's sign of life: the row's `at` moves and the snapshot reaches the remote.
  await writeFile(path.join(a, 'experiment.txt'), 'half way\n')
  const snapshot = await vibeCheckpoint({ targetRoot: a, tag: 'aaaa', message: 'iteration 3' })
  assert.equal(snapshot.pushed, true)
  assert.deepEqual([snapshot.coordination.changed, snapshot.coordination.push.pushed], [true, true])
  const fresh = await vibeStatus({ targetRoot: b, tag: 'bbbb' })
  assert.equal(fresh.others[0].stale, false)
  assert.ok(fresh.others[0].wipAt)
  // The snapshot branch holds A's commit now, so it reads as pushed.
  assert.equal(fresh.others[0].pushed, true)
  assert.deepEqual([fresh.concurrency, fresh.runnable, fresh.held], ['strict', ['T002'], [{ id: 'T001', tag: 'aaaa', reason: 'claimed' }]])
  // The session ends: its row goes, on the remote too.
  assert.equal((await vibeBeat({ targetRoot: a, tag: 'aaaa', end: true })).removed, true)
  assert.deepEqual((await vibeStatus({ targetRoot: b, tag: 'bbbb' })).others, [])
})

test('세션이 끝나지 않고 사라진 doing 태스크는 orphanDoing으로 보고한다', async (t) => {
  const { a, b } = await machines(t)
  const statePath = path.join(a, 'spec/STATE.md')
  await writeFile(statePath, (await readFile(statePath, 'utf8')).replace('| T001 | first | ARCH | - | todo |', '| T001 | first | ARCH | - | doing@261013.zzzz |'))
  await commitAll(a, 'T001 doing without a session row')
  await vibePush({ targetRoot: a })
  const status = await vibeStatus({ targetRoot: b, tag: 'bbbb' })
  assert.deepEqual(status.orphanDoing.map((entry) => [entry.id, entry.tag]), [['T001', 'zzzz']])
})

test('push가 거부되면 원격을 가져와 STATE를 섹션 단위로 합치고 다시 push한다', async (t) => {
  const { a, b } = await machines(t)
  const edit = async (root, from, to) => {
    const file = path.join(root, 'spec/STATE.md')
    await writeFile(file, (await readFile(file, 'utf8')).replace(from, to))
  }
  await edit(a, '- 261012 gusta-create-task ARCH', '- 261013 a: T001 done\n- 261012 gusta-create-task ARCH')
  await archiveTask(a, 'T001')
  await writeFile(path.join(a, 'a.txt'), 'a\n')
  await commitAll(a, 'A unit')
  await vibePush({ targetRoot: a })
  // A project that has not moved its active table off STATE yet still merges it by section.
  await writeFile(path.join(b, 'spec/STATE.md'), upsertActive(await readFile(path.join(b, 'spec/STATE.md'), 'utf8'), { tag: 'bbbb', host: 'machine-b', mode: 'pair', since: minutesAgo(1), at: minutesAgo(1), doing: '-' }))
  await edit(b, '- 261012 gusta-create-task ARCH', '- 261013 b: started\n- 261012 gusta-create-task ARCH')
  await writeFile(path.join(b, 'b.txt'), 'b\n')
  await commitAll(b, 'B unit')
  const result = await vibePush({ targetRoot: b })
  assert.equal(result.sync, 'rebase')
  const merged = (await git(b, 'show', 'origin/main:spec/STATE.md')).stdout
  assert.match(merged, /- 261013 a: T001 done/)
  assert.match(merged, /- 261013 b: started/)
  assert.doesNotMatch(merged, /\| T001 \|/)
  assert.match(merged, /\| bbbb \| machine-b \| pair/)
  assert.deepEqual((await lintSpec({ targetRoot: b })).errors.filter((error) => !/tasks\/T001/.test(error)), [])
})

test('claims share task ownership on the coordination branch without publishing code or touching the working tree', async (t) => {
  const { a, b, remote } = await machines(t)
  await writeFile(path.join(a, 'pending.txt'), 'unverified\n')
  await commitAll(a, 'pending local candidate')
  await writeFile(path.join(a, 'dirty.txt'), 'not committed\n')
  const before = [(await git(a, 'status', '--porcelain')).stdout, (await git(a, 'rev-parse', 'HEAD')).stdout]
  // One call registers the session and takes the task; a dirty tree is no obstacle.
  const first = await vibeClaim({ targetRoot: a, tag: 'aaaa', task: 'T001', mode: 'autopilot' })
  assert.deepEqual([first.ok, first.claimed, first.task, first.unpublished, first.coordination.push.pushed], [true, true, 'T001', false, true])
  assert.deepEqual([first.row.doing, first.row.branch, first.row.mode], ['T001', 'main', 'autopilot'])
  assert.deepEqual((await sessionsAt((spec) => remoteGit(remote, 'show', spec))).active.map((row) => `${row.tag}:${row.doing}`), ['aaaa:T001'])
  // The land branch got nothing: no claim in its STATE, no pending code.
  assert.doesNotMatch(await remoteGit(remote, 'show', 'main:spec/STATE.md'), /doing@|## active/)
  await assert.rejects(remoteGit(remote, 'show', 'main:pending.txt'))
  assert.deepEqual([(await git(a, 'status', '--porcelain')).stdout, (await git(a, 'rev-parse', 'HEAD')).stdout], before)
  // The next claim moves the same row.
  const second = await vibeClaim({ targetRoot: a, tag: 'aaaa', task: 'T002' })
  assert.equal(second.row.doing, 'T002')
  // B has not looked yet: its claim is made locally, and the remote — who had it first — takes it back.
  await assert.rejects(vibeClaim({ targetRoot: b, tag: 'bbbb', task: 'T002', mode: 'autopilot' }),
    (error) => error.name === 'ClaimError' && error.lost === true && error.owner === 'aaaa' && /원격에 먼저/.test(error.message))
  assert.deepEqual((await sessionsAt(async (spec) => (await git(b, 'show', spec)).stdout)).active.map((row) => `${row.tag}:${row.doing}`).sort(), ['aaaa:T002', 'bbbb:-'])
  // Now B knows: the same claim is refused before anything is written.
  await assert.rejects(vibeClaim({ targetRoot: b, tag: 'bbbb', task: 'T002' }), (error) => error.name === 'ClaimError' && error.lost === false && error.reason === 'claimed' && /aaaa 세션이 선점/.test(error.message))
  // T001 is free again, and B takes it.
  assert.equal((await vibeClaim({ targetRoot: b, tag: 'bbbb', task: 'T001' })).row.doing, 'T001')
  assert.equal((await git(b, 'status', '--porcelain')).stdout, '')
})

test('claims work with push false and without any remote, and register a session that has no row (pair)', async (t) => {
  const { a, remote } = await machines(t, { state: STATE.replace('- push: main', '- push: -') })
  const main = await remoteGit(remote, 'rev-parse', 'main')
  const claimed = await vibeClaim({ targetRoot: a, tag: 'aaaa', task: 'T001' })
  assert.deepEqual([claimed.row.mode, claimed.row.doing], ['pair', 'T001'])
  // Code is never pushed here (push false); coordination is its own setting.
  assert.deepEqual([claimed.claimed, claimed.coordination.push.pushed, claimed.unpublished], [true, true, false])
  assert.equal(await remoteGit(remote, 'rev-parse', 'main'), main)
  await git(a, 'remote', 'remove', 'origin')
  const alone = await vibeClaim({ targetRoot: a, tag: 'aaaa', task: 'T002' })
  assert.deepEqual([alone.row.doing, alone.coordination.push, alone.unpublished], ['T002', { pushed: false, reason: 'no-remote' }, false])
  await assert.rejects(vibeClaim({ targetRoot: a, tag: 'aaaa', task: 'T009' }), /선점할 태스크가 없습니다/)
  await assert.rejects(vibeClaim({ targetRoot: a, tag: 'aaaa', task: 'bad' }), /--tag와 선택적 --task/)
})

test('repair claims preserve malformed task state and reserve it against ordinary and repair claimants', async (t) => {
  const { a, b } = await machines(t)
  const state = path.join(a, 'spec/STATE.md')
  await writeFile(state, (await readFile(state, 'utf8')).replace('| T001 | first | ARCH | - | todo |', '| T001 | first | ARCH | - | done |'))
  await commitAll(a, 'malformed task close')
  await git(a, 'push', '-q', 'origin', 'main')
  await git(b, 'pull', '--ff-only', '-q')
  await vibeBeat({ targetRoot: a, tag: 'aaaa', mode: 'autopilot' })
  // An ordinary claim does not take a task whose row is not todo; a repair claim reserves it as it is.
  await assert.rejects(vibeClaim({ targetRoot: a, tag: 'aaaa', task: 'T001' }), /실행할 수 없는 태스크/)
  const reserved = await vibeClaim({ targetRoot: a, tag: 'aaaa', task: 'T001', repairTask: true })
  assert.deepEqual([reserved.claimed, reserved.row.doing], [true, 'T001'])
  assert.match(await readFile(state, 'utf8'), /\| T001 \| first \| ARCH \| - \| done \|/)
  assert.equal((await git(a, 'status', '--porcelain')).stdout, '')
  await vibeStatus({ targetRoot: b, tag: 'bbbb' })
  await vibeBeat({ targetRoot: b, tag: 'bbbb', mode: 'autopilot' })
  await assert.rejects(vibeClaim({ targetRoot: b, tag: 'bbbb', task: 'T001' }), /실행할 수 없는 태스크/)
  await assert.rejects(vibeClaim({ targetRoot: b, tag: 'bbbb', task: 'T001', repairTask: true }), /aaaa 세션이 선점/)
})

test('claims respect the task\'s own doing tag, in the file and on the land branch, whatever the coordination branch says', async (t) => {
  const { a, b } = await machines(t)
  const state = path.join(a, 'spec/STATE.md'), file = path.join(a, 'spec/tasks/T001.first.md')
  await writeFile(state, (await readFile(state, 'utf8')).replace('| T001 | first | ARCH | - | todo |', '| T001 | first | ARCH | - | done |'))
  await writeFile(file, (await readFile(file, 'utf8')).replace('st:todo', 'st:doing@261112.zzzz'))
  await commitAll(a, 'malformed STATE retains a file owner')
  await vibeBeat({ targetRoot: a, tag: 'aaaa', mode: 'autopilot' })
  await assert.rejects(vibeClaim({ targetRoot: a, tag: 'aaaa', task: 'T001', repairTask: true }), (error) => error.name === 'ClaimError' && error.owner === 'zzzz' && /다른 세션이 선점/.test(error.message))
  // The land branch as last fetched says another session is doing T002: B, still on the old row, is refused too.
  await writeFile(state, (await readFile(state, 'utf8')).replace('| T002 | second | ARCH | - | todo |', '| T002 | second | ARCH | - | doing@261112.zzzz |'))
  await commitAll(a, 'T002 doing')
  await git(a, 'push', '-q', 'origin', 'main')
  await git(b, 'fetch', '-q', 'origin')
  await vibeBeat({ targetRoot: b, tag: 'bbbb', mode: 'autopilot' })
  await assert.rejects(vibeClaim({ targetRoot: b, tag: 'bbbb', task: 'T002' }), /다른 세션이 선점했거나 소유자를 확인/)
})

test('a stale session\'s hold is taken over; one still checkpointing keeps it', async (t) => {
  const { a, b } = await machines(t)
  await vibeClaim({ targetRoot: a, tag: 'aaaa', task: 'T001', mode: 'autopilot' })
  await vibeStatus({ targetRoot: b, tag: 'bbbb' })
  await vibeBeat({ targetRoot: b, tag: 'bbbb', mode: 'autopilot' })
  // Thirty minutes on, A is alive. Three hours on it is not — unless its wip snapshot is newer.
  await assert.rejects(vibeClaim({ targetRoot: b, tag: 'bbbb', task: 'T001' }, clock(30)), /aaaa 세션이 선점/)
  await git(b, 'update-ref', 'refs/remotes/origin/wip/aaaa', 'HEAD')
  const tree = (await git(b, 'rev-parse', 'HEAD^{tree}')).stdout.trim()
  const later = new Date(Date.now() + 150 * 60000).toISOString()
  const snapshot = (await execute('git', ['-C', b, 'commit-tree', tree, '-p', 'HEAD', '-m', 'checkpoint aaaa'], { encoding: 'utf8', env: { ...process.env, GIT_COMMITTER_DATE: later, GIT_AUTHOR_DATE: later } })).stdout.trim()
  await git(b, 'update-ref', 'refs/remotes/origin/wip/aaaa', snapshot)
  await assert.rejects(vibeClaim({ targetRoot: b, tag: 'bbbb', task: 'T001' }, clock(180)), /aaaa 세션이 선점/)
  await git(b, 'update-ref', '-d', 'refs/remotes/origin/wip/aaaa')
  const claimed = await vibeClaim({ targetRoot: b, tag: 'bbbb', task: 'T001' }, clock(180))
  assert.deepEqual([claimed.ok, claimed.released, claimed.row.doing], [true, ['aaaa'], 'T001'])
  // The working tree's STATE row is the task lifecycle's (vibe task start), not the claim's.
  assert.match(await readFile(path.join(b, 'spec/STATE.md'), 'utf8'), /\| T001 \| first \| ARCH \| - \| todo \|/)
})

test('verified push rejects code introduced by sync and accepts progress-only commits', async (t) => {
  const { a, b, remote } = await machines(t)
  await writeFile(path.join(a, 'local.txt'), 'verified local change\n')
  const verified = await commitAll(a, 'local candidate')
  await writeFile(path.join(b, 'remote.txt'), 'new remote change\n')
  const remoteHead = await commitAll(b, 'remote candidate')
  await vibePush({ targetRoot: b })
  await assert.rejects(vibePush({ targetRoot: a, verifiedCommit: verified }), /최종 검증 이후 코드가 변경/)
  assert.equal((await execute('git', ['--git-dir', remote, 'rev-parse', 'main'])).stdout.trim(), remoteHead)
  const reverified = (await git(a, 'rev-parse', 'HEAD')).stdout.trim()
  const state = path.join(a, 'spec/STATE.md')
  await writeFile(state, (await readFile(state, 'utf8')).replace('## log', '## log\n- 261013 final verification passed'))
  await commitAll(a, 'record verification')
  const result = await vibePush({ targetRoot: a, verifiedCommit: reverified })
  assert.equal(result.ok, true)
  assert.equal((await git(a, 'show', 'origin/main:local.txt')).stdout, 'verified local change\n')
})

test('checkpoint는 HEAD·브랜치를 건드리지 않고 미추적 파일까지 wip/<tag>에 이어 쌓는다', async (t) => {
  const { a, remote } = await machines(t)
  const head = (await git(a, 'rev-parse', 'HEAD')).stdout.trim()
  await writeFile(path.join(a, 'untracked.txt'), 'one\n')
  const first = await vibeCheckpoint({ targetRoot: a, tag: 'aaaa' })
  assert.equal(first.changed, true)
  assert.equal((await git(a, 'rev-parse', 'HEAD')).stdout.trim(), head)
  assert.match((await git(a, 'status', '--porcelain')).stdout, /\?\? untracked.txt/)
  assert.equal((await execute('git', ['--git-dir', remote, 'show', 'wip/aaaa:untracked.txt'], { encoding: 'utf8' })).stdout, 'one\n')
  assert.equal((await vibeCheckpoint({ targetRoot: a, tag: 'aaaa' })).changed, false)
  await writeFile(path.join(a, 'untracked.txt'), 'two\n')
  const second = await vibeCheckpoint({ targetRoot: a, tag: 'aaaa' })
  assert.equal((await git(a, 'merge-base', '--is-ancestor', first.commit, second.commit)).stdout, '')
  assert.equal(second.pushed, true)
})

test('prune: 이 세션의 wip/<tag>는 미커밋 변경 동안 보존하고, 로컬은 커밋 뒤·원격은 push 뒤에 지운다', async (t) => {
  const { a, remote } = await machines(t)
  const remoteWip = () => execute('git', ['--git-dir', remote, 'rev-parse', '--verify', '--quiet', 'refs/heads/wip/aaaa']).then(() => true, () => false)
  await writeFile(path.join(a, 'untracked.txt'), 'one\n')
  await vibeCheckpoint({ targetRoot: a, tag: 'aaaa' })
  // A checkpoint registers the session (a sign of life); prune runs after it ends.
  await vibeBeat({ targetRoot: a, tag: 'aaaa', end: true })
  let result = await vibePrune({ targetRoot: a, tag: 'aaaa' })
  assert.deepEqual(result.pruned, [])
  assert.match(result.kept[0].reason, /미커밋/)
  await commitAll(a, 'work')
  result = await vibePrune({ targetRoot: a, tag: 'aaaa' })
  assert.deepEqual(result.pruned, ['wip/aaaa'])
  assert.match(result.kept[0].reason, /HEAD가 아직 origin\/main/)
  assert.equal(await remoteWip(), true)
  await git(a, 'push', '-q', 'origin', 'main')
  result = await vibePrune({ targetRoot: a, tag: 'aaaa' })
  assert.deepEqual(result.pruned, ['origin/wip/aaaa'])
  assert.equal(await remoteWip(), false)
  assert.equal((await git(a, 'branch', '--list', 'wip/*')).stdout, '')
  await writeFile(path.join(a, 'spec/SETTINGS.md'), '# SETTINGS\n- prune-branches: false\n')
  await commitAll(a, 'keep')
  assert.deepEqual(await vibePrune({ targetRoot: a, tag: 'aaaa' }), { schemaVersion: 1, ok: true, skipped: 'prune-branches: false' })
})

// Execution runs only existing tasks; untasked SSOT deltas, adopted reviews and ideation are sketch
// input (gusta-sketch), reported but never a route of their own.
test('route: 태스크가 있으면 implementation, 없으면 sketch-first — 미태스크 기획 거리는 sketch에만', async (t) => {
  const plain = STATE.replace('| T001 | first | ARCH | - | todo |\n| T002 | second | ARCH | - | todo |\n', '')
  const ideation = (st) => `## ideation\n| id | st |\n|---|---|\n| tags | ${st} |\n\n## ssot\n`
  const review = '## review\n| id | st |\n|---|---|\n| R1 | ready@261013 |\n\n## ssot\n'
  const pending = '| ARCH | 2 | 1 | ARCH-2+ | 0 |'
  for (const [state, route, sketch, settled] of [[plain, 'sketch-first', {}, true],
    [plain.replace('## ssot\n', ideation('open@261013')), 'sketch-first', { ideation: ['tags'] }, true],
    [plain.replace('| ARCH | 1 | 1 | - | 0 |', pending), 'sketch-first', { pending: ['ARCH'] }, true],
    [plain.replace('## ssot\n', review), 'sketch-first', { reviews: ['R1'] }, true],
    [STATE, 'implementation', {}, false],
    [STATE.replace('## ssot\n', ideation('ready@261013')).replace('| ARCH | 1 | 1 | - | 0 |', pending), 'implementation', { pending: ['ARCH'], ideation: ['tags'] }, false]]) {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'gusta-route-')))
    t.after(() => rm(root, { recursive: true, force: true }))
    await mkdir(path.join(root, 'spec'), { recursive: true })
    await writeFile(path.join(root, 'spec/STATE.md'), state)
    const status = await vibeStatus({ targetRoot: root })
    assert.equal(status.route, route); assert.equal(status.settled, settled); assert.equal(status.parkedOnly, false)
    assert.deepEqual(Object.fromEntries(Object.entries(status.sketch).map(([key, rows]) => [key, rows.map((row) => row.id)]).filter(([, ids]) => ids.length)), sketch)
    assert.deepEqual(Object.keys(status.implementation), ['todo', 'resume', 'blocked', 'explore']); assert.equal(status.planning, undefined)
  }
  const empty = await realpath(await mkdtemp(path.join(os.tmpdir(), 'gusta-route-')))
  t.after(() => rm(empty, { recursive: true, force: true }))
  assert.equal((await vibeStatus({ targetRoot: empty })).route, 'architecture')
})

// A hand close (`done` without a date) used to read as neither todo nor done: settled, nothing to execute.
test('status: a row or task-file st outside FORMAT is an issue, never settled, and routes to repair; valid states keep their route', async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'gusta-st-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(path.join(root, 'spec/tasks'), { recursive: true })
  const status = async (rows, files = {}) => {
    await writeFile(path.join(root, 'spec/STATE.md'), STATE.replace('| T001 | first | ARCH | - | todo |\n| T002 | second | ARCH | - | todo |\n', rows))
    await rm(path.join(root, 'spec/tasks'), { recursive: true, force: true }); await mkdir(path.join(root, 'spec/tasks'))
    for (const [id, st] of Object.entries(files)) await writeFile(path.join(root, `spec/tasks/${id}.x.md`), task(id).replace('st:todo', `st:${st}`))
    return vibeStatus({ targetRoot: root })
  }
  const broken = await status('| T001 | first | ARCH | - | done |\n', { T001: 'done' })
  assert.deepEqual(broken.issues, [{ id: 'T001', where: 'STATE', st: 'done' }, { id: 'T001', where: 'file', st: 'done' }])
  assert.equal(broken.settled, false); assert.equal(broken.route, 'repair'); assert.deepEqual(broken.runnable, [])
  // A valid row with a broken file (and the other way round) is still an issue.
  assert.deepEqual((await status('| T001 | first | ARCH | - | todo |\n', { T001: 'finished' })).issues, [{ id: 'T001', where: 'file', st: 'finished' }])
  assert.deepEqual((await status('| T001 | first | ARCH | - | doing |\n', { T001: 'doing@261112.ab' })).issues, [{ id: 'T001', where: 'STATE', st: 'doing' }])
  // Every FORMAT st is valid: the routes are what they were.
  // Another session's doing row is not this session's to execute; a blocked row gets a recovery unit.
  for (const [st, route, settled] of [['todo', 'implementation', false], ['doing@261112.ab', 'sketch-first', true], ['doing@261112', 'implementation', false], ['blocked@261112', 'implementation', false]]) {
    const valid = await status(`| T001 | first | ARCH | - | ${st} |\n`, { T001: st })
    assert.deepEqual([valid.issues, valid.route, valid.settled], [[], route, settled], st)
  }
  // No task file: lint reports it; status judges the row alone.
  assert.deepEqual((await status('| T001 | first | ARCH | - | todo |\n')).issues, [])
})

test('route: 완료 ideation 파일은 새 기획 후보나 기본 읽기 입력이 아니다', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gusta-ideation-route-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(path.join(root, 'spec/ideation/done'), { recursive: true })
  await writeFile(path.join(root, 'spec/STATE.md'), STATE)
  // The archived body is intentionally unusable; routing needs only active STATE rows.
  await writeFile(path.join(root, 'spec/ideation/done/outline.md'), 'historical discussion without current planning metadata')
  const status = await vibeStatus({ targetRoot: root })
  assert.equal(status.route, 'implementation')
  assert.deepEqual(status.sketch.ideation, [])
})

test('explore timeboxes: one listing, row order, a row matches only its own `<id>.` file', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gusta-explore-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(path.join(root, 'spec/tasks'), { recursive: true })
  const quote = (id, extra) => `# ${id} x\n> st:todo | ssot:A-1 | base:A@1 | dep:-${extra}\n`
  await writeFile(path.join(root, 'spec/tasks/T10.later.md'), quote('T10', ' | explore:30m'))
  await writeFile(path.join(root, 'spec/tasks/T1.v1.2.notes.md'), quote('T1', ' | explore:2h'))
  await writeFile(path.join(root, 'spec/tasks/T2.plain.md'), quote('T2', ''))
  await writeFile(path.join(root, 'spec/tasks/T3.none.md'), quote('T3', ' | explore:-'))
  await writeFile(path.join(root, 'spec/tasks/README'), 'no dot in this name')
  const rows = ['T10', 'T9', 'T2', 'T1', 'T3', 'T1'].map((id) => ({ id }))
  assert.deepEqual(await exploreTimeboxes(root, rows), [{ id: 'T10', timebox: '30m' }, { id: 'T1', timebox: '2h' }, { id: 'T1', timebox: '2h' }])
  assert.deepEqual(await exploreTimeboxes(path.join(root, 'missing'), rows), [])
})

test('vibe check는 같은 작업 트리에서 통과한 명령을 다시 돌리지 않는다', async (t) => {
  const { a, temporary } = await machines(t)
  const counter = path.join(temporary, 'runs.txt')
  const command = `node -e "require('fs').appendFileSync('${counter}', 'x')"`
  const count = async () => (await readFile(counter, 'utf8').catch(() => '')).length
  assert.equal(await vibeCheck({ targetRoot: a }, command), 0)
  assert.equal(await vibeCheck({ targetRoot: a }, command), 0)
  assert.equal(await count(), 1)
  await writeFile(path.join(a, 'change.txt'), 'new\n')
  assert.equal(await vibeCheck({ targetRoot: a, heavy: true }, command), 0)
  assert.equal(await count(), 2)
  assert.equal(await vibeCheck({ targetRoot: a, noCache: true }, command), 0)
  assert.equal(await count(), 3)
  assert.notEqual(await vibeCheck({ targetRoot: a }, 'node -e "process.exit(3)"'), 0)
  assert.notEqual(await vibeCheck({ targetRoot: a }, 'node -e "process.exit(3)"'), 0)
})

test('heavy lock은 무거운 검사를 하나씩만 실행한다', async (t) => {
  const runtime = await realpath(await mkdtemp(path.join(os.tmpdir(), 'gusta-heavy-')))
  t.after(() => rm(runtime, { recursive: true, force: true }))
  let running = 0, peak = 0
  const job = () => withHeavyLock(runtime, 'job', async () => {
    running += 1; peak = Math.max(peak, running)
    await new Promise((resolve) => setTimeout(resolve, 100))
    running -= 1
  }, { pollMs: 20 })
  await Promise.all([job(), job(), job()])
  assert.equal(peak, 1)
})

test('land 전략: push false면 land를 먼저 합쳐 로컬 land를 fast-forward하고, deploy는 land로만 fast-forward한다', async (t) => {
  const { a, temporary } = await machines(t)
  await writeFile(path.join(a, 'spec/SETTINGS.md'), '# SETTINGS\n- land: next\n- push: false\n- deploy: main\n')
  await commitAll(a, 'settings')
  await git(a, 'branch', 'next')
  await git(a, 'checkout', '-q', '-b', 'feat')
  await writeFile(path.join(a, 'feature.txt'), 'one\n')
  const first = await commitAll(a, 'feature')
  let landed = await vibePush({ targetRoot: a, verifiedCommit: first })
  assert.deepEqual([landed.mode, landed.target, landed.merged, landed.local, landed.landed], ['local', 'next', false, 'ff', first])
  assert.equal((await git(a, 'rev-parse', 'next')).stdout.trim(), first)
  // land moved meanwhile in its own checkout: it is merged in first, and changed code needs a new gate.
  const other = path.join(temporary, 'next checkout')
  await git(a, 'worktree', 'add', '-q', other, 'next')
  await writeFile(path.join(other, 'other.txt'), 'theirs\n')
  await commitAll(other, 'other')
  await writeFile(path.join(a, 'feature.txt'), 'two\n')
  const second = await commitAll(a, 'feature 2')
  await assert.rejects(vibePush({ targetRoot: a, verifiedCommit: second }), /최종 검증 이후/)
  const merged = (await git(a, 'rev-parse', 'HEAD')).stdout.trim()
  landed = await vibePush({ targetRoot: a, verifiedCommit: merged })
  assert.deepEqual([landed.merged, landed.local], [false, 'ff'])
  assert.equal((await git(other, 'rev-parse', 'HEAD')).stdout.trim(), merged)
  assert.equal(await readFile(path.join(other, 'feature.txt'), 'utf8'), 'two\n')
  // 배포해줘: main only fast-forwards to the landed commit.
  const deployed = await vibeDeploy({ targetRoot: a })
  assert.deepEqual([deployed.from, deployed.to, deployed.deployed, deployed.remote], ['next', 'main', merged, null])
  assert.equal((await git(a, 'rev-parse', 'main')).stdout.trim(), merged)
  assert.equal((await vibeDeploy({ targetRoot: a })).reason, 'up-to-date')
  const tree = (await git(a, 'rev-parse', 'main^{tree}')).stdout.trim()
  const hotfix = (await git(a, 'commit-tree', tree, '-p', 'main', '-m', 'hotfix')).stdout.trim()
  await git(a, 'update-ref', 'refs/heads/main', hotfix)
  await assert.rejects(vibeDeploy({ targetRoot: a }), /main에 next에 없는 커밋/)
})

test('land-via pr은 작업 브랜치를 올리고 PR 대상만 알려 주며 land에 직접 push하지 않는다', async (t) => {
  const { a, remote } = await machines(t)
  await writeFile(path.join(a, 'spec/SETTINGS.md'), '# SETTINGS\n- land: main\n- land-via: pr\n- push: true\n')
  await commitAll(a, 'settings')
  await git(a, 'checkout', '-q', '-b', 'improve/x')
  await writeFile(path.join(a, 'x.txt'), 'x\n')
  const head = await commitAll(a, 'x')
  const before = (await execute('git', ['--git-dir', remote, 'rev-parse', 'main'], { encoding: 'utf8' })).stdout.trim()
  const result = await vibePush({ targetRoot: a })
  assert.deepEqual([result.mode, result.base, result.target, result.pushed], ['pr', 'main', 'improve/x', head])
  assert.ok(result.pr || result.prError)
  assert.equal((await execute('git', ['--git-dir', remote, 'rev-parse', 'improve/x'], { encoding: 'utf8' })).stdout.trim(), head)
  assert.equal((await execute('git', ['--git-dir', remote, 'rev-parse', 'main'], { encoding: 'utf8' })).stdout.trim(), before)
})

test('preflight는 push 대상이 없으면 커밋만으로 보고 묻지 않는다', async (t) => {
  const { a } = await machines(t, { state: STATE.replace('- push: main', '- push: ?') })
  const unset = await vibePreflight({ targetRoot: a })
  assert.equal(unset.checks.find((check) => check.name === 'push-target').ok, true)
  assert.equal(unset.checks.some((check) => check.name === 'push-permission'), false)
  // An undecided land never blocks autopilot (it commits only); preflight just reports it.
  // Undecided agents does: without the list the CLI has no tool to route units to.
  assert.deepEqual(unset.needsUser.filter((check) => check.name !== 'ci-access').map((check) => check.name), ['agents'])
  assert.deepEqual([unset.reason, unset.hint], ['needs-init', '/gusta-init으로 쓸 AI 목록(SETTINGS agents)을 정한 뒤 다시 실행하세요'])
  assert.match(unset.checks.find((check) => check.name === 'branch-settings').detail, /land 미정/)
  assert.deepEqual(await vibePush({ targetRoot: a }), { schemaVersion: 1, ok: true, pushed: null, reason: 'land-unset' })
  const { a: ready } = await machines(t)
  const result = await vibePreflight({ targetRoot: ready, provider: 'claude' })
  assert.equal(result.checks.find((check) => check.name === 'push-permission').ok, true)
  assert.deepEqual(result.needsUser.filter((check) => check.name !== 'ci-access'), [])
})

test('디자인 중에는 push를 거절하고 맡김 preflight는 사람을 기다린다', async (t) => {
  const { a } = await machines(t)
  await vibeDesign({ targetRoot: a, step: 'start', tag: 'k3f9', scope: 'hero' })
  await assert.rejects(vibePush({ targetRoot: a }), /디자인 중/)
  const preflight = await vibePreflight({ targetRoot: a })
  assert.equal(preflight.ok, false)
  assert.match(preflight.checks.find((check) => check.name === 'design').detail, /k3f9/)
  assert.ok(preflight.needsUser.some((check) => check.name === 'design'))
  await vibeDesign({ targetRoot: a, step: 'end' })
  assert.equal((await vibePreflight({ targetRoot: a })).checks.find((check) => check.name === 'design').ok, true)
  assert.equal((await vibePush({ targetRoot: a })).ok, true)
})

test('preflight --probe는 새 worktree의 헤드리스 워커로 명령 실행 권한을 실측한다', async (t) => {
  const { a, temporary } = await machines(t)
  const bin = path.join(temporary, 'bin')
  await mkdir(bin)
  const fake = path.join(bin, 'claude')
  // The fake provider records where it ran and which tools it was allowed, then reports a denial
  // unless Bash(npm test *) was granted.
  await writeFile(fake, `#!/usr/bin/env node\nconst args = process.argv.slice(2)\nif (args.includes('--help')) { console.log('--exclude-dynamic-system-prompt-sections'); process.exit(0) }\nconst allowed = args[args.indexOf('--allowedTools') + 1]\nrequire('fs').writeFileSync(${JSON.stringify(path.join(temporary, 'probe.json'))}, JSON.stringify({ cwd: process.cwd(), allowed, shared: args.includes('--exclude-dynamic-system-prompt-sections') }))\nconst denied = !allowed.includes('Bash(npm test *)')\nprocess.stdout.write(JSON.stringify({ structured_output: { ran: !denied, exitCode: denied ? 1 : 0, denied, note: 'probe' } }))\n`)
  await chmod(fake, 0o755)
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` }
  const denied = await vibePreflight({ targetRoot: a, probe: 'npm test', provider: 'claude', env })
  const probe = denied.checks.find((check) => check.name === 'worker-probe')
  assert.equal(probe.ok, false)
  assert.equal(probe.needsUser, true)
  const record = JSON.parse(await readFile(path.join(temporary, 'probe.json'), 'utf8'))
  assert.notEqual(await realpath(record.cwd).catch(() => record.cwd), a)
  assert.match(record.cwd, /\.gusta-worktrees/)
  assert.equal(record.shared, true, 'the probe runs with the optional flags workers get')
  const granted = await vibePreflight({ targetRoot: a, probe: 'npm test', provider: 'claude', env, allowTool: ['Bash(npm test *)'] })
  assert.equal(granted.checks.find((check) => check.name === 'worker-probe').ok, true)
  assert.equal((await git(a, 'worktree', 'list')).stdout.trim().split('\n').length, 1)
})

test('vibe CLI: beat·status는 JSON을, 오류도 JSON을 출력한다', async (t) => {
  const { a } = await machines(t)
  const run = (...args) => execute(process.execPath, [cli, 'vibe', ...args, '--target', a], { encoding: 'utf8' })
  const beat = JSON.parse((await run('beat', '--tag', 'k3f9', '--mode', 'pair')).stdout)
  assert.equal(beat.row.tag, 'k3f9')
  const status = JSON.parse((await run('status', '--tag', 'k3f9', '--no-fetch')).stdout)
  assert.equal(status.route, 'implementation')
  const failed = await run('beat', '--tag', 'x').catch((error) => error)
  assert.equal(failed.code, 1)
  assert.match(JSON.parse(failed.stdout).error, /세션 tag/)
})


test('final publication rejects invalid spec, while explicit WIP handoff preserves it', async (t) => {
  const { a, remote } = await machines(t)
  const before = (await execute('git', ['--git-dir', remote, 'rev-parse', 'main'], { encoding: 'utf8' })).stdout.trim()
  const file = path.join(a, 'spec/tasks/T001.first.md')
  await writeFile(file, (await readFile(file, 'utf8')).replace('st:todo', 'st:done'))
  await commitAll(a, 'invalid hand close')
  await assert.rejects(vibePush({ targetRoot: a }), /spec lint 실패/)
  assert.equal((await execute('git', ['--git-dir', remote, 'rev-parse', 'main'], { encoding: 'utf8' })).stdout.trim(), before)
  const kept = await vibeCheckpoint({ targetRoot: a, tag: 'keep01', handoff: true })
  assert.equal(kept.ok, true); assert.deepEqual(kept.verification, { status: 'unverified', checksRun: false })
  assert.equal((await execute('git', ['--git-dir', remote, 'rev-parse', 'wip/keep01'], { encoding: 'utf8' })).stdout.trim(), kept.commit)
})

test('final publication rejects an invalid committed spec even when its unstaged repair passes lint', async (t) => {
  const { a, remote } = await machines(t)
  const before = (await git(a, 'rev-parse', 'HEAD')).stdout.trim()
  const file = path.join(a, 'spec/tasks/T001.first.md'), valid = await readFile(file, 'utf8')
  await writeFile(file, valid.replace('st:todo', 'st:done'))
  await commitAll(a, 'invalid committed task close')
  await writeFile(file, valid)
  assert.deepEqual((await lintSpec({ targetRoot: a })).errors, [])
  await assert.rejects(vibePush({ targetRoot: a }), /spec lint 실패/)
  assert.equal((await execute('git', ['--git-dir', remote, 'rev-parse', 'main'], { encoding: 'utf8' })).stdout.trim(), before)
  assert.equal(await readFile(file, 'utf8'), valid, 'the unstaged repair is preserved')
})

test('final publication checks a valid committed spec without publishing or rejecting unstaged changes', async (t) => {
  const { a, remote } = await machines(t)
  await writeFile(path.join(a, 'app.txt'), 'completed work\n')
  const candidate = await commitAll(a, 'valid candidate')
  const file = path.join(a, 'spec/tasks/T001.first.md'), valid = await readFile(file, 'utf8')
  const invalid = valid.replace('st:todo', 'st:finished')
  await writeFile(file, invalid)
  await writeFile(path.join(a, 'app.txt'), 'uncommitted work\n')
  assert.ok((await lintSpec({ targetRoot: a })).errors.length)
  const result = await vibePush({ targetRoot: a })
  assert.equal(result.pushed, candidate)
  assert.equal((await execute('git', ['--git-dir', remote, 'show', 'main:spec/tasks/T001.first.md'], { encoding: 'utf8' })).stdout, valid)
  assert.equal((await execute('git', ['--git-dir', remote, 'show', 'main:app.txt'], { encoding: 'utf8' })).stdout, 'completed work\n')
  assert.equal(await readFile(file, 'utf8'), invalid)
  assert.equal(await readFile(path.join(a, 'app.txt'), 'utf8'), 'uncommitted work\n')
})

test('local land and PR publication reject invalid candidate spec before advancing refs', async (t) => {
  const { a, remote } = await machines(t)
  await git(a, 'branch', 'next')
  const previous = (await git(a, 'rev-parse', 'next')).stdout.trim()
  await git(a, 'checkout', '-q', '-b', 'candidate')
  const file = path.join(a, 'spec/tasks/T001.first.md')
  await writeFile(file, (await readFile(file, 'utf8')).replace('st:todo', 'st:finished'))
  await writeFile(path.join(a, 'spec/SETTINGS.md'), '# SETTINGS\n- land: next\n- push: false\n')
  await commitAll(a, 'invalid local candidate')
  await assert.rejects(vibePush({ targetRoot: a }), /spec lint 실패/)
  assert.equal((await git(a, 'rev-parse', 'next')).stdout.trim(), previous)
  await writeFile(path.join(a, 'spec/SETTINGS.md'), '# SETTINGS\n- land: main\n- land-via: pr\n- push: true\n')
  await commitAll(a, 'PR candidate')
  await assert.rejects(vibePush({ targetRoot: a }), /spec lint 실패/)
  await assert.rejects(execute('git', ['--git-dir', remote, 'rev-parse', '--verify', 'refs/heads/candidate']))
})

test('final publication still supports branch settings without spec documents', async (t) => {
  const { a, remote } = await machines(t)
  await git(a, 'rm', '-qr', 'spec')
  await mkdir(path.join(a, 'spec'))
  await writeFile(path.join(a, 'spec/SETTINGS.md'), '# SETTINGS\n- land: main\n- push: true\n')
  const candidate = await commitAll(a, 'plain repository')
  const result = await vibePush({ targetRoot: a })
  assert.equal(result.pushed, candidate)
  assert.equal((await execute('git', ['--git-dir', remote, 'rev-parse', 'main'], { encoding: 'utf8' })).stdout.trim(), candidate)
})
