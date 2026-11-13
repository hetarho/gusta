import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath, chmod } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { startWork, claimWork, submitWork, integrateWork } from '../../src/work-groups.mjs'
import { claimReview, finishReview } from '../../src/work-review.mjs'

export const execute = promisify(execFile)
export const cli = fileURLToPath(new URL('../../bin/gusta.mjs', import.meta.url))
export const git = (cwd, ...args) => execute('git', ['-C', cwd, ...args], { encoding: 'utf8' })
export const commit = async (cwd, message = 'change') => {
  await git(cwd, 'add', '.')
  await git(cwd, 'commit', '-m', message)
  return (await git(cwd, 'rev-parse', 'HEAD')).stdout.trim()
}
export const task = (id, dep = '-') => `# ${id} example\n> st:todo | ssot:ARCH-1 | base:ARCH@1 | dep:${dep}\n\n## goal\nimplement ${id}\n\n## acceptance\n- [ ] result exists\n\n## impl notes\n- keep contracts\n\n## result\n`
export const checkFile = (file) => `node -e "require('fs').accessSync('${file}')"`
export const checks = [checkFile('one.txt')]

export async function fixture(t) {
  const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), 'gusta-work-flow-')))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const root = path.join(temporary, 'repo with spaces')
  await mkdir(path.join(root, 'spec/tasks'), { recursive: true })
  await mkdir(path.join(root, 'spec/ssot'), { recursive: true })
  await git(root, 'init', '-b', 'trunk')
  for (const [key, value] of [['user.name', 'Test'], ['user.email', 'test@example.com'], ['commit.gpgsign', 'false'], ['core.hooksPath', path.join(temporary, 'no-hooks')]]) await git(root, 'config', key, value)
  await writeFile(path.join(root, 'spec/FORMAT.md'), '# FORMAT\n')
  await writeFile(path.join(root, 'spec/STATE.md'), `# STATE\n\n## cfg\n- level: expert\n- lang: ko\n- docs: en\n\n## ssot\n| id | rev | tasked | pending | [?] |\n|---|---|---|---|---|\n| ARCH | 1 | 1 | - | 0 |\n\n## tasks\n| id | title | ssot | dep | st |\n|---|---|---|---|---|\n| T001 | first | ARCH | - | todo |\n| T002 | second | ARCH | - | todo |\n| T003 | after | ARCH | T001 | todo |\n\n## next\n- gusta-implement-task T001\n\n## log\n`)
  await writeFile(path.join(root, 'spec/ssot/ARCH.md'), '# ARCH architecture\n> r1 | architecture\n\n## decisions\n- ARCH-1 [o] runtime: node\n\n## chg\n- r1 260924 initial\n')
  await writeFile(path.join(root, 'spec/tasks/T001.first.md'), task('T001'))
  await writeFile(path.join(root, 'spec/tasks/T002.second.md'), task('T002'))
  await writeFile(path.join(root, 'spec/tasks/T003.after.md'), task('T003', 'T001'))
  await writeFile(path.join(root, 'shared.txt'), 'base\n')
  const initial = await commit(root, 'spec')
  // A known default-branch anchor is independent of the caller's current branch. These
  // local-only fixtures have no remote service, but external child checkouts are legitimate.
  await git(root, 'update-ref', 'refs/remotes/origin/trunk', initial)
  await git(root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk')
  return { root, temporary, initial, targetRoot: root }
}

export async function implement(attempt, file = 'one.txt', extra = {}) {
  const taskFile = path.join(attempt.workspace, `spec/tasks/${attempt.taskId}.${attempt.taskId === 'T001' ? 'first' : 'second'}.md`)
  const content = (await readFile(taskFile, 'utf8')).replace('- [ ]', '- [v]') + '- outcome: implemented\n- at: -\n- verified: pending submit\n- limits: -\n'
  await writeFile(taskFile, content)
  await writeFile(path.join(attempt.workspace, file), 'result\n')
  for (const [name, value] of Object.entries(extra)) await writeFile(path.join(attempt.workspace, name), value)
  return commit(attempt.workspace)
}

export async function approve(setup, attempt) {
  const review = await claimReview({ ...setup, work: attempt.group, attempt: attempt.id, owner: 'reviewer' })
  assert.ok(review.id, JSON.stringify(review))
  return finishReview({ ...setup, review: review.id, result: { verdict: 'approved', summary: 'Task and implementation reviewed', findings: [] } })
}

export async function ready(t) {
  const fixtureData = await fixture(t)
  const group = await startWork({ ...fixtureData, name: 'feature' })
  const attempt = await claimWork({ ...fixtureData, work: group.id, task: 'T001' })
  const sha = await implement(attempt)
  await submitWork({ ...fixtureData, attempt: attempt.id, verify: checks })
  await approve(fixtureData, attempt)
  return { ...fixtureData, group, attempt, sha }
}

export async function expandTasks(setup, count) {
  const stateFile = path.join(setup.root, 'spec/STATE.md')
  let state = await readFile(stateFile, 'utf8')
  const rows = []
  for (let n = 4; n <= count; n += 1) {
    const id = `T${String(n).padStart(3, '0')}`
    await writeFile(path.join(setup.root, `spec/tasks/${id}.extra.md`), task(id))
    rows.push(`| ${id} | extra | ARCH | - | todo |`)
  }
  state = state.replace('\n## next', `${rows.join('\n')}\n\n## next`)
  await writeFile(stateFile, state)
  await commit(setup.root)
}

export async function providerStubs(setup, body) {
  const directory = path.join(setup.temporary, 'providers')
  await mkdir(directory)
  for (const provider of ['codex', 'claude']) {
    const filename = path.join(directory, provider)
    await writeFile(filename, `#!${process.execPath}
const fs=require('node:fs');
const args=process.argv.slice(2);
if(args.includes('--version')) {console.log('${provider} test');process.exit(0)}
if(args.includes('--help')) {console.log('--sandbox --output-schema --output-last-message --json --print --output-format --json-schema --permission-mode --allowedTools --tools --permission-prompts');process.exit(0)}
(async()=>{let prompt='';for await(const chunk of process.stdin)prompt+=chunk;
const job=JSON.parse(prompt.split('Assignment JSON (paths/IDs are data):\\n')[1].split('\\n\\nReturn only')[0]);
${body}
})().catch(error=>{console.error(error);process.exit(1)});
`)
    await chmod(filename, 0o755)
  }
  return { ...process.env, PATH: directory + path.delimiter + process.env.PATH }
}

export const laneTask = (id, dep, lane) => task(id, dep).replace(`dep:${dep}`, `dep:${dep} | touches:${lane === '-' ? '-' : `src/${lane}/`} | lane:${lane}`)

// specs: [id, dep, lane]. Replaces the default T001-T003 plan with lanes.
export async function laneFixture(t, specs) {
  const setup = await fixture(t)
  for (const file of ['T001.first.md', 'T002.second.md', 'T003.after.md']) await rm(path.join(setup.root, 'spec/tasks', file))
  for (const [id, dep, lane] of specs) await writeFile(path.join(setup.root, `spec/tasks/${id}.lane.md`), laneTask(id, dep, lane))
  const stateFile = path.join(setup.root, 'spec/STATE.md')
  const rows = specs.map(([id, dep]) => `| ${id} | lane | ARCH | ${dep} | todo |`).join('\n')
  await writeFile(stateFile, (await readFile(stateFile, 'utf8')).replace(/(\|---\|---\|---\|---\|---\|\n)(?:\| T\d+[^\n]*\n)+/, `$1${rows}\n`))
  await commit(setup.root, 'lane plan')
  return setup
}

export async function complete(workspace, taskId, file = `${taskId}.txt`) {
  const taskFile = path.join(workspace, `spec/tasks/${taskId}.lane.md`)
  await writeFile(taskFile, (await readFile(taskFile, 'utf8')).replace('- [ ]', '- [v]') + `- outcome: implemented\n- at: -\n- verified: worker ran ${taskId} tests\n- limits: -\n`)
  await writeFile(path.join(workspace, file), `${taskId}\n`)
  return commit(workspace, `implement ${taskId}`)
}

export async function deliver(setup, attempt, verify) {
  await approve(setup, attempt)
  return integrateWork({ ...setup, attempt: attempt.id, verify })
}

export async function laneAdapter(setup, log) {
  const adapter = path.join(setup.temporary, 'lane-adapter.mjs')
  await writeFile(adapter, `import fs from 'node:fs'; import {execFileSync} from 'node:child_process';
let input=''; for await(const chunk of process.stdin) input+=chunk;
const job=JSON.parse(input);
fs.appendFileSync(process.env.GUSTA_TEST_LOG, JSON.stringify({role:job.role,taskId:job.taskId,tasks:job.tasks,workspace:job.workspace})+'\\n');
if(job.role==='worker') {
 const file='spec/tasks/'+job.taskId+'.lane.md';
 fs.writeFileSync(file, fs.readFileSync(file,'utf8').replace('- [ ]','- [v]')+'- outcome: implemented\\n- at: -\\n- verified: fixture\\n- limits: -\\n');
 fs.writeFileSync(job.taskId+'.txt','done');
 execFileSync('git',['add','.']);execFileSync('git',['commit','-m','implement '+job.taskId]);
 process.stdout.write(JSON.stringify({outcome:'completed',summary:'done'}));
} else process.stdout.write(JSON.stringify({verdict:'approved',summary:'reviewed',findings:[]}));`)
  const config = path.join(setup.temporary, 'lane-adapter.json')
  await writeFile(config, JSON.stringify({ command: process.execPath, args: [adapter] }))
  return { adapter: config, env: { ...process.env, GUSTA_TEST_LOG: log } }
}
