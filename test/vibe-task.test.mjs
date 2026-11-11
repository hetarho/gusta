import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fixture, git, execute } from './helpers/vibe-fixture.mjs'
import { vibeTask } from '../src/vibe-task.mjs'
import { closeTasks, taskRow } from '../src/state-doc.mjs'
import { lintSpec } from '../src/spec-lint.mjs'
const cli = fileURLToPath(new URL('../bin/haeram-spec-creator.mjs', import.meta.url))

const clock = { now: () => new Date('2026-10-20T09:00:00Z') }
const run = (root, step, task, extra = {}) => vibeTask({ targetRoot: root, step, task, ...extra }, clock)
const read = (root, file) => readFile(path.join(root, file), 'utf8')
async function edit(root, file, change) { await writeFile(path.join(root, file), change(await read(root, file))) }
const rejects = (promise, pattern) => assert.rejects(promise, (error) => pattern.test(`${error.message} ${JSON.stringify(error.details)}`))
const finish = (content) => content.replace('- [ ] Works', '- [v] Works').replace(/## result\n$/, '## result\n- outcome: works\n- at: -\n- verified: `node --version`\n- limits: -\n')

test('start writes doing@date.tag in the task file, STATE row and own active row, and is idempotent', async (t) => {
  const { root } = await fixture(t)
  await edit(root, 'spec/STATE.md', (text) => text.replace('## ssot', '## active\n| tag | host | mode | since | at | doing |\n|---|---|---|---|---|---|\n| ab12 | mbp | pair | 2026-10-20T08:00Z | 2026-10-20T08:00Z | - |\n\n## ssot'))
  const started = await run(root, 'start', 'T001', { tag: 'ab12' })
  assert.deepEqual(started, { schemaVersion: 1, task: 'T001', st: 'doing@261020.ab12', changed: true, files: ['spec/tasks/T001.example.md', 'spec/STATE.md'] })
  assert.match(await read(root, 'spec/tasks/T001.example.md'), /^> st:doing@261020\.ab12 \| ssot:ARCH-1/m)
  const state = await read(root, 'spec/STATE.md')
  assert.equal(taskRow(state, 'T001').st, 'doing@261020.ab12')
  assert.match(state, /\| ab12 \| mbp \| pair \| 2026-10-20T08:00Z \| 2026-10-20T08:00Z \| T001 \|/)
  assert.deepEqual((await lintSpec({ targetRoot: root })).errors, [])
  const again = await run(root, 'start', 'T001', { tag: 'ab12' })
  assert.equal(again.changed, false)
  await rejects(run(root, 'start', 'T001', { tag: 'zz99' }), /다른 세션/)
})

test('start keeps a remote claim on the STATE row and only completes the task file', async (t) => {
  const { root } = await fixture(t)
  await edit(root, 'spec/STATE.md', (text) => text.replace('| T002 | example | ARCH | - | todo |', '| T002 | example | ARCH | - | doing@261019.ab12 |'))
  const started = await run(root, 'start', 'T002', { tag: 'ab12' })
  assert.equal(started.st, 'doing@261019.ab12')
  assert.deepEqual(started.files, ['spec/tasks/T002.example.md'])
})

test('start refuses unfinished deps and tasks that are not todo', async (t) => {
  const { root } = await fixture(t)
  await edit(root, 'spec/tasks/T002.example.md', (text) => text.replace('dep:-', 'dep:T001'))
  await edit(root, 'spec/STATE.md', (text) => text.replace('| T002 | example | ARCH | - | todo |', '| T002 | example | ARCH | T001 | todo |')
    .replace('| T003 | example | ARCH | - | todo |', '| T003 | example | ARCH | - | blocked@261019 |'))
  await edit(root, 'spec/tasks/T003.example.md', (text) => text.replace('st:todo', 'st:blocked@261019'))
  await rejects(run(root, 'start', 'T002', { tag: 'ab12' }), /dep.*T001/)
  await rejects(run(root, 'start', 'T003', { tag: 'ab12' }), /todo가 아니거나/)
  await rejects(run(root, 'start', 'T001', {}), /--tag/)
  await rejects(run(root, 'start', 'T009', { tag: 'ab12' }), /파일이 없습니다/)
  assert.equal(taskRow(await read(root, 'spec/STATE.md'), 'T002').st, 'todo')
})

test('done refuses unchecked acceptance or an empty result, then archives with next and log', async (t) => {
  const { root } = await fixture(t)
  await edit(root, 'spec/tasks/T002.example.md', (text) => text.replace('dep:-', 'dep:T001'))
  await edit(root, 'spec/STATE.md', (text) => text.replace('| T002 | example | ARCH | - | todo |', '| T002 | example | ARCH | T001 | todo |')
    .replace('## ssot', '## active\n| tag | host | mode | since | at | doing |\n|---|---|---|---|---|---|\n| ab12 | mbp | pair | 2026-10-20T08:00Z | 2026-10-20T08:00Z | - |\n\n## ssot'))
  await rejects(run(root, 'done', 'T001', { tag: 'ab12' }), /doing 태스크만/)
  await run(root, 'start', 'T001', { tag: 'ab12' })
  await rejects(run(root, 'done', 'T001', { tag: 'ab12' }), /acceptance - \[ \] Works.*result: empty/)
  // template placeholders are not a result, and the at line --at writes does not fill one
  await edit(root, 'spec/tasks/T001.example.md', (text) => text.replace('- [ ] Works', '- [v] Works').replace(/## result\n$/, '## result\n- outcome: <what works now>\n'))
  await rejects(run(root, 'done', 'T001', { tag: 'ab12', at: 'HEAD' }), /result: empty.*outcome: <what works now>/)
  await edit(root, 'spec/tasks/T001.example.md', (text) => text.replace('- outcome: <what works now>\n', '- outcome: works\n- at: -\n- verified: <the checks that actually ran>\n- limits: -\n'))
  await rejects(run(root, 'done', 'T001', { tag: 'ab12' }), /result - verified: <the checks/)
  await edit(root, 'spec/tasks/T001.example.md', (text) => text.replace('<the checks that actually ran>', '`node --version`'))
  // only the owner closes it, unless the user ordered a takeover
  await rejects(run(root, 'done', 'T001'), /--tag/)
  await rejects(run(root, 'done', 'T001', { tag: 'zz99' }), /다른 세션.*--force-other/)
  const head = await git(root, 'rev-parse', 'HEAD')
  const closed = await run(root, 'done', 'T001', { tag: 'ab12', at: 'HEAD' })
  assert.equal(closed.st, 'done@261020')
  assert.deepEqual(closed.files, ['spec/tasks/T001.example.md', 'spec/tasks/done/T001.example.md', 'spec/STATE.md'])
  assert.deepEqual(closed.runnable, ['T002', 'T003'])
  assert.deepEqual(closed.next, ['- implement-task T002 T003', '- finish create-architecture interview'])
  const archived = await read(root, 'spec/tasks/done/T001.example.md')
  assert.match(archived, /^> st:done@261020 \|/m)
  assert.match(archived, new RegExp(`^- at: ${head}$`, 'm'))
  assert.deepEqual(await readdir(path.join(root, 'spec/tasks')).then((names) => names.filter((name) => name.startsWith('T001'))), [])
  const state = await read(root, 'spec/STATE.md')
  assert.equal(taskRow(state, 'T001'), null)
  assert.match(state, /## log\n- 261020 T001 done\n/)
  assert.match(state, /\| ab12 \| mbp \| pair \| [^|]+ \| [^|]+ \| - \|/)
  const lint = await lintSpec({ targetRoot: root })
  assert.deepEqual(lint.errors, [])
  assert.deepEqual(lint.warnings.filter((warning) => /T001|next|log|active/.test(warning)), [])
  const again = await run(root, 'done', 'T001', { tag: 'ab12' })
  assert.deepEqual(again, { schemaVersion: 1, task: 'T001', st: 'done', changed: false, files: [] })
})

test('done of the last task leaves a planning next, an explore exit closes it and --force-other takes another tag', async (t) => {
  const { root } = await fixture(t, 1)
  await edit(root, 'spec/tasks/T001.example.md', (text) => text.replace('touches:src/', 'touches:src/ | explore:1h')
    .replace('- [ ] Works with a regression test.', '- [ ] Works with a regression test.\n- [v] exit: record the measured values'))
  await run(root, 'start', 'T001', { tag: 'ab12' })
  await edit(root, 'spec/tasks/T001.example.md', (text) => text.replace(/## result\n$/, '## result\n- outcome: measured\n- at: -\n- verified: -\n- limits: target unmet\n'))
  const closed = await run(root, 'done', 'T001', { forceOther: true })
  assert.deepEqual(closed.next, ['- finish create-architecture interview'])
  const state = await read(root, 'spec/STATE.md')
  assert.match(state, /## log\n- 261020 T001 done\n$/)
})

test('closeTasks keeps 20 log lines, replaces generated next lines and reports missing rows', () => {
  const log = Array.from({ length: 20 }, (_, index) => `- 2610${String(index).padStart(2, '0')} older ${index}`).join('\n')
  const text = `# STATE\n\n## active\n| tag | host | mode | since | at | doing |\n|---|---|---|---|---|---|\n| ab | mbp | pair | 2026-10-20T08:00Z | 2026-10-20T08:00Z | T001 |\n\n## tasks\n| id | title | ssot | dep | st |\n|---|---|---|---|---|\n| T001 | a | ARCH | - | doing@261020.ab |\n\n## next\n- implement-task T001\n\n## log\n${log}\n`
  const closed = closeTasks(text, ['T001', 'T002'], { log: '- 261020 T001 done', next: ['- inspect work board for remaining tasks'] })
  assert.deepEqual(closed.missing, ['T002'])
  assert.match(closed.text, /## next\n- inspect work board for remaining tasks\n\n## log\n- 261020 T001 done\n/)
  assert.equal(closed.text.split('\n').filter((line) => line.startsWith('- 26')).length, 20)
  assert.doesNotMatch(closed.text, /older 19/)
  // an active row doing a closed task (solo done or work-group integration) goes back to -
  assert.match(closed.text, /\| ab \| mbp \| pair \| 2026-10-20T08:00Z \| 2026-10-20T08:00Z \| - \|/)
})

test('done refuses --at when the task has no result section', async (t) => {
  const { root } = await fixture(t, 1)
  await run(root, 'start', 'T001', { tag: 'ab12' })
  await edit(root, 'spec/tasks/T001.example.md', (text) => text.replace('- [ ] Works', '- [v] Works').replace(/\n## result\n$/, ''))
  await rejects(run(root, 'done', 'T001', { tag: 'ab12', at: 'HEAD' }), /result: empty/)
  assert.doesNotMatch(await read(root, 'spec/tasks/T001.example.md'), /## result/)
})

test('vibe task CLI prints JSON and errors as JSON', async (t) => {
  const { root } = await fixture(t)
  const started = await execute(process.execPath, [cli, 'vibe', 'task', 'start', 'T001', '--tag', 'ab12', '--target', root])
  assert.equal(JSON.parse(started.stdout).st.startsWith('doing@'), true)
  const refused = await execute(process.execPath, [cli, 'vibe', 'task', 'done', 'T001', '--tag', 'ab12', '--target', root]).catch((error) => error)
  assert.equal(refused.code, 1)
  assert.match(JSON.parse(refused.stdout).error, /acceptance/)
})
