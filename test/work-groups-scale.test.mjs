import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { startWork, inspectWork, workHistory } from '../src/work-groups.mjs'
import { runWork } from '../src/work-runner.mjs'
import { git, checkFile, fixture, expandTasks, providerStubs } from './helpers/work-fixture.mjs'

test('30개 태스크를 6개 혼합 워커가 처리하고 실행 이력/STATE를 새 clone에도 보존한다', async (t) => {
  const setup = await fixture(t)
  await expandTasks(setup, 30)
  const group = await startWork({ ...setup, name: 'mixed-thirty', workers: 6, maxPending: 12 })
  const barrier = path.join(setup.temporary, 'first-wave')
  await mkdir(barrier)
  const env = await providerStubs(setup, `
if(job.role==='worker') {
 fs.writeFileSync(process.env.GUSTA_TEST_BARRIER+'/'+job.slot,job.provider);
 const started=Date.now();
 while(fs.readdirSync(process.env.GUSTA_TEST_BARRIER).length<6) {
  if(Date.now()-started>60000)throw Error('six workers did not start concurrently');
  await new Promise(resolve=>setTimeout(resolve,20));
 }
 const file='spec/tasks/'+fs.readdirSync('spec/tasks').find(name=>name.startsWith(job.taskId+'.'));
 let text=fs.readFileSync(file,'utf8').replace('- [ ]','- [v]');
 fs.writeFileSync(file,text.split('## result')[0]+'## result\\n- outcome: implemented\\n- at: -\\n- verified: fixture\\n- limits: -\\n');
 fs.writeFileSync(job.taskId+'.txt',job.provider);
}
const result=job.role==='worker'?{outcome:'completed',summary:job.provider+' implemented '+job.taskId}:{verdict:'approved',summary:'reviewed',findings:[]};
if(args.includes('--output-last-message'))fs.writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify(result));
else console.log(JSON.stringify({type:'result',is_error:false,structured_output:result}));
`)
  env.GUSTA_TEST_BARRIER = barrier
  const result = await runWork({ ...setup, work: group.id, providers: 'codex,claude', env, verify: [checkFile('spec/ssot/ARCH.md')] })
  assert.equal(result.outcome, 'completed', JSON.stringify(result))
  assert.deepEqual(result.failures, [])
  assert.equal(result.snapshotError, null)
  assert.equal(result.summary.completed, 30)
  assert.equal(result.summary.remaining, 0)
  const { history } = await workHistory({ ...setup, work: group.id })
  const launches = history.filter((event) => event.changes.dispatch?.role === 'worker' && event.changes.dispatch.status === 'starting')
  assert.equal(launches.length, 30)
  assert.equal(new Set(launches.map((event) => event.taskId)).size, 30)
  assert.deepEqual([...new Set(launches.map((event) => event.changes.dispatch.slot))].sort(), [1, 2, 3, 4, 5, 6])
  assert.ok(launches.every((event) => event.changes.dispatch.provider === (event.changes.dispatch.slot % 2 ? 'codex' : 'claude')))
  const busy = new Set()
  let peak = 0
  for (const event of history.filter((event) => event.type === 'attempt')) {
    if (['preparing', 'doing', 'committing', 'verifying'].includes(event.status)) busy.add(event.attemptId)
    else busy.delete(event.attemptId)
    peak = Math.max(peak, busy.size)
  }
  assert.equal(peak, 6)
  const clone = path.join(setup.temporary, 'fresh-clone')
  await git(setup.root, 'clone', '--branch', group.branch, setup.root, clone)
  const saved = JSON.parse(await readFile(path.join(clone, 'spec/work/mixed-thirty.json'), 'utf8'))
  assert.deepEqual(saved.summary, result.summary)
  assert.ok(saved.attempts.every((entry) => entry.status === 'integrated' && entry.integratedCommit))
  // The runner pruned every unit before saving (prune-branches): cleaning → integrated is not an integration.
  assert.equal(result.pruned.cleaned.length, 30)
  assert.equal(saved.history.filter((event) => event.status === 'integrated' && !['integrated', 'cleaning'].includes(event.previousStatus)).length, 30)
  assert.equal(saved.group.lastRun.outcome, 'completed')
  const state = await readFile(path.join(clone, 'spec/STATE.md'), 'utf8')
  assert.match(state, /\| mixed-thirty \| 6 \| 30 \| 30 \| 0 \| 0 \| 0 \| 0 \|/)
  assert.ok(!state.includes('| T001 |'))
  assert.equal((await inspectWork({ targetRoot: clone })).attempts.length, 0)
  const portable = await workHistory({ targetRoot: clone, work: group.id, task: 'T001' })
  assert.equal(portable.scope, 'snapshot')
  assert.ok(portable.history.every((entry) => entry.taskId === 'T001'))
  assert.ok(portable.history.some((entry) => entry.status === 'integrated'))
})
