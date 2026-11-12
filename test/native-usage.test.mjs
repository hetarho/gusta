import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, appendFile, readFile, rm, symlink, access } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { scanNativeUsage, resolveNativeSession, nativeUsageReport, nativeUsageSummary, vibeUsage } from '../src/native-usage.mjs'
import { execute, fixture } from './helpers/vibe-fixture.mjs'
import { usageReportMarkdown, usageReportCompletion } from '../src/usage-report.mjs'

const marker = '0123456789abcdef0123456789abcdef'
const counts = (input = 2, output = 3, cacheRead = 5, cacheWrite = 7) => ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite })
const message = (root, id, usage = counts(), extra = {}) => ({ type: 'assistant', cwd: root, sessionId: 'session-a', message: { id, model: 'example-model', usage, content: [{ type: 'text', text: 'PRIVATE PROMPT MUST NOT PERSIST' }] }, ...extra })
async function logs(t) {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'gusta-native-usage-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  const root = path.join(temp, 'checkout'), projectDir = path.join(temp, 'project-logs'), commonDir = path.join(temp, 'git')
  await mkdir(projectDir)
  const file = path.join(projectDir, 'session-a.jsonl')
  const write = async (target, rows) => { await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, rows.map((row) => JSON.stringify(row)).join('\n') + '\n') }
  const deps = { readSetting: async () => true, inspectWorkspace: async () => ({ git: { root, commonDir } }) }
  return { root, projectDir, file, write, deps, commonDir }
}

test('native usage isolates the exact parent and nested children, deduplicating snapshots by message ID and field maxima', async (t) => {
  const f = await logs(t)
  await f.write(f.file, [message(f.root, 'one', counts(2, 3, 5, 7)), message(f.root, 'one', counts(1, 9, 4, 7)), message('/other-project', 'foreign', counts(999)), message(f.root, 'other-session', counts(999), { sessionId: 'session-b' })])
  await f.write(path.join(f.projectDir, 'session-b.jsonl'), [message(f.root, 'unrelated', counts(999), { sessionId: 'session-b' })])
  await f.write(path.join(f.projectDir, 'session-a/subagents/nested/agent-one.jsonl'), [message(f.root, 'child', counts(4, 6, 8, 10), { isSidechain: true, agentId: 'one' })])
  const snapshot = await scanNativeUsage({ ...f, session: 'session-a' })
  const report = nativeUsageReport(snapshot)
  assert.equal(report.status, 'recorded')
  assert.equal(report.messages, 2)
  assert.equal(report.sessions.nativeChildren, 1)
  assert.equal(report.tokens.input.known, 6)
  assert.equal(report.tokens.output.known, 15)
  assert.equal(report.tokens.cacheRead.known, 13)
  assert.equal(report.tokens.cacheWrite.known, 17)
  assert.equal(report.observedMaxProcessedInput, 22)
  assert.equal(report.cacheReadShare, 13 / 36)
  assert.equal(report.coverage.duplicateSnapshots, 1)
  assert.equal(report.coverage.excludedRecords, 2)
})

test('native proven child ownership includes worktree contexts and excludes inconsistent provider identities as partial', async (t) => {
  const f = await logs(t)
  await f.write(f.file, [message(f.root, 'parent')])
  const childFile = path.join(f.projectDir, 'session-a/subagents/agent-worker.jsonl')
  const child = message(path.join(f.root, 'other-worktree'), 'worktree-child', counts(11, 13, 17, 19), { isSidechain: true, agentId: 'worker' })
  await f.write(childFile, [child])
  // A different root-session log is never searched even when it claims this session ID.
  await f.write(path.join(f.projectDir, 'unrelated.jsonl'), [message(f.root, 'outside', counts(999))])
  const complete = nativeUsageReport(await scanNativeUsage({ ...f, session: 'session-a' }))
  assert.equal(complete.status, 'recorded')
  assert.equal(complete.messages, 2)
  assert.equal(complete.sessions.nativeChildren, 1)
  assert.equal(complete.tokens.input.known, 13)
  assert.equal(complete.coverage.unattributedChildRecords, 0)
  await appendFile(childFile, [
    { ...child, agentId: 'different' },
    { ...child, sessionId: 'session-b' },
    { ...child, isSidechain: false },
  ].map((row, index) => JSON.stringify({ ...row, message: { ...row.message, id: `unproven-${index}` } })).join('\n') + '\n')
  const partial = nativeUsageReport(await scanNativeUsage({ ...f, session: 'session-a' }))
  assert.equal(partial.status, 'partial')
  assert.equal(partial.messages, 2)
  assert.equal(partial.coverage.unattributedChildRecords, 3)
  assert.ok(partial.coverage.issues.includes('unproven-child-ownership'))
})

test('native marker attribution uses only literal tool-call commands and fails closed for concurrent collisions', async (t) => {
  const f = await logs(t)
  const invocation = message(f.root, 'call')
  invocation.message.content = [{ type: 'tool_use', name: 'Bash', input: { command: `gusta vibe usage start --tag AA --marker ${marker}` } }]
  await f.write(f.file, [message(f.root, 'quoted', counts(), { message: { content: [{ type: 'text', text: `vibe usage start --marker ${marker}` }] } }), invocation])
  await f.write(path.join(f.projectDir, 'session-b.jsonl'), [message(f.root, 'other', counts(), { sessionId: 'session-b' })])
  assert.equal((await resolveNativeSession({ ...f, marker })).session, 'session-a')
  await f.write(path.join(f.projectDir, 'session-b.jsonl'), [{ ...invocation, sessionId: 'session-b' }])
  assert.equal((await resolveNativeSession({ ...f, marker })).session, null)
  assert.ok((await resolveNativeSession({ ...f, marker })).issues.includes('ambiguous-session'))
  assert.equal((await resolveNativeSession({ ...f, marker: 'f'.repeat(32) })).session, null)
  await assert.rejects(resolveNativeSession({ ...f, session: '../session-a' }), /정확한/)
})

test('native baseline subtracts prior resumed history and writes only numeric/model/hash metadata', async (t) => {
  const f = await logs(t)
  await f.write(f.file, [message(f.root, 'historical', counts(100, 200, 300, 400)), message(f.root, 'in-flight')])
  const started = await vibeUsage({ step: 'start', tag: 'AA', session: 'session-a', projectDir: f.projectDir }, f.deps)
  assert.equal(started.started, true)
  await appendFile(f.file, `${JSON.stringify(message(f.root, 'in-flight', counts(2, 8, 5, 7)))}\n${JSON.stringify(message(f.root, 'new', counts(11, 13, 17, 19)))}\n`)
  const result = await vibeUsage({ step: 'report', tag: 'AA', projectDir: f.projectDir }, f.deps)
  assert.equal(result.report.boundary, 'baseline-delta')
  assert.equal(result.report.tokens.input.known, 11)
  assert.equal(result.report.tokens.output.known, 18)
  assert.equal(result.report.tokens.cacheRead.known, 17)
  assert.equal(result.report.tokens.cacheWrite.known, 19)
  assert.equal(result.report.messages, 2)
  assert.equal(result.report.observedMaxProcessedInput, 47)
  const artifact = await readFile(result.artifact, 'utf8'), baseline = await readFile(started.baseline, 'utf8'), markdown = await readFile(result.reportFile, 'utf8')
  assert.equal(result.reportFile, path.join(f.commonDir, 'gusta/v1/native-usage/AA.report.md'))
  assert.match(markdown, /Period: .* to .*report snapshot/)
  assert.match(markdown, /Baseline: baseline-delta; complete: true/)
  assert.match(markdown, /\| Input \(excluding cache read\) \| 11 \| 2 \/ 2 \|/)
  assert.match(markdown, /\| Output \| 18 \|/)
  assert.match(markdown, /claude\/example-model/)
  assert.match(markdown, /USD: unknown/)
  assert.ok(result.chatSummary.includes(result.reportLink))
  assert.equal(result.reportStatus, 'saved')
  assert.doesNotMatch(artifact + baseline + markdown, /PRIVATE PROMPT|session-a|historical|in-flight/)
  assert.match(result.summary, /later final reply/)
  const entire = await vibeUsage({ step: 'report', session: 'session-a', projectDir: f.projectDir }, f.deps)
  assert.equal(entire.report.boundary, 'entire-recorded-session')
  assert.equal(entire.report.tokens.input.known, 113)
})

test('native unknown, unfinished, missing and bounded logs never become complete zero usage', async (t) => {
  const f = await logs(t)
  await f.write(f.file, [message(f.root, 'unknown', { input_tokens: 0, output_tokens: 1 }), message(f.root, 'no-id', counts(), { message: { usage: counts() } })])
  await appendFile(f.file, '{"unfinished":')
  const snapshot = await scanNativeUsage({ ...f, session: 'session-a' })
  const report = nativeUsageReport(snapshot)
  assert.equal(report.status, 'partial')
  assert.equal(report.tokens.input.known, 0)
  assert.equal(report.tokens.cacheRead.reported, 0)
  assert.equal(report.cacheReadShare, null)
  assert.match(nativeUsageSummary(report), /cache-read 0\+unknown/)
  assert.ok(report.coverage.issues.includes('unfinished-record'))
  const bounded = await scanNativeUsage({ ...f, session: 'session-a', limits: { bytes: 10 } })
  assert.notEqual(nativeUsageReport(bounded).status, 'recorded')
  assert.ok(bounded.issues.includes('byte-limit'))
  const missing = await vibeUsage({ step: 'report', session: 'absent', projectDir: f.projectDir }, f.deps)
  assert.equal(missing.status, 'missing')
  assert.equal(missing.report.sessions.orchestrator, 0)
  assert.equal(missing.report.tokens.input.known, null)
  assert.match(await readFile(missing.reportFile, 'utf8'), /\| Input \(excluding cache read\) \| unknown \|/)
  assert.match(missing.summary, /input unknown/)
  const unavailable = await vibeUsage({ step: 'start', tag: 'AA', marker, projectDir: f.projectDir }, f.deps)
  assert.equal(unavailable.started, false)
  assert.match(unavailable.guidance, /same literal marker/)
})

test('native incomplete baseline cannot attribute unread history to new work; missing baseline records remain partial', async (t) => {
  const f = await logs(t)
  await f.write(f.file, [message(f.root, 'old')])
  const snapshot = await scanNativeUsage({ ...f, session: 'session-a' })
  const report = nativeUsageReport(snapshot, { messages: [], scanComplete: false })
  assert.equal(report.tokens.input.reported, 0)
  assert.equal(report.status, 'partial')
  const removed = nativeUsageReport({ ...snapshot, messages: [] }, { messages: snapshot.messages, scanComplete: true })
  assert.ok(removed.coverage.issues.includes('baseline-messages-missing'))
})

test('native symlink children cannot escape the attributed session directory', async (t) => {
  const f = await logs(t)
  await f.write(f.file, [message(f.root, 'parent')])
  const outside = path.join(f.projectDir, 'session-b/subagents/agent.jsonl')
  await f.write(outside, [message(f.root, 'outside', counts(999))])
  await mkdir(path.join(f.projectDir, 'session-a'))
  await symlink(path.dirname(outside), path.join(f.projectDir, 'session-a/subagents'))
  const report = nativeUsageReport(await scanNativeUsage({ ...f, session: 'session-a' }))
  assert.equal(report.messages, 1)
  assert.equal(report.status, 'partial')
})

test('native disabled command does no workspace/log reads or runtime writes', async (t) => {
  const f = await logs(t)
  const explode = async () => { throw new Error('must not inspect') }
  assert.deepEqual(await vibeUsage({ step: 'start' }, { readSetting: async () => false, inspectWorkspace: explode, resolveNativeSession: explode, scanNativeUsage: explode }), { schemaVersion: 1, ok: true, enabled: false })
  assert.deepEqual(await vibeUsage({ step: 'report' }, { readSetting: async () => false, inspectWorkspace: explode, writeFile: explode }), { schemaVersion: 1, ok: true, enabled: false })
  await assert.rejects(access(f.commonDir), { code: 'ENOENT' })
})

test('native report preserves numeric JSON when Markdown cannot be saved and reports a damaged baseline honestly', async (t) => {
  const f = await logs(t)
  await f.write(f.file, [message(f.root, 'one')])
  const result = await vibeUsage({ step: 'report', session: 'session-a', projectDir: f.projectDir }, { ...f.deps,
    writeFile: async (file, ...args) => { if (file.includes('.report.md.')) throw new Error('synthetic save failure'); return writeFile(file, ...args) } })
  assert.equal(result.report.tokens.output.known, 3)
  assert.equal(JSON.parse(await readFile(result.artifact, 'utf8')).tokens.output.known, 3)
  assert.equal(result.reportFile, null); assert.equal(result.reportLink, null)
  assert.deepEqual(result.reportErrors, ['markdown-write-failed'])
  assert.match(result.chatSummary, /report unavailable/)
  const baseline = path.join(f.commonDir, 'gusta/v1/native-usage/AA.baseline.json')
  await writeFile(baseline, '{damaged')
  const missing = await vibeUsage({ step: 'report', tag: 'AA', projectDir: f.projectDir }, f.deps)
  assert.equal(missing.status, 'missing')
  assert.match(await readFile(missing.reportFile, 'utf8'), /baseline-unreadable/)
  assert.equal(await readFile(baseline, 'utf8'), '{damaged')
})

test('native partial logs with no observed messages deliver unknown counters in Markdown and chat', () => {
  const report = nativeUsageReport({ messages: [], sessions: 1, duplicates: 0, excluded: 0, unidentified: 0, issues: ['unfinished-record'], scanComplete: false })
  const summary = nativeUsageSummary(report)
  assert.match(summary, /input unknown/)
  assert.match(usageReportMarkdown(report, summary), /\| Input \(excluding cache read\) \| unknown \| 0 \/ 0 \|/)
  assert.match(usageReportCompletion(report, summary, '/local/report.md').chatSummary, /input unknown, output unknown, cache read unknown, cache creation\/write unknown/)
})

test('native literal marker retries preserve their original baseline and reject unsafe tag/option combinations', async (t) => {
  const f = await logs(t)
  const invocation = message(f.root, 'call')
  invocation.message.content = [{ type: 'tool_use', name: 'Bash', input: { command: `gusta vibe usage start --tag AA --marker ${marker}` } }]
  await f.write(f.file, [invocation])
  const options = { step: 'start', tag: 'AA', marker, projectDir: f.projectDir }
  const first = await vibeUsage(options, f.deps)
  const before = await readFile(first.baseline, 'utf8')
  await appendFile(f.file, `${JSON.stringify(message(f.root, 'new'))}\n`)
  assert.equal((await vibeUsage(options, f.deps)).reused, true)
  assert.equal(await readFile(first.baseline, 'utf8'), before)
  const report = await vibeUsage({ step: 'report', tag: 'AA', projectDir: f.projectDir }, f.deps)
  assert.equal(report.report.messages, 1)
  await assert.rejects(vibeUsage({ step: 'report', tag: '../../outside', session: 'session-a' }, f.deps), /tag/)
  await assert.rejects(vibeUsage({ step: 'report', tag: 'AA', session: 'session-a' }, f.deps), /하나만/)
})

test('native active tag collisions preserve the first session; successful reports allow the next invocation', async (t) => {
  const f = await logs(t)
  await f.write(f.file, [message(f.root, 'one')])
  await f.write(path.join(f.projectDir, 'session-b.jsonl'), [message(f.root, 'two', counts(), { sessionId: 'session-b' })])
  const options = { step: 'start', tag: 'AA', session: 'session-a', projectDir: f.projectDir }
  const first = await vibeUsage(options, f.deps)
  const before = await readFile(first.baseline, 'utf8')
  const collision = await vibeUsage({ ...options, session: 'session-b' }, f.deps)
  assert.equal(collision.started, false)
  assert.equal(await readFile(first.baseline, 'utf8'), before)
  await appendFile(f.file, `${JSON.stringify(message(f.root, 'one', counts(2, 8, 5, 7)))}\n`)
  const result = await vibeUsage({ step: 'report', tag: 'AA', projectDir: f.projectDir }, f.deps)
  assert.equal(result.report.tokens.input.known, 0)
  assert.equal(result.report.observedMaxProcessedInput, 14)
  assert.equal((await vibeUsage({ ...options, session: 'session-b' }, f.deps)).started, true)
})

test('native concurrent starts cannot overwrite a tag while its first baseline is being collected', async (t) => {
  const f = await logs(t)
  await f.write(f.file, [message(f.root, 'one')])
  let entered, resume
  const ready = new Promise((resolve) => { entered = resolve })
  const blocked = new Promise((resolve) => { resume = resolve })
  const first = vibeUsage({ step: 'start', tag: 'AA', session: 'session-a', projectDir: f.projectDir }, { ...f.deps, scanNativeUsage: async (options) => { entered(); await blocked; return scanNativeUsage(options) } })
  await ready
  const other = await vibeUsage({ step: 'start', tag: 'AA', session: 'session-b', projectDir: f.projectDir }, f.deps)
  assert.equal(other.started, false)
  assert.match(other.summary, /locked/)
  resume()
  assert.equal((await first).started, true)
})

test('all orchestration entrypoints gate native baseline and completion reporting on the setting', async () => {
  for (const skill of ['gusta-start', 'gusta-manage-work', 'gusta-self-improve', 'gusta-self-improve-remote', 'gusta-showcase']) {
    const text = await readFile(new URL(`../skills/${skill}/SKILL.md`, import.meta.url), 'utf8')
    assert.match(text, /usage-measurement.*true.*시작 대화/, skill)
    assert.match(text, /references\/usage\.md/, skill)
    assert.match(text, /summary.*artifact/, skill)
    if (['gusta-start', 'gusta-self-improve', 'gusta-self-improve-remote'].includes(skill)) {
      assert.match(text, /Markdown.*최종.*채팅.*summary.*reportFile/, skill)
      assert.match(text, /할 일 없음·실패·주차/, skill)
    }
  }
  const reference = await readFile(new URL('../skills/gusta-start/references/usage.md', import.meta.url), 'utf8')
  assert.match(reference, /false.*실행하지 않는다/)
  assert.match(reference, /리터럴/)
  assert.match(reference, /최상위 호출만 마감/)
  assert.match(reference, /부모·자식 보고서는 합산하지 않는다/)
  assert.match(reference, /백그라운드\/인계.*부모가 종료까지 기다려.*채팅으로 전달/)
  assert.match(reference, /하위 워커는 부모 보고서를 만들지 않는다/)
  assert.match(reference, /저장 실패.*reportErrors/)
  const start = await readFile(new URL('../skills/gusta-start/SKILL.md', import.meta.url), 'utf8')
  assert.ok(start.indexOf('분기 전에 [사용량 기준선]') < start.indexOf('한 줄로 끝낸다'))
  assert.match(start, /조기 종료에도.*Markdown 보고·채팅 요약\/링크/)
})

test('vibe usage command routing and help expose exact-session reporting without activating default measurement', async (t) => {
  const { root } = await fixture(t, 0)
  const bin = new URL('../bin/gusta.mjs', import.meta.url).pathname
  const result = await execute(process.execPath, [bin, 'vibe', 'usage', 'report', '--target', root])
  assert.equal(JSON.parse(result.stdout).enabled, false)
  const help = await execute(process.execPath, [bin, 'vibe', '--help'])
  assert.match(help.stdout, /vibe usage start --tag/)
  assert.match(help.stdout, /vibe usage report/)
})
