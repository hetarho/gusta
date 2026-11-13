import test from 'node:test'
import { vibeLoop } from './helpers/unit-policy.mjs'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, realpath } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { usageCollector, usageRun, persistUsage, aggregateUsage, finishUsageRun } from '../src/usage-measurement.mjs'
import { executeAgentAdapter } from '../src/agent-adapter.mjs'
import { workScout } from '../src/work-scout.mjs'
import { vibeSettings, parseSettings } from '../src/settings.mjs'
import { fixture as loopFixture, archiveTask, git } from './helpers/vibe-fixture.mjs'
import { fixture as workFixture, checks } from './helpers/work-fixture.mjs'

import { startWork } from '../src/work-groups.mjs'
import { runWork, workRunStatus, workRunHost } from '../src/work-runner.mjs'
import { finishedSummary } from '../src/loop-control.mjs'

const usage = { input_tokens: 20, cache_creation_input_tokens: 10, cache_read_input_tokens: 70, output_tokens: 5 }
const events = (collector, ...values) => collector.push(values.map((value) => JSON.stringify(value)).join('\n') + '\n')
const assistant = (id, values = usage) => ({ type: 'assistant', message: { id, model: 'sample-model', usage: values, content: 'must never persist' } })
const terminal = (values = usage) => ({ type: 'result', subtype: 'success', usage: values, total_cost_usd: 0.125 })
const record = (invocation, session, measurement) => ({ schemaVersion: 1, invocation, session, provider: 'claude', requestedModel: null, role: 'worker', ...measurement })

test('Claude terminal totals replace duplicate message snapshots and nested usage; zero differs from unknown', () => {
  const collector = usageCollector('claude')
  events(collector, assistant('message-a'), assistant('message-a', { ...usage, output_tokens: 1 }), { ...assistant('nested'), parent_tool_use_id: 'nested-call' }, terminal())
  const result = collector.finish({ ok: true })
  assert.deepEqual(result.tokens, { input: 20, output: 5, cacheRead: 70, cacheWrite: 10, processedInput: 100 })
  assert.deepEqual(result.models, ['sample-model'])
  assert.equal(result.requests.observed, 1); assert.equal(result.requests.peakProcessedInput, 100)
  assert.equal(result.source, 'result.usage'); assert.equal(result.status, 'complete')
  const zero = usageCollector('claude')
  events(zero, terminal({ input_tokens: 0, output_tokens: 0 }))
  assert.deepEqual(zero.finish({ ok: true }).tokens, { input: 0, output: 0, cacheRead: null, cacheWrite: null, processedInput: null })
})

test('Claude interrupted fallback deduplicates by message ID using highest snapshots and excludes resumed cumulative USD', () => {
  const collector = usageCollector('claude')
  events(collector, assistant('a'), assistant('a', { ...usage, output_tokens: 1 }), assistant('b'))
  collector.push('{"incomplete":')
  const partial = collector.finish()
  assert.equal(partial.tokens.processedInput, 200); assert.equal(partial.tokens.output, null)
  assert.equal(partial.status, 'partial'); assert.equal(partial.malformed, true)
  const resumed = usageCollector('claude')
  events(resumed, terminal())
  const result = resumed.finish({ ok: true, resumed: true })
  assert.equal(result.reportedUsd, 0.125); assert.equal(result.usdScope, 'session-cumulative-unknown-baseline')
  assert.equal(aggregateUsage([record('a', 'session-a', result)]).reportedUsd.known, null)
})

test('Codex terminal turn usage wins over cumulative and last snapshots, cache-read is a subset of input', () => {
  const collector = usageCollector('codex')
  const total = (input) => ({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: 50, output_tokens: 10 }, last_token_usage: { input_tokens: 20, cached_input_tokens: 10, output_tokens: 1 } } } })
  const completed = { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 70, output_tokens: 5 } }
  events(collector, total(80), total(100), { type: 'turn.started' }, completed, completed)
  const result = collector.finish({ ok: true })
  assert.deepEqual(result.tokens, { input: 30, output: 5, cacheRead: 70, cacheWrite: null, processedInput: 100 })
  assert.equal(result.source, 'turn.completed')
  const cumulative = usageCollector('codex')
  events(cumulative, total(80), total(100))
  assert.equal(cumulative.finish().tokens.processedInput, 100)
  assert.equal(cumulative.finish({ resumed: true }).tokens.processedInput, null)
  const multi = usageCollector('codex')
  events(multi, { type: 'turn.started' }, completed, { type: 'turn.started' }, { ...completed, usage: { ...completed.usage, input_tokens: 140 } })
  assert.equal(multi.finish({ ok: true }).tokens.processedInput, 140)
  assert.equal(multi.finish({ ok: true, resumed: true }).tokens.processedInput, null)
})

test('failed result retains known provider counters and malformed/missing streams never fabricate zero', () => {
  const failed = usageCollector('claude')
  events(failed, { ...terminal(), is_error: true })
  assert.equal(failed.finish().tokens.output, 5); assert.equal(failed.finish().status, 'partial')
  const crash = usageCollector('claude')
  events(crash, assistant('a'), { type: 'result', subtype: 'error_during_execution', is_error: true, usage: Object.fromEntries(Object.keys(usage).map((key) => [key, 0])) })
  assert.equal(crash.finish().tokens.processedInput, 100); assert.equal(crash.finish().tokens.output, null)
  const budget = usageCollector('claude')
  events(budget, assistant('a'), { type: 'result', subtype: 'error_max_budget_usd', is_error: true, usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 } })
  assert.equal(budget.finish().tokens.processedInput, 100); assert.equal(budget.finish().tokens.output, 1)
  const missing = usageCollector('codex')
  missing.push('malformed\n')
  assert.equal(missing.finish().status, 'missing'); assert.equal(missing.finish().tokens.output, null)
  const malformed = usageCollector('claude')
  assert.doesNotThrow(() => events(malformed, { ...terminal(), subtype: 42 }))
  assert.equal(malformed.finish({ ok: true }).status, 'partial')
})

test('run aggregation counts sessions once, deduplicates invocation IDs and exposes incomplete denominator and model groups', () => {
  const collector = usageCollector('claude')
  events(collector, assistant('a'), terminal())
  const first = record('first', 'same-session', collector.finish({ ok: true }))
  const second = record('second', 'same-session', collector.finish({ ok: true, resumed: true }))
  const complete = aggregateUsage([first, first, second])
  assert.equal(complete.sessions, 1); assert.equal(complete.invocations, 2)
  assert.equal(complete.totals.processedInput.known, 200); assert.equal(complete.cacheReadShare, 0.7)
  assert.equal(complete.models[0].sessions, 1); assert.equal(complete.reportedUsd.known, 0.125)
  assert.equal(complete.reportedUsd.excludesCumulativeWithoutBaseline, 1)
  const incomplete = aggregateUsage([first], 2)
  assert.equal(incomplete.missingInvocations, 1); assert.equal(incomplete.cacheReadShare, null)
})

async function fixture(t, provider, body) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'gusta-usage-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(path.join(root, provider), `#!${process.execPath}\n${body}`, { mode: 0o755 })
  return { root, env: { ...process.env, PATH: root } }
}

test('disabled adapter preserves output and performs no measurement I/O; enabled worker/reviewer persist only counters and aliases', async (t) => {
  const fixtureData = await fixture(t, 'claude', `process.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({type:'system',model:'sample-model'}));console.log(JSON.stringify({type:'result',usage:${JSON.stringify(usage)},total_cost_usd:0.125,structured_output:{outcome:'completed',summary:'done',verdict:'approved',findings:[]}}));});`)
  const job = { role: 'worker', workspace: fixtureData.root, taskId: 'T001', attempt: 'synthetic-attempt' }
  const disabled = await executeAgentAdapter({ provider: 'claude', job, env: fixtureData.env, log: () => {}, measurementDeps: { mkdir: () => assert.fail('disabled collection') } })
  assert.deepEqual(Object.keys(disabled).sort(), ['decision', 'outcome', 'session', 'summary'])
  assert.equal(usageRun(false, fixtureData.root), null)
  const unexpected = () => assert.fail('disabled report must not perform I/O or send usage messaging')
  assert.equal(await finishUsageRun(null, 2, { readdir: unexpected, mkdir: unexpected, writeFile: unexpected, report: unexpected }), undefined)
  const run = usageRun(true, fixtureData.root, 'synthetic-run')
  for (const role of ['worker', 'reviewer']) {
    const result = await executeAgentAdapter({ provider: 'claude', job: { ...job, role, usageMeasurement: run }, env: fixtureData.env, log: () => {} })
    assert.equal(result.measurement.tokens.processedInput, 100)
    assert.notEqual(result.measurement.session, result.session)
  }
  let output = ''
  const report = await finishUsageRun(run, 2, { report: (line) => { output += line } })
  assert.match(output, /2 sessions.*2\/2 invocations/); assert.match(output, /cache read \/ processed input 70.0%/)
  assert.equal(report.totals.processedInput.known, 200)
  assert.equal(report.reportFile, path.join(run.directory, 'report.md'))
  assert.ok(report.chatSummary.includes(report.reportLink))
  const markdown = await readFile(report.reportFile, 'utf8')
  assert.match(markdown, /\| Input \(excluding cache read\) \| 40 \| 2 \/ 2 \|/)
  assert.match(markdown, /\| Cache creation\/write \| 20 \|/)
  assert.match(markdown, /USD: 0.25 \(2\/2 invocations reported\)/)
  assert.match(markdown, /Period: .* to .*report snapshot/)
  const serialized = (await Promise.all((await readdir(run.directory)).map((file) => readFile(path.join(run.directory, file), 'utf8')))).join('')
  assert.doesNotMatch(serialized, /synthetic-attempt|workspace|prompt|structured_output|session_id|must never persist/)
})

test('adapter unknown reports retain scope, escaped paths and honest save failure without hiding JSON or usage', async (t) => {
  const data = await fixture(t, 'claude', '')
  const run = usageRun(true, path.join(data.root, 'path with spaces'), 'unknown-run')
  const report = await finishUsageRun(run, 1, { report: () => {} })
  const markdown = await readFile(report.reportFile, 'utf8')
  assert.equal(report.status, 'partial')
  assert.match(markdown, /CLI shared adapter only/)
  assert.match(markdown, /0\/1 invocations; 1 missing/)
  assert.match(markdown, /\| Output \| unknown \| 0 \/ 1 \|/)
  assert.match(markdown, /USD: unknown/)
  assert.equal(report.reportLink, `[Usage report](<${report.reportFile}>)`)
  const failed = await finishUsageRun(run, 1, { report: () => {}, writeFile: async (file, ...args) => {
    if (file.includes('report.md.')) throw new Error('synthetic save failure')
    return writeFile(file, ...args)
  } })
  assert.equal(JSON.parse(await readFile(failed.report, 'utf8')).missingInvocations, 1)
  assert.equal(failed.reportFile, null); assert.equal(failed.reportLink, null)
  assert.equal(failed.reportStatus, 'unavailable')
  assert.deepEqual(failed.reportErrors, ['markdown-write-failed'])
  assert.match(failed.chatSummary, /report unavailable/)
  const jsonFailed = await finishUsageRun(run, 1, { report: () => {}, writeFile: async (file, ...args) => {
    if (file.includes('run.json.')) throw new Error('synthetic JSON save failure')
    return writeFile(file, ...args)
  } })
  assert.equal(jsonFailed.report, null)
  assert.equal(jsonFailed.reportStatus, 'partial')
  assert.deepEqual(jsonFailed.reportErrors, ['json-write-failed'])
  assert.ok(jsonFailed.chatSummary.includes(jsonFailed.reportLink))
  await readFile(jsonFailed.reportFile, 'utf8')
  const unreadable = await finishUsageRun(run, 1, { readdir: async () => { throw new Error('unreadable records') }, report: () => {} })
  assert.match(await readFile(unreadable.reportFile, 'utf8'), /unreadable-record-directory/)
})

test('Codex collection observes events beyond the session-ID buffer and failure streams survive in local records', async (t) => {
  const data = await fixture(t, 'codex', `const fs=require('node:fs');process.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({type:'thread.started',thread_id:'private-session-id'}));console.log(JSON.stringify({type:'item.completed',item:{text:'x'.repeat(70000)}}));console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:100,cached_input_tokens:75,output_tokens:8}}));const args=process.argv.slice(2);fs.writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify({outcome:'completed',summary:'done'}));});`)
  const run = usageRun(true, data.root)
  const result = await executeAgentAdapter({ provider: 'codex', job: { role: 'worker', workspace: data.root, attempt: 'synthetic-attempt', taskId: 'T001', usageMeasurement: run }, env: data.env, log: () => {} })
  assert.equal(result.measurement.tokens.processedInput, 100)
  assert.equal(result.measurement.tokens.cacheRead, 75); assert.equal(result.measurement.tokens.cacheWrite, null)
  const failure = await fixture(t, 'claude', `process.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify(${JSON.stringify(assistant('a'))}));process.exitCode=2;});`)
  const failedRun = usageRun(true, failure.root)
  await assert.rejects(executeAgentAdapter({ provider: 'claude', job: { role: 'reviewer', workspace: failure.root, attempt: 'synthetic-attempt', taskId: 'T001', usageMeasurement: failedRun }, env: failure.env, log: () => {} }), /실행 실패/)
  const report = await finishUsageRun(failedRun, 1, { report: () => {} })
  assert.equal(report.status, 'partial'); assert.equal(report.totals.processedInput.known, 100)
})

test('resumed Codex cumulative terminal totals become same-run deltas; missing baseline and reset are unknown', async (t) => {
  const data = await fixture(t, 'codex', '')
  const run = usageRun(true, data.root)
  const measure = (input, writes, resumed) => {
    const collector = usageCollector('codex')
    events(collector, { type: 'turn.completed', usage: { input_tokens: input, cached_input_tokens: input / 2, cache_write_input_tokens: writes, output_tokens: input / 10 } })
    return collector.finish({ ok: true, resumed })
  }
  const first = await persistUsage(run, measure(100, 20, false), { provider: 'codex', job: { role: 'worker' }, session: 'same-session' })
  const next = await persistUsage(run, measure(140, 25, true), { provider: 'codex', job: { role: 'worker', resume: 'same-session' }, session: 'same-session' })
  assert.equal(next.tokens.processedInput, 40); assert.equal(next.tokens.cacheWrite, 5)
  assert.equal(aggregateUsage([first, next]).totals.processedInput.known, 140)
  const reset = await persistUsage(run, measure(10, 1, true), { provider: 'codex', job: { role: 'worker', resume: 'same-session' }, session: 'same-session' })
  assert.equal(reset.tokens.processedInput, null)
  const unknown = await persistUsage(usageRun(true, data.root), measure(140, 25, true), { provider: 'codex', job: { role: 'worker', resume: 'same-session' }, session: 'same-session' })
  assert.equal(unknown.tokens.processedInput, null)
})

test('setting validates opt-in values and scout completion returns actual report plus visible summary', async (t) => {
  assert.match(parseSettings('# SETTINGS\n- usage-measurement: maybe\n').errors[0], /usage-measurement/)
  const data = await fixture(t, 'claude', `process.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({type:'result',usage:${JSON.stringify(usage)},structured_output:{summary:'scanned',proposals:[]}}));});`)
  await mkdir(path.join(data.root, 'spec'))
  await writeFile(path.join(data.root, 'prompt.txt'), 'Read a narrow source range.')
  await vibeSettings({ root: data.root, set: ['usage-measurement=true'] })
  const result = await workScout({ targetRoot: data.root, promptFile: path.join(data.root, 'prompt.txt'), provider: 'claude', env: data.env }, { inspect: async () => ({ providers: [{ provider: 'claude', compatible: true }], autoProvider: 'claude' }), flags: async () => [] })
  assert.match(result.measurement.summary, /1 sessions.*1\/1 invocations/)
  assert.equal(JSON.parse(await readFile(result.measurement.report, 'utf8')).totals.cacheRead.known, 70)
  let failure
  await assert.rejects(workScout({ targetRoot: data.root, promptFile: path.join(data.root, 'prompt.txt'), provider: 'claude', env: data.env }, {
    inspect: async () => ({ providers: [{ provider: 'claude', compatible: true }], autoProvider: 'claude' }), flags: async () => [],
    execute: async ({ job }) => {
      const collector = usageCollector('claude')
      events(collector, assistant('failed-scout'))
      await persistUsage(job.usageMeasurement, collector.finish(), { provider: 'claude', job, session: 'failed-scout' })
      throw new Error('synthetic scout failure')
    },
  }), (error) => { failure = error; return /synthetic scout failure/.test(error.message) })
  assert.equal(failure.measurement.status, 'partial')
  assert.ok(failure.details.includes(failure.measurement.chatSummary))
  assert.match(await readFile(failure.measurement.reportFile, 'utf8'), /\| Output \| unknown \|/)
})

test('enabled loop passes attribution to units and writes the aggregate into completion JSON, local manifest and owner report', async (t) => {
  const { root } = await loopFixture(t, 1)
  await vibeSettings({ root, set: ['usage-measurement=true'] })
  await git(root, 'add', 'spec/SETTINGS.md'); await git(root, 'commit', '-qm', 'enable measurement')
  const result = await vibeLoop({ targetRoot: root, tag: 'm060', provider: 'claude', maxUnits: 1 }, {
    preflight: async () => ({ ok: true, checks: [] }),
    execute: async (_options, job) => {
      assert.equal(job.taskId, 'T001'); assert.equal(job.unit, 1)
      const collector = usageCollector('claude')
      events(collector, assistant('a'), terminal())
      await persistUsage(job.usageMeasurement, collector.finish({ ok: true }), { provider: 'claude', job, session: 'synthetic-session' })
      await archiveTask(root, 'T001'); await git(root, 'add', 'spec'); await git(root, 'commit', '-qm', 'complete task')
      return { exitCode: 0, result: { kind: 'task', id: 'T001', outcome: 'completed', pushed: false, next: 'implementation' } }
    },
  })
  assert.equal(result.measurement.totals.processedInput.known, 100)
  const owner = await readFile(path.join(root, result.report), 'utf8')
  assert.match(owner, /- usage: Usage.*1 sessions/)
  assert.ok(owner.includes(result.measurement.reportLink))
  const manifest = JSON.parse(await readFile(result.manifest, 'utf8'))
  assert.equal(manifest.measurement.sessions, 1)
  assert.equal(finishedSummary(manifest).measurement.reportFile, result.measurement.reportFile)
  const status = await vibeLoop({ targetRoot: root, tag: 'm060', status: true })
  assert.equal(status.measurement.reportFile, result.measurement.reportFile)
})

test('enabled loop preflight failure and no-work exits return saved usage reports', async (t) => {
  const { root } = await loopFixture(t, 0)
  await vibeSettings({ root, set: ['usage-measurement=true'] })
  await git(root, 'add', 'spec/SETTINGS.md'); await git(root, 'commit', '-qm', 'enable measurement')
  const failed = await vibeLoop({ targetRoot: root, tag: 'm061', provider: 'claude' }, {
    preflight: async () => ({ ok: false, checks: [{ name: 'synthetic', ok: false, detail: 'unavailable' }] }),
  })
  assert.equal(failed.reason, 'failed')
  assert.equal(failed.measurement.invocations, 0)
  assert.match(await readFile(failed.measurement.reportFile, 'utf8'), /0\/0 invocations/)
  const noWork = await vibeLoop({ targetRoot: root, tag: 'm062', provider: 'claude' }, {
    preflight: async () => ({ ok: true, checks: [] }),
  })
  assert.equal(noWork.units, 0)
  assert.ok(noWork.measurement.reportFile)
  await readFile(noWork.measurement.reportFile, 'utf8')
})

test('enabled work run exposes unsupported custom adapter and interrupted coverage instead of zero tokens', async (t) => {
  const setup = await workFixture(t)
  await vibeSettings({ root: setup.targetRoot, set: ['usage-measurement=true'] })
  await git(setup.targetRoot, 'add', 'spec/SETTINGS.md'); await git(setup.targetRoot, 'commit', '-qm', 'enable measurement')
  const group = await startWork({ ...setup, name: 'measured-work' })
  const config = path.join(setup.temporary, 'usage-adapter.json')
  await writeFile(config, JSON.stringify({ command: process.execPath, args: ['-e', 'process.exit(3)'], maxDispatches: 1 }))
  const result = await runWork({ ...setup, work: group.id, adapter: config, verify: checks })
  assert.equal(result.measurement.status, 'partial')
  assert.ok(result.measurement.missingInvocations >= 1)
  assert.equal(result.measurement.totals.output.known, null)
  assert.match(result.measurement.summary, /output unknown/)
  await readFile(result.measurement.reportFile, 'utf8')
  const status = await workRunStatus({ ...setup, work: group.id })
  assert.equal(status.measurement.reportFile, result.measurement.reportFile)
  const files = path.join(setup.temporary, 'completed-run.config.json')
  const resultFile = path.join(setup.temporary, 'completed-run.json')
  await writeFile(files, JSON.stringify({ options: { runId: result.run, work: group.id }, result: resultFile }))
  await workRunHost(files, { runWork: async () => result })
  assert.equal(JSON.parse(await readFile(resultFile, 'utf8')).measurement.reportFile, result.measurement.reportFile)
})
