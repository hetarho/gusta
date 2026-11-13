import { mkdtemp, mkdir, readFile, readdir, writeFile, rm, realpath } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import os from 'node:os'
import path from 'node:path'
export const execute = promisify(execFile)
export const git = async (root, ...args) => (await execute('git', ['-C', root, ...args], { encoding: 'utf8' })).stdout.trim()
// What `vibe task done` leaves (gusta-implement-task §5), without committing: acceptance checked, the
// result filled, done@date in the file archived under tasks/done, the STATE row gone. false: no open file.
export async function archiveTask(root, id) {
  const name = (await readdir(path.join(root, 'spec/tasks')).catch(() => [])).find((file) => file.startsWith(`${id}.`))
  if (!name) return false
  const text = (await readFile(path.join(root, 'spec/tasks', name), 'utf8')).replace(/st:[^\s|]+/, 'st:done@261112').replaceAll('- [ ]', '- [v]')
    .replace(/## result\n*$/, '## result\n- outcome: done\n- at: -\n- verified: unit tests\n- limits: -\n')
  await mkdir(path.join(root, 'spec/tasks/done'), { recursive: true })
  await writeFile(path.join(root, 'spec/tasks/done', name), text)
  await rm(path.join(root, 'spec/tasks', name))
  const state = path.join(root, 'spec/STATE.md')
  await writeFile(state, (await readFile(state, 'utf8')).split('\n').filter((line) => !line.startsWith(`| ${id} |`)).join('\n'))
  return true
}
export async function fixture(t, count = 3) {
  const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), 'gusta-v060-')))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const root = path.join(temporary, 'project')
  await mkdir(root)
  await git(root, 'init', '-q', '-b', 'main')
  for (const [key, value] of [['user.name', 'Test'], ['user.email', 'test@example.com'], ['commit.gpgsign', 'false'], ['core.hooksPath', '/dev/null']]) await git(root, 'config', key, value)
  await mkdir(path.join(root, 'spec/ssot'), { recursive: true })
  await mkdir(path.join(root, 'spec/tasks/done'), { recursive: true })
  let state = await readFile(new URL('../../skills/gusta-create-architecture/assets/STATE.md', import.meta.url), 'utf8')
  state = state.replace('- level: ?', '- level: expert').replace('- lang: ?', '- lang: ko').replace('- push: ?', '- push: -')
  state = state.replace('## tasks', '| ARCH | 1 | 1 | - | 0 |\n\n## tasks')
  const rows = []
  for (let i = 1; i <= count; i++) {
    const id = `T${String(i).padStart(3, '0')}`
    rows.push(`| ${id} | example | ARCH | - | todo |`)
    await writeFile(path.join(root, `spec/tasks/${id}.example.md`), `# ${id} Example\n> st:todo | ssot:ARCH-1 | base:ARCH@1 | dep:- | touches:src/\n\n## goal\nFix example.\n\n## acceptance\n- [ ] Works with a regression test.\n\n## impl notes\n- -\n\n## result\n`)
  }
  state = state.replace('## next', `${rows.join('\n')}\n\n## next`)
  await writeFile(path.join(root, 'spec/STATE.md'), state)
  const arch = '# ARCH Architecture\n> r1 | Architecture\n\n## decisions\n- ARCH-1 [o] runtime: node\n- ARCH-2 [o] Verification runs in three tiers.\n  - task, before done: `node --version`.\n  - UI changes additionally run only affected Chromium specs.\n  - batch, before code push: `node --version`.\n  - CI, after push: GitHub Actions.\n\n## chg\n- r1 261019 initial\n'
  await writeFile(path.join(root, 'spec/ssot/ARCH.md'), arch)
  await writeFile(path.join(root, 'spec/FORMAT.md'), '# Legacy FORMAT\n')
  await mkdir(path.join(root, '.github/workflows'), { recursive: true })
  await writeFile(path.join(root, '.github/workflows/ci.yml'), 'on:\n  push:\n    branches: [main]\n')
  await git(root, 'add', '-A'); await git(root, 'commit', '-q', '-m', 'init')
  return { root, temporary, initial: await git(root, 'rev-parse', 'HEAD'), state, arch }
}

export const MACHINES_STATE = `# STATE
> state

## cfg
- level: expert
- lang: ko
- docs: en
- push: main

## ssot
| id | rev | tasked | pending | [?] |
|---|---|---|---|---|
| ARCH | 1 | 1 | - | 0 |

## tasks
| id | title | ssot | dep | st |
|---|---|---|---|---|
| T001 | first | ARCH | - | todo |
| T002 | second | ARCH | - | todo |

## next
- gusta-implement-task T001

## log
- 261012 gusta-create-task ARCH
`
const machineTask = (id, extra = '') => `# ${id} example\n> st:todo | ssot:ARCH-1 | base:ARCH@1 | dep:-${extra}\n\n## goal\nimplement ${id}\n\n## acceptance\n- [ ] works\n\n## impl notes\n- -\n\n## result\n`
export async function configure(root, temporary) {
  for (const [key, value] of [['user.name', 'Test'], ['user.email', 'test@example.com'], ['commit.gpgsign', 'false'], ['core.hooksPath', path.join(temporary, 'no-hooks')]]) await git(root, 'config', key, value)
}
// A bare remote and two clones: two machines working on one project (the test/vibe.test.mjs fixture).
export async function machines(t, { state = MACHINES_STATE } = {}) {
  const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), 'gusta-vibe-')))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const remote = path.join(temporary, 'remote.git')
  await execute('git', ['init', '-q', '--bare', '-b', 'main', remote])
  const a = path.join(temporary, 'machine a')
  await execute('git', ['init', '-q', '-b', 'main', a])
  await configure(a, temporary)
  await mkdir(path.join(a, 'spec/tasks'), { recursive: true })
  await mkdir(path.join(a, 'spec/ssot'), { recursive: true })
  await writeFile(path.join(a, 'spec/STATE.md'), state)
  await writeFile(path.join(a, 'spec/FORMAT.md'), '# FORMAT\n')
  await writeFile(path.join(a, 'spec/ssot/ARCH.md'), '# ARCH architecture\n> r1 | architecture\n\n## decisions\n- ARCH-1 [o] runtime: node\n\n## chg\n- r1 261012 initial\n')
  await writeFile(path.join(a, 'spec/tasks/T001.first.md'), machineTask('T001'))
  await writeFile(path.join(a, 'spec/tasks/T002.second.md'), machineTask('T002', ' | explore:2h').replace('- [ ] works', '- [ ] works\n- [ ] exit: record the measurement and finish'))
  await git(a, 'add', '-A'); await git(a, 'commit', '-q', '-m', 'spec')
  await git(a, 'remote', 'add', 'origin', remote)
  await git(a, 'push', '-q', 'origin', 'main')
  const b = path.join(temporary, 'machine b')
  await execute('git', ['clone', '-q', remote, b])
  await configure(b, temporary)
  return { temporary, remote, a, b }
}
