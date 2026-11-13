import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { machines, fixture, git } from './helpers/vibe-fixture.mjs'
import { vibeSession } from '../src/vibe.mjs'
import { vibePlanPush } from '../src/vibe-plan.mjs'
import { openIntegration } from '../src/integration-gate.mjs'

async function remoteProject(t, { plan = 'delivery', remoteLand = true } = {}) {
  const context = await machines(t)
  await writeFile(path.join(context.a, 'spec/SETTINGS.md'), `# SETTINGS\n- land: delivery\n- plan: ${plan}\n- push: true\n- coord: session-ledger\n`)
  await git(context.a, 'add', 'spec/SETTINGS.md'); await git(context.a, 'commit', '-qm', 'planning configuration')
  const base = await git(context.a, 'rev-parse', 'HEAD')
  await git(context.a, 'branch', 'delivery')
  if (plan !== 'delivery') await git(context.a, 'branch', plan)
  await git(context.a, 'push', '-q', 'origin', 'main', ...(remoteLand ? ['delivery'] : []), ...(plan === 'delivery' ? [] : [plan]))
  await git(context.b, 'pull', '-q')
  await git(context.a, 'switch', '-qc', 'planning-work')
  await git(context.b, 'switch', '-qc', 'implementation-work')
  await writeFile(path.join(context.b, 'feature.js'), 'export const feature = true\n')
  await git(context.b, 'add', 'feature.js'); await git(context.b, 'commit', '-qm', 'implementation contribution')
  const authority = await openIntegration(await vibeSession({ targetRoot: context.b }))
  return { ...context, base, authority }
}

async function addPlanning(root, id = 'T003') {
  await writeFile(path.join(root, `spec/tasks/${id}.planned.md`), `# ${id} Planned\n> st:todo | ssot:ARCH-1 | base:ARCH@1 | dep:-\n\n## goal\nPlan a change.\n\n## acceptance\n- [ ] Works\n\n## impl notes\n- -\n\n## result\n`)
  const file = path.join(root, 'spec/STATE.md')
  await writeFile(file, (await readFile(file, 'utf8')).replace('\n## next', `\n| ${id} | planned | ARCH | - | todo |\n\n## next`))
  await git(root, 'add', 'spec'); await git(root, 'commit', '-qm', 'planning contribution')
  return git(root, 'rev-parse', 'HEAD')
}

async function waitForFile(file, done) {
  for (let attempt = 0; attempt < 3000; attempt++) {
    if (await readFile(file, 'utf8').catch(() => '') || done()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail('The planning publication did not reach its real Git pre-push boundary.')
}

test('a frozen land returns pending without publishing or renumbering the planning contribution', async (t) => {
  const { a, remote, base, authority } = await remoteProject(t)
  await authority.ready({ tag: 'worker01' })
  const claimed = await authority.claim({ tag: 'worker01' })
  assert.equal(claimed.ok, true)
  const planning = await addPlanning(a)
  const result = await vibePlanPush({ targetRoot: a })
  assert.deepEqual([result.ok, result.waiting, result.reason, result.automaticRecheck], [false, true, 'integration-frozen', false])
  assert.match(result.nextAction, /현재 태스크 ID를 보존/)
  assert.equal(await git(remote, 'rev-parse', 'delivery'), base)
  assert.equal(await git(a, 'rev-parse', 'HEAD'), planning)
  assert.match(await readFile(path.join(a, 'spec/tasks/T003.planned.md'), 'utf8'), /^# T003 /)
})

test('planning publication racing a remote gate claim cannot advance the newly frozen land', async (t) => {
  const { a, temporary, remote, base, authority } = await remoteProject(t)
  await authority.ready({ tag: 'worker01' })
  const planning = await addPlanning(a)
  const hooks = path.join(temporary, 'planning-hooks'), entered = path.join(temporary, 'planning-entered'), release = path.join(temporary, 'planning-release')
  await mkdir(hooks)
  await writeFile(path.join(hooks, 'pre-push'), `#!${process.execPath}\nconst fs=require('node:fs');let input='';process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',async()=>{if(!input.split('\\n').some(line=>line.split(/\\s+/)[2]==='refs/heads/delivery'))return;fs.writeFileSync(${JSON.stringify(entered)},'ready');for(let n=0;n<3000&&!fs.existsSync(${JSON.stringify(release)});n++)await new Promise(resolve=>setTimeout(resolve,10));if(!fs.existsSync(${JSON.stringify(release)}))process.exitCode=1;});\n`, { mode: 0o755 })
  await git(a, 'config', 'core.hooksPath', hooks)
  let settled = false
  const publishing = vibePlanPush({ targetRoot: a }).then((result) => ({ result }), (error) => ({ error })).finally(() => { settled = true })
  try {
    await waitForFile(entered, () => settled)
    assert.equal(await readFile(entered, 'utf8').catch(() => ''), 'ready')
    const claimed = await authority.claim({ tag: 'worker01' })
    assert.equal(claimed.ok, true)
  } finally { await writeFile(release, 'continue') }
  const outcome = await publishing
  if (outcome.error) throw outcome.error
  assert.equal(outcome.result.reason, 'integration-frozen')
  assert.equal(outcome.result.automaticRecheck, false)
  assert.equal(await git(remote, 'rev-parse', 'delivery'), base)
  assert.equal(await git(a, 'rev-parse', 'HEAD'), planning)
  assert.equal((await authority.read()).state.gate.base, base)
})

test('a successful planning publication becomes the next gate base and keeps its spec-only receipt', async (t) => {
  const { a, remote, authority } = await remoteProject(t)
  const planning = await addPlanning(a)
  const result = await vibePlanPush({ targetRoot: a })
  assert.deepEqual([result.ok, result.remote, result.published, result.pushed], [true, true, planning, planning])
  assert.equal(await git(remote, 'rev-parse', 'delivery'), planning)
  await authority.ready({ tag: 'worker01' })
  const claimed = await authority.claim({ tag: 'worker01' })
  assert.equal(claimed.ok, true)
  assert.equal(claimed.value.gate.base, planning)
  assert.deepEqual(await vibePlanPush({ targetRoot: a }), { schemaVersion: 1, ok: true, pushed: null, reason: 'up-to-date', plan: 'delivery' })
})

test('a distinct plan branch keeps its canonical flow while land is frozen', async (t) => {
  const { a, remote, base, authority } = await remoteProject(t, { plan: 'planning' })
  await authority.ready({ tag: 'worker01' }); await authority.claim({ tag: 'worker01' })
  const planning = await addPlanning(a)
  const result = await vibePlanPush({ targetRoot: a })
  assert.equal(result.ok, true)
  assert.equal(await git(remote, 'rev-parse', 'planning'), planning)
  assert.equal(await git(remote, 'rev-parse', 'delivery'), base)
})

test('an absent remote canonical branch stays local without creating a remote code branch', async (t) => {
  const { a, remote } = await remoteProject(t, { remoteLand: false })
  const planning = await addPlanning(a)
  const result = await vibePlanPush({ targetRoot: a })
  assert.deepEqual([result.ok, result.remote, result.pushed, result.local], [true, false, null, 'ff'])
  assert.equal(await git(a, 'rev-parse', 'delivery'), planning)
  await assert.rejects(git(remote, 'rev-parse', '--verify', 'refs/heads/delivery'))
})

test('a dirty local land preserves user files, releases its reservation and can be retried', async (t) => {
  const { root, temporary } = await fixture(t)
  await writeFile(path.join(root, 'spec/SETTINGS.md'), '# SETTINGS\n- land: delivery\n- plan: delivery\n- push: false\n- coord: session-ledger\n')
  await git(root, 'add', 'spec/SETTINGS.md'); await git(root, 'commit', '-qm', 'local planning configuration')
  await git(root, 'branch', '-m', 'delivery')
  const worktree = path.join(temporary, 'planning-work')
  await git(root, 'worktree', 'add', '-q', '-b', 'planning-work', worktree)
  const planned = await addPlanning(worktree, 'T004'), base = await git(root, 'rev-parse', 'HEAD')
  const file = path.join(root, 'spec/STATE.md'), original = await readFile(file, 'utf8'), dirty = `${original}\nUser work must survive.\n`
  await writeFile(file, dirty)
  await assert.rejects(vibePlanPush({ targetRoot: worktree }), /로컬 기획 브랜치 delivery/)
  assert.equal(await readFile(file, 'utf8'), dirty)
  assert.equal(await git(root, 'rev-parse', 'HEAD'), base)
  const store = await openIntegration(await vibeSession({ targetRoot: worktree }))
  assert.equal((await store.read()).state.planning, undefined)
  await writeFile(file, original)
  const result = await vibePlanPush({ targetRoot: worktree })
  assert.deepEqual([result.ok, result.local, result.published], [true, 'ff', planned])
  assert.equal(await git(root, 'rev-parse', 'HEAD'), planned)
})
