import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { git as runGit } from '../src/workspace.mjs'
import { SkillPackageError } from '../src/errors.mjs'
import { openCoord, remoteEnv, COORD_BRANCH, REMOTE_BACKOFF_MINUTES } from '../src/coord-branch.mjs'
import { EMPTY_SESSIONS, SESSIONS_FILE, ClaimError, applyEvent, claimTask, readSessions } from '../src/coord-doc.mjs'
import { machines, configure, git, execute } from './helpers/vibe-fixture.mjs'

const beat = (tag, extra = {}) => (text, { now }) => applyEvent(text, { type: 'beat', tag, host: `host-${tag}`, mode: 'autopilot', now, ...extra }).text
const claim = (tag, task) => (text, { now }) => claimTask(text, { tag, task, now, host: `host-${tag}`, mode: 'autopilot' }).text
const event = (entry) => (text) => applyEvent(text, entry).text
const sessions = async (store) => readSessions((await store.read()).text)
const holders = async (store) => (await sessions(store)).active.map((row) => `${row.tag}:${row.doing}`)
const rejection = (stderr) => Object.assign(new Error('Command failed: git'), { stderr })
const REJECTED = ' ! [rejected]        0123abc -> gusta (fetch first)\nerror: failed to push some refs to \'origin\'\n'

test('쓰기: 작업 트리·HEAD·index를 건드리지 않고, 코드와 히스토리를 공유하지 않는 브랜치를 만든다', async (t) => {
  const { a, temporary } = await machines(t)
  await writeFile(path.join(a, 'untracked.txt'), 'untracked\n')
  await writeFile(path.join(a, 'spec/FORMAT.md'), '# FORMAT\nstaged\n')
  await git(a, 'add', 'spec/FORMAT.md')
  await writeFile(path.join(a, 'spec/STATE.md'), 'unstaged\n')
  const index = async () => createHash('sha256').update(await readFile(path.join(a, '.git/index'))).digest('hex')
  const checkout = async () => ({ status: await git(a, 'status', '--porcelain'), head: await git(a, 'rev-parse', 'HEAD'), branch: await git(a, 'symbolic-ref', 'HEAD'), staged: await git(a, 'ls-files', '-s') })
  const before = await checkout()
  const indexBefore = await index()

  const store = await openCoord({ cwd: path.join(a, 'spec'), push: false }, { now: () => new Date('2026-10-13T07:44:30Z') })
  assert.equal(store.branch, COORD_BRANCH)
  assert.deepEqual(await store.read(), { commit: null, text: EMPTY_SESSIONS })
  // 본문이 같으면 커밋하지 않는다: 브랜치도 생기지 않는다.
  assert.deepEqual(await store.update((text) => text), { commit: null, text: EMPTY_SESSIONS, changed: false, attempts: 1, value: EMPTY_SESSIONS })
  assert.equal(await git(a, 'branch', '--list', 'gusta'), '')
  const first = await store.update(beat('aaaa'), { message: 'gusta aaaa: beat' })
  assert.deepEqual([first.changed, first.attempts], [true, 1])
  assert.equal(await git(a, 'rev-list', '--parents', '-1', 'gusta'), first.commit, '부모 없는 커밋')
  const second = await store.update((text, { now }) => claimTask(text, { tag: 'aaaa', task: 'T001', now }), { message: (value) => `gusta aaaa: claim (${value.released.length} released)` })
  assert.deepEqual(second.value.released, [])
  assert.equal(await git(a, 'rev-list', '--parents', '-1', 'gusta'), `${second.commit} ${first.commit}`)
  assert.equal(await git(a, 'log', '-1', '--format=%s', 'gusta'), 'gusta aaaa: claim (0 released)')
  // at만 옮긴 beat는 본문이 달라졌어도 호출자가 changed를 보고 버릴 수 있다.
  const idle = await store.update((text, { now }) => { const next = applyEvent(text, { type: 'beat', tag: 'aaaa', now }); return next.changed ? next.text : text })
  assert.deepEqual([idle.changed, idle.commit], [false, second.commit])
  assert.deepEqual(await store.read(), { commit: second.commit, text: second.text })
  assert.deepEqual((await sessions(store)).active, [{ tag: 'aaaa', host: 'host-aaaa', mode: 'autopilot', since: '2026-10-13T07:44Z', at: '2026-10-13T07:44Z', doing: 'T001', branch: '-', commit: '-' }])

  assert.equal(await index(), indexBefore)
  assert.deepEqual(await checkout(), before)
  assert.equal(await git(a, 'ls-tree', '-r', '--name-only', 'gusta'), SESSIONS_FILE)
  assert.equal(`${await git(a, 'show', `gusta:${SESSIONS_FILE}`)}\n`, second.text)
  await assert.rejects(execute('git', ['-C', a, 'merge-base', 'gusta', 'main']), (error) => error.code === 1)

  // 조정 브랜치를 checkout한 worktree가 있으면 쓰지 않는다. 읽기와 변화 없는 갱신은 된다.
  await git(a, 'worktree', 'add', '-q', path.join(temporary, 'coordination'), 'gusta')
  await assert.rejects(store.update(beat('bbbb')), (error) => error instanceof SkillPackageError && /checkout돼 있어/.test(error.message) && error.details[0].endsWith('coordination'))
  assert.equal((await store.read()).commit, second.commit)
  assert.equal((await store.update((text) => text)).changed, false)
  await assert.rejects(openCoord({ cwd: a, branch: '-bad name' }), /조정 브랜치 이름/)
})

test('로컬 경합: ref가 그사이 움직이면 병합하지 않고 의도를 새 본문에 다시 적용한다', async (t) => {
  const { a } = await machines(t)
  const other = await openCoord({ cwd: a, push: false })
  await other.update(beat('bbbb'))
  let interfere = null
  const racing = await openCoord({ cwd: a, push: false }, {
    sleep: async () => {},
    git: async (cwd, args, allowed) => {
      if (args[0] === 'update-ref' && interfere) await interfere()
      return runGit(cwd, args, allowed)
    },
  })
  // 첫 update-ref 직전에 다른 세션이 T001을 잡는다: 우리의 log 한 줄은 그 위에 다시 적용된다.
  const seen = []
  interfere = async () => { interfere = null; await other.update(claim('bbbb', 'T001')) }
  const logged = await racing.update((text) => { seen.push(readSessions(text).active[0].doing); return applyEvent(text, { type: 'log', line: '- 261013 hello' }).text })
  assert.deepEqual([logged.changed, logged.attempts], [true, 2])
  assert.deepEqual(seen, ['-', 'T001'])
  assert.deepEqual(await holders(racing), ['bbbb:T001'])
  assert.deepEqual((await sessions(racing)).log, ['- 261013 hello'])
  assert.equal(await git(a, 'rev-list', '--count', 'gusta'), '3')
  assert.equal(await git(a, 'rev-list', '--count', '--merges', 'gusta'), '0')
  // 같은 태스크를 그사이 남이 잡으면 다시 적용한 mutate가 던지고, 그대로 호출자에게 간다.
  interfere = async () => { interfere = null; await other.update(claim('bbbb', 'T002')) }
  await assert.rejects(racing.update(claim('aaaa', 'T002')), (error) => error instanceof ClaimError && error.owner === 'bbbb' && error.task === 'T002')
  assert.deepEqual(await holders(racing), ['bbbb:T002'])
  // 매번 밀리면 시도 횟수 안에서 멈춘다.
  let moves = 0
  interfere = async () => { moves += 1; await other.update(event({ type: 'log', line: `- 261013 move ${moves}` })) }
  await assert.rejects(racing.update(beat('aaaa'), { attempts: 3 }), (error) => error instanceof SkillPackageError && /3회 시도/.test(error.message))
  assert.equal(moves, 3)
  assert.deepEqual(await holders(racing), ['bbbb:T002'])
})

test('publish: push 거절은 다시 합쳐 재시도하고, 인증·시간 초과·거절은 throw하지 않고 이유로 돌려준다', async (t) => {
  const { a, remote } = await machines(t)
  const calls = []
  const open = (respond, context = {}) => openCoord({ cwd: a, record: null, ...context }, { sleep: async () => {}, remote: async (cwd, args) => { calls.push(args[0]); return respond(args) ?? runGit(cwd, args) } })
  const remoteBranch = () => git(remote, 'branch', '--list', 'gusta')

  let pushes = 0
  const flaky = await open((args) => { if (args[0] === 'push' && (pushes += 1) < 3) throw rejection(REJECTED) })
  await flaky.update(beat('aaaa'))
  // 거절이 이어지면 시도 횟수 안에서 멈추고 이유를 돌려준다.
  assert.deepEqual(await flaky.publish({ attempts: 2 }), { pushed: false, reason: 'rejected', error: REJECTED.trim(), lost: [] })
  assert.equal(await remoteBranch(), '')
  assert.equal(await flaky.unpublished(), true, '원격이 아직 갖지 못한 커밋이 있다')
  pushes = 0
  calls.length = 0
  const published = await flaky.publish()
  assert.deepEqual(published, { pushed: true, commit: (await flaky.read()).commit, attempts: 3, lost: [] })
  assert.deepEqual(calls, ['fetch', 'ls-remote', 'push', 'fetch', 'ls-remote', 'push', 'fetch', 'ls-remote', 'push'])
  assert.equal(await git(remote, 'rev-parse', 'gusta'), published.commit)
  assert.equal(await git(a, 'rev-parse', 'refs/remotes/origin/gusta'), published.commit)
  assert.equal(await flaky.unpublished(), false)

  const failing = async (stage, error, expected) => {
    const store = await open((args) => { if (args[0] === stage) throw error })
    await store.update(event({ type: 'log', line: `- 261013 ${stage} ${expected}` }))
    calls.length = 0
    const result = await store.publish()
    assert.deepEqual([result.pushed, result.reason, result.lost], [false, expected, []], `${stage}: ${JSON.stringify(result)}`)
    assert.ok(result.error)
    return calls.filter((call) => call === 'push').length
  }
  assert.equal(await failing('fetch', rejection('fatal: could not read Username for \'https://example.invalid\': terminal prompts disabled\n'), 'auth'), 0)
  assert.equal(await failing('push', rejection('git@example.invalid: Permission denied (publickey).\nfatal: Could not read from remote repository.\n'), 'auth'), 1)
  assert.equal(await failing('fetch', rejection('fatal: unable to access \'https://example.invalid/\': Could not resolve host: example.invalid\n'), 'network'), 0)
  assert.equal(await failing('fetch', Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM', stderr: '' }), 'timeout'), 0)
  // hook·보호 규칙의 거절은 다시 밀어도 같으므로 한 번만 시도한다.
  assert.equal(await failing('push', rejection(' ! [remote rejected] 0123abc -> gusta (pre-receive hook declined)\nerror: failed to push some refs\n'), 'push-failed'), 1)
  assert.equal(await git(remote, 'rev-parse', 'gusta'), published.commit, '실패한 동안 원격은 그대로')

  // sync도 닿지 않는 원격에 throw하지 않는다.
  const offline = await open((args) => { if (args[0] === 'fetch') throw rejection('fatal: unable to access \'https://example.invalid/\': Failed to connect: Connection refused\n') })
  const synced = await offline.sync()
  assert.deepEqual([synced.action, synced.reason, synced.lost], ['none', 'network', []])
  // push가 꺼져 있으면 원격을 부르지 않는다. 원격이 없어도 마찬가지다.
  calls.length = 0
  const disabled = await open(() => { throw new Error('remote must not be called') }, { push: false })
  assert.deepEqual(await disabled.publish(), { pushed: false, reason: 'disabled', lost: [] })
  assert.deepEqual(await disabled.sync(), { action: 'none', reason: 'disabled', lost: [] })
  // 올리지 않는 저장소에는 밀린 것도 없다(실패한 push가 남긴 커밋이 있어도).
  assert.equal(await disabled.unpublished(), false)
  const alone = await open(() => { throw new Error('remote must not be called') }, { remote: null })
  assert.deepEqual(await alone.publish(), { pushed: false, reason: 'no-remote', lost: [] })
  assert.deepEqual(await alone.sync(), { action: 'none', reason: 'no-remote', lost: [] })
  assert.deepEqual(calls, [])
  // 그 뒤 실제 원격에는 쌓인 것이 한 번에 올라간다.
  const real = await openCoord({ cwd: a })
  assert.equal((await real.publish()).pushed, true)
  assert.equal(await git(remote, 'rev-parse', 'gusta'), (await real.read()).commit)
})

test('같은 clone의 worktree: 동시 선점은 정확히 하나만 성공하고 push 없이 서로 보인다', async (t) => {
  const { a, remote, temporary } = await machines(t)
  const trees = { aaaa: path.join(temporary, 'tree one'), bbbb: path.join(temporary, 'tree two') }
  for (const [tag, tree] of Object.entries(trees)) await git(a, 'worktree', 'add', '-q', '-b', `feat/${tag}`, tree)
  const stores = Object.fromEntries(await Promise.all(Object.entries(trees).map(async ([tag, cwd]) => [tag, await openCoord({ cwd })])))
  const main = await openCoord({ cwd: a })
  for (const task of ['T001', 'T002', 'T003', 'T004', 'T005', 'T006']) {
    const results = await Promise.allSettled(Object.entries(stores).map(([tag, store]) => store.update(claim(tag, task), { message: `gusta ${tag}: claim ${task}` })))
    const won = Object.keys(stores).filter((tag, index) => results[index].status === 'fulfilled')
    const refused = results.filter((result) => result.status === 'rejected').map((result) => result.reason)
    assert.equal(won.length, 1, `${task}: ${results.map((result) => result.status)}`)
    assert.ok(refused[0] instanceof ClaimError, `${task}: ${refused[0]?.stack}`)
    assert.deepEqual([refused[0].task, refused[0].owner, refused[0].reason], [task, won[0], 'claimed'])
    // 다른 worktree도, 원래 checkout도 push 없이 같은 선점을 본다.
    for (const store of [...Object.values(stores), main]) assert.equal((await sessions(store)).active.find((row) => row.doing === task)?.tag, won[0])
  }
  assert.equal(await git(remote, 'branch', '--list', 'gusta'), '')
  assert.equal(await git(a, 'rev-list', '--count', '--merges', 'gusta'), '0')
})

test('기기 a·b: push 거절 → 병합 → 재시도, 같은 태스크는 먼저 올린 쪽이 이기고 진 쪽이 lost를 받는다', async (t) => {
  const { a, b, remote } = await machines(t)
  const storeA = await openCoord({ cwd: a })
  await storeA.update(beat('aaaa'))
  await storeA.update(event({ type: 'inbox-add', line: '- 261013 parked T009: needs the owner' }))
  assert.equal((await storeA.publish()).pushed, true)

  // b의 첫 push 직전에 a가 같은 태스크를 올린다: b의 push는 실제로 거절된다.
  let raced = false
  const storeB = await openCoord({ cwd: b }, { remote: async (cwd, args) => {
    if (args[0] === 'push' && !raced) {
      raced = true
      await storeA.update(claim('aaaa', 'T001'))
      assert.equal((await storeA.publish()).pushed, true)
    }
    return runGit(cwd, args)
  } })
  // b에는 아직 브랜치가 없다: 원격 것을 그대로 받는다.
  const adopted = await storeB.sync()
  assert.deepEqual(adopted, { action: 'ff', commit: await git(remote, 'rev-parse', 'gusta'), lost: [] })
  await storeB.update(claim('bbbb', 'T001'))
  await storeB.update(event({ type: 'inbox-add', line: '- 261013 suggest -: from b' }))
  const published = await storeB.publish()
  assert.deepEqual([published.pushed, published.attempts], [true, 2])
  assert.deepEqual(published.lost, [{ task: 'T001', owner: 'aaaa', tag: 'bbbb', reason: 'claimed' }])
  assert.deepEqual(await holders(storeB), ['aaaa:T001', 'bbbb:-'])
  assert.equal((await git(b, 'rev-list', '--parents', '-1', 'gusta')).split(' ').length, 3, '부모 둘인 병합 커밋')
  assert.equal(await git(remote, 'rev-parse', 'gusta'), published.commit)
  // a는 fast-forward로 b의 결과를 본다.
  assert.deepEqual(await storeA.sync(), { action: 'ff', commit: published.commit, lost: [] })
  assert.deepEqual(await holders(storeA), ['aaaa:T001', 'bbbb:-'])
  assert.deepEqual((await sessions(storeA)).inbox, ['- 261013 parked T009: needs the owner', '- 261013 suggest -: from b'])
  assert.deepEqual(await storeA.sync(), { action: 'none', commit: published.commit, lost: [] })

  // 갈라진 뒤 합쳐도 한쪽이 지운 inbox 줄은 되살아나지 않는다(merge-base가 base).
  await storeA.update(event({ type: 'inbox-resolve', line: '- 261013 parked T009: needs the owner' }))
  await storeB.update(event({ type: 'log', line: '- 261013 b worked' }))
  assert.equal((await storeA.publish()).pushed, true)
  const merged = await storeB.sync()
  assert.deepEqual([merged.action, merged.lost], ['merge', []])
  assert.deepEqual((await sessions(storeB)).inbox, ['- 261013 suggest -: from b'])
  assert.deepEqual((await sessions(storeB)).log, ['- 261013 b worked'])
  assert.deepEqual(await storeB.publish(), { pushed: true, commit: merged.commit, attempts: 1, lost: [] })
  // 어느 쪽 checkout도 조정 브랜치로 바뀌지 않았다.
  for (const root of [a, b]) assert.deepEqual([await git(root, 'symbolic-ref', '--short', 'HEAD'), await git(root, 'status', '--porcelain')], ['main', ''])
})

test('기기마다 따로 만든 브랜치는 빈 base로 합치고, 받아 둔 원격 브랜치가 있으면 그 위에서 시작한다', async (t) => {
  const { a, b, remote, temporary } = await machines(t)
  const storeA = await openCoord({ cwd: a })
  const storeB = await openCoord({ cwd: b })
  await storeA.update(claim('aaaa', 'T001'))
  await storeB.update(claim('bbbb', 'T001'))
  await storeB.update(claim('bbbb', 'T002'))
  assert.equal((await storeA.publish()).pushed, true)
  const rootA = await git(a, 'rev-parse', 'gusta')
  const rootB = await git(b, 'rev-list', '--max-parents=0', 'gusta')
  // b는 원격 브랜치를 모른 채 자기 브랜치를 만들었다: 공통 조상이 없다.
  const published = await storeB.publish()
  assert.deepEqual([published.pushed, published.attempts, published.lost], [true, 1, []])
  assert.deepEqual((await git(b, 'rev-list', '--max-parents=0', 'gusta')).split('\n').sort(), [rootA, rootB].sort())
  assert.deepEqual(await holders(storeB), ['bbbb:T002', 'aaaa:T001'])
  // 세 번째 기기: 평범한 clone이 받아 온 원격 브랜치가 읽기와 첫 쓰기의 출발점이다.
  const c = path.join(temporary, 'machine c')
  await execute('git', ['clone', '-q', remote, c])
  await configure(c, temporary)
  const storeC = await openCoord({ cwd: c, push: false })
  assert.equal(await git(c, 'branch', '--list', 'gusta'), '')
  assert.deepEqual(await storeC.read(), { commit: published.commit, text: (await storeB.read()).text })
  await assert.rejects(storeC.update(claim('cccc', 'T002')), (error) => error instanceof ClaimError && error.owner === 'bbbb')
  const joined = await storeC.update(claim('cccc', 'T003'))
  assert.equal(await git(c, 'rev-list', '--parents', '-1', 'gusta'), `${joined.commit} ${published.commit}`)
  assert.deepEqual(await storeC.publish(), { pushed: false, reason: 'disabled', lost: [] })
})

test('닿지 않는 원격: 실제 git이 실패해도 publish·sync는 throw하지 않고 로컬 조정은 계속된다', async (t) => {
  const { a } = await machines(t)
  const port = await new Promise((resolve, reject) => {
    const server = net.createServer().once('error', reject).listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)) })
  })
  await git(a, 'remote', 'set-url', 'origin', `git://127.0.0.1:${port}/project.git`)
  const store = await openCoord({ cwd: a, timeout: 20000 })
  const written = await store.update(claim('aaaa', 'T001'))
  const published = await store.publish()
  assert.deepEqual([published.pushed, published.reason, published.lost], [false, 'network', []], JSON.stringify(published))
  assert.match(published.error, /connect|refused/i)
  // 그 뒤 10분은 원격을 다시 부르지 않는다(backoff): 이유와 다시 시도할 시각을 돌려준다.
  const synced = await store.sync()
  assert.deepEqual([synced.action, synced.reason, synced.backoff.reason], ['none', 'backoff', 'network'])
  assert.deepEqual(await store.read(), { commit: written.commit, text: written.text })
  assert.equal((await store.update(event({ type: 'log', line: '- 261013 offline' }))).changed, true)
})

test('원격 호출: 자격 증명 프롬프트를 모두 막고, 사용자의 ssh 명령을 잇고, 멈춘 연결은 timeout으로 끝낸다', async (t) => {
  const env = remoteEnv({ PATH: '/bin', GIT_TERMINAL_PROMPT: '1' })
  assert.deepEqual([env.GIT_TERMINAL_PROMPT, env.GCM_INTERACTIVE, env.SSH_ASKPASS_REQUIRE, env.GIT_SSH_COMMAND, env.PATH], ['0', 'never', 'never', 'ssh -o BatchMode=yes', '/bin'])
  assert.equal(remoteEnv({ GIT_SSH_COMMAND: 'ssh -i ~/.ssh/work' }, 'ssh -F none').GIT_SSH_COMMAND, 'ssh -i ~/.ssh/work -o BatchMode=yes')
  assert.equal(remoteEnv({}, 'ssh -F none').GIT_SSH_COMMAND, 'ssh -F none -o BatchMode=yes')
  assert.equal(remoteEnv({ GIT_SSH: '/opt/plink' }).GIT_SSH_COMMAND, undefined)

  // 기본 실행기를 끝까지: core.sshCommand로 둔 가짜 ssh가 받은 인자와 환경을 적고 실패한다.
  const { a, temporary } = await machines(t)
  const record = path.join(temporary, 'ssh.log')
  const fake = path.join(temporary, 'fake-ssh.sh')
  const script = (tail) => `#!/bin/sh\nprintf 'args %s\\n' "$*" >> '${record}'\nenv | grep -E '^(GIT_TERMINAL_PROMPT|GCM_INTERACTIVE|SSH_ASKPASS_REQUIRE)=' >> '${record}'\n${tail}\n`
  await writeFile(fake, script('exit 1'))
  await chmod(fake, 0o755)
  await git(a, 'config', 'core.sshCommand', `'${fake}'`)
  await git(a, 'remote', 'set-url', 'origin', 'ssh://git@example.invalid/project.git')
  const environment = { ...process.env }
  delete process.env.GIT_SSH_COMMAND
  delete process.env.GIT_SSH
  t.after(() => { Object.assign(process.env, environment) })
  const store = await openCoord({ cwd: a, timeout: 20000 })
  await store.update(beat('aaaa'))
  const published = await store.publish()
  assert.equal(published.pushed, false, JSON.stringify(published))
  assert.ok(['network', 'auth', 'fetch-failed'].includes(published.reason), JSON.stringify(published))
  const recorded = await readFile(record, 'utf8')
  assert.match(recorded, /^args .*-o BatchMode=yes/m)
  for (const line of ['GIT_TERMINAL_PROMPT=0', 'GCM_INTERACTIVE=never', 'SSH_ASKPASS_REQUIRE=never']) assert.ok(recorded.split('\n').includes(line), `${line}\n${recorded}`)

  // 응답 없는 원격: timeout이 호출을 끝내고 이유로 돌아온다.
  await writeFile(fake, script('exec sleep 4'))
  const stalled = await openCoord({ cwd: a, timeout: 400, record: null })
  const started = Date.now()
  const waited = await stalled.publish()
  assert.deepEqual([waited.pushed, waited.reason], [false, 'timeout'], JSON.stringify(waited))
  assert.ok(Date.now() - started < 3500, `${Date.now() - started}ms`)
})

test('원격 실패 backoff: 인증·시간 초과·네트워크로 실패하면 10분 동안 원격을 부르지 않고 이유와 다시 시도할 시각을 돌려주며, 성공하면 지운다', async (t) => {
  const { a, temporary } = await machines(t)
  let clock = Date.parse('2026-10-13T07:44:10Z')
  const calls = []
  let respond = (args) => { if (args[0] === 'fetch') throw rejection('fatal: could not read Username for \'https://example.invalid\': terminal prompts disabled\n') }
  const deps = { now: () => new Date(clock), sleep: async () => {}, remote: async (cwd, args) => { calls.push(args[0]); return respond(args) ?? runGit(cwd, args) } }
  const store = await openCoord({ cwd: a }, deps)
  assert.equal(REMOTE_BACKOFF_MINUTES, 10)
  await store.update(beat('aaaa'))
  const failed = await store.publish()
  assert.deepEqual([failed.pushed, failed.reason, calls], [false, 'auth', ['fetch']])
  const expected = { reason: 'auth', at: '2026-10-13T07:44Z', until: '2026-10-13T07:54Z' }
  const recorded = async () => JSON.parse(await readFile(path.join(a, '.git/gusta/v1/coord.json'), 'utf8')).backoff ?? null
  assert.deepEqual({ ...await recorded(), error: undefined }, { ...expected, error: undefined })
  assert.match((await recorded()).error, /could not read Username/)
  // 그 사이에는 원격에 닿지 않는다: publish·sync 모두 바로 backoff로 돌아온다. 같은 clone의 다른 worktree도 같다.
  clock += 9 * 60000
  calls.length = 0
  assert.deepEqual(await store.publish(), { pushed: false, reason: 'backoff', backoff: expected, lost: [] })
  assert.deepEqual(await store.sync(), { action: 'none', reason: 'backoff', backoff: expected, lost: [] })
  const tree = path.join(temporary, 'tree')
  await git(a, 'worktree', 'add', '-q', '-b', 'feat/tree', tree)
  assert.equal((await (await openCoord({ cwd: tree }, deps)).publish()).reason, 'backoff')
  assert.deepEqual([calls, await store.backoff(), await store.unpublished()], [[], expected, true])
  // 시간이 지나면 다시 시도하고, 닿으면 기록을 지운다.
  clock += 2 * 60000
  respond = () => null
  assert.equal((await store.publish()).pushed, true)
  assert.deepEqual([calls, await store.backoff(), await recorded()], [['fetch', 'ls-remote', 'push'], null, null])
  // 시간 초과·네트워크도 같고, 원격이 거절한 push(hook·보호 규칙·경합)는 backoff하지 않는다.
  for (const [error, reason] of [[Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM', stderr: '' }), 'timeout'],
    [rejection('fatal: unable to access \'https://example.invalid/\': Could not resolve host: example.invalid\n'), 'network'],
    [rejection(' ! [remote rejected] 0123abc -> gusta (pre-receive hook declined)\nerror: failed to push some refs\n'), null]]) {
    await store.update(event({ type: 'log', line: `- 261013 ${reason}` }))
    respond = (args) => { if (args[0] === (reason ? 'fetch' : 'push')) throw error }
    assert.equal((await store.publish()).reason, reason ?? 'push-failed')
    assert.equal((await store.backoff())?.reason ?? null, reason)
    clock += 11 * 60000
  }
  // backoff를 쓰지 않는 저장소(record: null)는 매번 원격을 부른다.
  respond = (args) => { if (args[0] === 'fetch') throw rejection('fatal: Could not read from remote repository.\n') }
  const plain = await openCoord({ cwd: a, record: null }, deps)
  calls.length = 0
  for (let index = 0; index < 2; index += 1) assert.equal((await plain.publish()).reason, 'network')
  assert.deepEqual([calls, await plain.backoff()], [['fetch', 'fetch'], null])
})

test('조정 브랜치를 만들 수 없는 이름(ref 충돌)은 재시도 없이 원인과 해법을 말하고, writable이 쓰기 전에 알려 준다', async (t) => {
  const { a, temporary } = await machines(t)
  // refs/heads/gusta/feature가 있으면 refs/heads/gusta를 만들 수 없다(그 반대도).
  await git(a, 'branch', 'gusta/feature', 'main')
  let moves = 0
  const store = await openCoord({ cwd: a }, { sleep: async () => {}, git: async (cwd, args, allowed) => { if (args[0] === 'update-ref') moves += 1; return runGit(cwd, args, allowed) } })
  const conflict = await store.writable()
  assert.deepEqual([conflict.ok, conflict.reason], [false, 'ref-conflict'])
  assert.match(conflict.error, /refs\/heads\/gusta\/feature/)
  await assert.rejects(store.update(beat('aaaa')), (error) => error instanceof SkillPackageError && /ref 이름이 충돌/.test(error.message) && /coord를 다른 이름으로/.test(error.message) && /refs\/heads\/gusta\/feature/.test(error.details.join(' ')))
  assert.equal(moves, 0)
  await git(a, 'branch', 'team', 'main')
  assert.equal((await (await openCoord({ cwd: a, branch: 'team/sessions' })).writable()).reason, 'ref-conflict')
  // 쓸 수 있는 이름은 ok. 그 브랜치를 checkout한 worktree가 있으면 쓸 수 없다고 알린다.
  const fine = await openCoord({ cwd: a, branch: 'sessions' })
  assert.deepEqual(await fine.writable(), { ok: true })
  await fine.update(beat('aaaa'))
  await git(a, 'worktree', 'add', '-q', path.join(temporary, 'coordination'), 'sessions')
  const held = await fine.writable()
  assert.deepEqual([held.ok, held.reason], [false, 'checked-out'])
  assert.match(held.error, /checkout돼 있어/)
  await git(a, 'worktree', 'remove', '--force', path.join(temporary, 'coordination'))
  // git 사용자 정보가 없으면 커밋할 수 없다.
  for (const [key, value] of [['user.name', ''], ['user.email', ''], ['user.useConfigOnly', 'true']]) await git(a, 'config', key, value)
  const identity = ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'EMAIL']
  const saved = identity.map((key) => [key, process.env[key]])
  for (const key of identity) delete process.env[key]
  t.after(() => { for (const [key, value] of saved) if (value !== undefined) process.env[key] = value })
  const anonymous = await fine.writable()
  assert.deepEqual([anonymous.ok, anonymous.reason], [false, 'no-identity'])
  assert.match(anonymous.error, /user\.name·user\.email/)
})

test('원격에 다른 브랜치가 없으면 조정 브랜치를 올리지 않는다(호스팅 기본 브랜치가 되지 않게)', async (t) => {
  const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), 'gusta-coord-')))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const remote = path.join(temporary, 'remote.git')
  const root = path.join(temporary, 'project')
  await execute('git', ['init', '-q', '--bare', '-b', 'main', remote])
  await mkdir(root)
  await git(root, 'init', '-q', '-b', 'main')
  await configure(root, temporary)
  await writeFile(path.join(root, 'README.md'), '# project\n')
  await git(root, 'add', '-A'); await git(root, 'commit', '-q', '-m', 'init')
  await git(root, 'remote', 'add', 'origin', remote)
  const store = await openCoord({ cwd: root })
  assert.equal(store.remote, 'origin')
  const written = await store.update(beat('aaaa'))
  assert.deepEqual(await store.publish(), { pushed: false, reason: 'remote-empty', lost: [] })
  assert.equal(await git(remote, 'for-each-ref'), '')
  // 코드 브랜치가 올라간 뒤에는 올린다. 원격의 기본 브랜치는 그대로다.
  await git(root, 'push', '-q', 'origin', 'main')
  assert.deepEqual(await store.publish(), { pushed: true, commit: written.commit, attempts: 1, lost: [] })
  assert.equal(await git(remote, 'symbolic-ref', 'HEAD'), 'refs/heads/main')
  assert.deepEqual(await store.publish(), { pushed: false, reason: 'up-to-date', commit: written.commit, lost: [] })
  // 원격이 없는 저장소, 그리고 Git checkout이 아닌 곳.
  await git(root, 'remote', 'remove', 'origin')
  const alone = await openCoord({ cwd: root })
  assert.equal(alone.remote, null)
  assert.deepEqual(await alone.publish(), { pushed: false, reason: 'no-remote', lost: [] })
  await assert.rejects(openCoord({ cwd: temporary }), /Git checkout이 필요합니다/)
})

test('같은 이름의 코드 브랜치가 이미 있으면 읽지도 쓰지도 올리지도 않고, 이름을 바꾸라고 알린다', async (t) => {
  const { a, b, remote } = await machines(t)
  const foreign = (name) => (error) => error instanceof SkillPackageError && /이미 다른 용도/.test(error.message) && /SETTINGS\.md coord/.test(error.message) && error.details[0].startsWith(`${name} `) && /spec/.test(error.details[0])
  // 이 clone에 gusta라는 코드 브랜치가 있다.
  await git(a, 'branch', 'gusta', 'main')
  const tip = await git(a, 'rev-parse', 'gusta')
  const calls = []
  const store = await openCoord({ cwd: a }, { remote: async (cwd, args) => { calls.push(args[0]); return runGit(cwd, args) } })
  await assert.rejects(store.read(), foreign('refs/heads/gusta'))
  await assert.rejects(store.update(beat('aaaa')), foreign('refs/heads/gusta'))
  await assert.rejects(store.update((text) => text), foreign('refs/heads/gusta'))
  // publish·sync는 던지지 않고 이유로 돌려주며, 코드 브랜치를 원격에 올리지 않는다.
  const published = await store.publish()
  assert.deepEqual([published.pushed, published.reason, published.lost], [false, 'foreign-branch', []])
  assert.match(published.error, /이미 다른 용도.*refs\/heads\/gusta/)
  const synced = await store.sync()
  assert.deepEqual([synced.action, synced.reason], ['none', 'foreign-branch'])
  assert.ok(!calls.includes('push'))
  assert.equal(await git(a, 'rev-parse', 'gusta'), tip)
  assert.equal(await git(remote, 'branch', '--list', 'gusta'), '')
  // 다른 이름으로는 평소처럼 쓴다.
  const renamed = await openCoord({ cwd: a, branch: 'gusta-sessions' })
  assert.equal((await renamed.update(beat('aaaa'))).changed, true)
  assert.equal((await renamed.publish()).pushed, true)

  // 원격에만 그 이름의 코드 브랜치가 있고, 이 기기는 아직 받아 본 적이 없다.
  await git(a, 'push', '-q', 'origin', 'gusta')
  const storeB = await openCoord({ cwd: b })
  const written = await storeB.update(beat('bbbb'))
  assert.equal(written.changed, true)
  // 올리려고 받아 보는 순간 알게 된다: 원격 브랜치는 그대로다.
  const refused = await storeB.publish()
  assert.deepEqual([refused.pushed, refused.reason], [false, 'foreign-branch'])
  assert.equal(await git(remote, 'rev-parse', 'gusta'), tip)
  // 받아 둔 원격 추적 ref가 코드 브랜치이므로 그 뒤로는 읽기·쓰기도 멈춘다. 로컬에 쓴 것은 남아 있다.
  await assert.rejects(storeB.read(), foreign('refs/remotes/origin/gusta'))
  await assert.rejects(storeB.update(claim('bbbb', 'T001')), foreign('refs/remotes/origin/gusta'))
  assert.equal(await git(b, 'rev-parse', 'gusta'), written.commit)
  assert.equal(await git(b, 'show', `gusta:${SESSIONS_FILE}`), written.text.trimEnd())
  // 조정 브랜치로 쓰던 이름에 파일이 하나 더 얹힌 커밋도 조정 브랜치가 아니다.
  const mixed = path.join(await realpath(path.dirname(a)), 'mixed')
  await git(a, 'worktree', 'add', '-q', mixed, 'gusta-sessions')
  await writeFile(path.join(mixed, 'notes.txt'), 'not coordination\n')
  await git(mixed, 'add', '-A'); await git(mixed, 'commit', '-q', '-m', 'someone committed here')
  await git(a, 'worktree', 'remove', '--force', mixed)
  await assert.rejects(renamed.read(), (error) => /이미 다른 용도/.test(error.message) && /SESSIONS\.md, notes\.txt/.test(error.details[0]))
})
