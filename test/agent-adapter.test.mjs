import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, rm, readFile, realpath } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { executeAgentAdapter, claudeResult, claudeEnvelope, providerArguments, skillBody } from '../src/agent-adapter.mjs'
import { builtInAdapter, inspectProviders, inspectOrca, providerFlags } from '../src/work-providers.mjs'

async function stub(t, name, body) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'haeram-provider-test-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(path.join(root, name), `#!${process.execPath}\n${body}`, { mode: 0o755 })
  return { root, env: { ...process.env, PATH: root } }
}
const job = (workspace, role = 'worker') => ({ schemaVersion: 1, role, workspace, attempt: 'attempt-test', taskId: 'T001' })
const flag = (args, key) => args[args.indexOf(key) + 1]

test('Codex는 최종 결과 파일만 해석하고 진행 JSONL은 로그로 보낸다', async (t) => {
  const fixture = await stub(t, 'codex', `const fs=require('node:fs'); const args=process.argv.slice(2);let text='';process.stdin.on('data',chunk=>text+=chunk);process.stdin.on('end',()=>{fs.writeFileSync('received.json',JSON.stringify({args,text}));fs.writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify({outcome:'completed',summary:'done'}));console.log(JSON.stringify({type:'item.completed',item:{text:'not the final JSON'}}));});`)
  let log = ''
  const result = await executeAgentAdapter({ provider: 'codex', job: job(fixture.root), env: fixture.env, log: (text) => { log += text } })
  assert.equal(result.outcome, 'completed')
  assert.match(log, /item.completed/)
  const received = JSON.parse(await readFile(path.join(fixture.root, 'received.json'), 'utf8'))
  assert.equal(flag(received.args, '--sandbox'), 'workspace-write')
  assert.match(received.text, /host runner validates scope, commits/)
  assert.match(received.text, /# implement-task/)
  assert.ok(!received.args.some((item) => item.includes('dangerously')))
})

test('Claude의 structured_output을 해석하고 오류/구조 누락을 성공으로 취급하지 않는다', () => {
  const result = { verdict: 'approved', summary: 'reviewed', findings: [] }
  assert.deepEqual(claudeResult(JSON.stringify({ type: 'result', is_error: false, structured_output: result }), 'reviewer'), result)
  assert.throws(() => claudeResult(JSON.stringify({ is_error: true, structured_output: result }), 'reviewer'), /실행 실패/)
  assert.throws(() => claudeResult(JSON.stringify({ result: JSON.stringify(result) }), 'reviewer'), /structured_output/)
  assert.throws(() => claudeResult(JSON.stringify({ structured_output: { ...result, findings: [{ priority: 'P0' }] } }), 'reviewer'), /finding/)
})

test('Claude stream-json은 마지막 최상위 result 이벤트만 결과로 읽는다', () => {
  const result = { verdict: 'approved', summary: 'reviewed', findings: [] }
  const lines = (...events) => events.map((event) => JSON.stringify(event)).join('\n')
  const init = { type: 'system', subtype: 'init', session_id: 's' }
  // A nested object typed "result" (a tool result, a quoted event) is not the session's answer.
  const nested = { type: 'user', message: { content: [{ type: 'result', structured_output: { verdict: 'nope' } }] } }
  const stream = lines(init, { type: 'assistant', message: { content: [] } }, { type: 'result', subtype: 'success', is_error: false, usage: { output_tokens: 3 }, structured_output: result }, nested)
  assert.deepEqual(claudeResult(`${stream}\n`, 'reviewer'), result)
  assert.equal(claudeEnvelope(stream).usage.output_tokens, 3)
  assert.throws(() => claudeResult(lines(init, { type: 'result', subtype: 'error_max_turns', is_error: true }), 'reviewer'), /실행 실패: error_max_turns/)
  assert.throws(() => claudeResult(lines(init, nested), 'reviewer'), /result 이벤트가 없습니다/)
  // Exit 0 without a result event: the last event is not mistaken for an envelope lacking a schema.
  for (const ended of [lines(init, { type: 'assistant', message: { content: [] } }), JSON.stringify({ type: 'assistant', message: { content: [] } })]) assert.throws(() => claudeResult(ended, 'reviewer'), /result 이벤트가 없습니다/)
  assert.deepEqual(claudeResult(JSON.stringify({ structured_output: result }), 'reviewer'), result)
  const args = providerArguments('claude', 'reviewer', { schema: 'schema', result: 'result' })
  assert.equal(flag(args, '--output-format'), 'stream-json'); assert.ok(args.includes('--verbose'))
})

test('Claude 이벤트는 프로세스가 끝나기 전에 로그로 흐르고 결과·사용량은 result 이벤트에서 읽는다', async (t) => {
  const unit = { kind: 'task', id: 'T001', outcome: 'completed', pushed: false, next: 'implementation' }
  // The provider answers only after the host has logged its first event, so a buffered log deadlocks (exit 3).
  const fixture = await stub(t, 'claude', `const fs=require('node:fs');process.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({type:'system',subtype:'init',session_id:'s'}));const started=Date.now();const wait=()=>{if(fs.existsSync('release'))console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,usage:{output_tokens:5},structured_output:${JSON.stringify(unit)}}));else if(Date.now()-started>5000)process.exit(3);else setTimeout(wait,10)};wait();});`)
  let log = ''
  const result = await executeAgentAdapter({ provider: 'claude', job: { role: 'unit', workspace: fixture.root }, env: fixture.env,
    log: (text) => { log += text; if (log.includes('"subtype":"init"')) writeFileSync(path.join(fixture.root, 'release'), 'go') } })
  assert.equal(result.id, 'T001'); assert.equal(result.usage.output_tokens, 5)
  assert.match(log, /"type":"result"/)
})

test('리뷰어는 읽기 정책으로 실행하며 모델 이름은 해석 없이 전달한다', async (t) => {
  const fixture = await stub(t, 'claude', `const fs=require('node:fs');let text='';process.stdin.on('data',chunk=>text+=chunk);process.stdin.on('end',()=>{fs.writeFileSync('received.json',JSON.stringify({args:process.argv.slice(2),text}));console.log(JSON.stringify({type:'result',is_error:false,structured_output:{verdict:'approved',summary:'reviewed',findings:[]}}));});`)
  await executeAgentAdapter({ provider: 'claude', model: 'model with spaces', job: job(fixture.root, 'reviewer'), env: fixture.env, log: () => {} })
  const { args, text } = JSON.parse(await readFile(path.join(fixture.root, 'received.json'), 'utf8'))
  assert.equal(flag(args, '--permission-mode'), 'plan')
  assert.equal(flag(args, '--permission-prompts'), 'none')
  assert.equal(flag(args, '--model'), 'model with spaces')
  assert.ok(!flag(args, '--tools').includes('Edit'))
  assert.match(text, /# review-task/)
  assert.equal(flag(providerArguments('codex', 'reviewer', { schema: 'schema', result: 'result' }), '--sandbox'), 'read-only')
})

test('CLI 검사와 auto 선택은 모델을 호출하지 않고 필수 flag 지원을 확인한다', async (t) => {
  const fixture = await stub(t, 'codex', `const fs=require('node:fs');const args=process.argv.slice(2);if(args.includes('--version'))console.log('codex-test');else if(args.includes('--help'))console.log('--sandbox --output-schema --output-last-message --json');else {fs.writeFileSync('model-request','unexpected');process.exit(4);}`)
  const info = await inspectProviders({ targetRoot: fixture.root, env: fixture.env })
  assert.equal(info.autoProvider, 'codex')
  assert.equal(info.providers.find((entry) => entry.provider === 'claude').available, false)
  const config = await builtInAdapter({ targetRoot: fixture.root, env: fixture.env, provider: 'auto', model: 'chosen', reviewerModel: 'review-model' })
  assert.equal(config.roles.worker.provider, 'codex')
  assert.equal(config.roles.reviewer.model, 'review-model')
  await assert.rejects(readFile(path.join(fixture.root, 'model-request')), { code: 'ENOENT' })
  await assert.rejects(builtInAdapter({ targetRoot: fixture.root, env: fixture.env, provider: 'claude' }), /사용 가능한/)
  await writeFile(path.join(fixture.root, 'codex'), `#!${process.execPath}\nconsole.log('old cli')`, { mode: 0o755 })
  assert.equal((await inspectProviders({ targetRoot: fixture.root, env: fixture.env })).autoProvider, null)
})

test('Orca 실행 파일의 실제 경로가 주어지면 PATH 등록 없이 runtime을 감지한다', async (t) => {
  const fixture = await stub(t, 'orca-bundled', `if(process.argv.includes('--version'))console.log('1.4.test');else console.log(JSON.stringify({ok:true,result:{runtime:{reachable:true,capabilities:['orchestration.contract.v1','unrelated']}}}));`)
  const info = await inspectOrca({ targetRoot: fixture.root, env: fixture.env, orcaCommand: path.join(fixture.root, 'orca-bundled') })
  assert.equal(info.reachable, true)
  assert.equal(info.onPath, false)
  assert.deepEqual(info.capabilities, ['orchestration.contract.v1'])
})

test('오류 코드가 있으면 남아 있는 결과 파일로 성공을 만들지 않는다', async (t) => {
  const fixture = await stub(t, 'codex', `const fs=require('node:fs');const args=process.argv;fs.writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify({outcome:'completed',summary:'stale'}));process.exit(7);`)
  await assert.rejects(executeAgentAdapter({ provider: 'codex', job: job(fixture.root), env: fixture.env, log: () => {} }), /실행 실패/)
})

test('단일/혼합 워커와 모델별 설정을 지원하고 모호한 설정은 실행 전에 거부한다', async (t) => {
  const fixture = await stub(t, 'codex', `if(process.argv.includes('--version'))console.log('test');else console.log('--sandbox --output-schema --output-last-message --json');`)
  await writeFile(path.join(fixture.root, 'claude'), `#!${process.execPath}\nif(process.argv.includes('--version'))console.log('test');else console.log('--print --output-format --json-schema --permission-mode --allowedTools --tools --permission-prompts');`, { mode: 0o755 })
  const options = { targetRoot: fixture.root, env: fixture.env }
  const mixed = await builtInAdapter({ ...options, providers: 'codex,claude,claude' })
  assert.deepEqual(mixed.workers.map((entry) => entry.provider), ['codex', 'claude', 'claude'])
  assert.equal(mixed.roles.reviewer.provider, 'codex')
  const individual = await builtInAdapter({ ...options, provider: 'claude', model: 'claude-model' })
  assert.equal(individual.workers[0].provider, 'claude')
  assert.equal(individual.roles.reviewer.model, 'claude-model')
  const configured = await builtInAdapter({ ...options, workers: [{ provider: 'claude', model: 'claude-model' }, { provider: 'codex', model: 'codex-model' }], reviewerProvider: 'codex' })
  assert.deepEqual(configured.workers.map((entry) => entry.model), ['claude-model', 'codex-model'])
  assert.equal(configured.roles.reviewer.model, null)
  for (const invalid of [{ providers: '' }, { providers: 'claude,unknown' }, { providers: 'codex,claude', provider: 'codex' }, { providers: 'codex,claude', model: 'ambiguous' }, { workers: [] }, { workers: [{ provider: 'codex', model: '' }] }]) {
    await assert.rejects(builtInAdapter({ ...options, ...invalid }))
  }
})

const SHARED_PROMPT = '--exclude-dynamic-system-prompt-sections'
// A Claude CLI that counts --help calls and records each session's arguments next to itself.
const claudeCli = (help) => `const fs=require('node:fs'),path=require('node:path');const args=process.argv.slice(2);const here=(name)=>path.join(__dirname,name);
if(args.includes('--version'))console.log('claude-test');
else if(args.includes('--help')){fs.appendFileSync(here('help-calls'),'x');console.log(${JSON.stringify(`--print --output-format --json-schema --permission-mode --allowedTools --tools --permission-prompts ${help}`)})}
else{process.stdin.resume();process.stdin.on('end',()=>{fs.writeFileSync(here('received.json'),JSON.stringify(args));console.log(JSON.stringify({type:'result',is_error:false,structured_output:{verdict:'approved',summary:'reviewed',findings:[]}}))})}`
const helpCalls = (root) => readFile(path.join(root, 'help-calls'), 'utf8').then((text) => text.length, () => 0)

test('설치된 Claude CLI가 지원하면 헤드리스 세션에 동적 시스템 프롬프트 제외 flag를 붙이고, 검사한 프로세스는 다시 묻지 않는다', async (t) => {
  const fixture = await stub(t, 'claude', claudeCli(`${SHARED_PROMPT}  Move per-machine sections`))
  const info = await inspectProviders({ targetRoot: fixture.root, env: fixture.env })
  assert.deepEqual(info.providers.find((entry) => entry.provider === 'claude').extraFlags, [SHARED_PROMPT])
  const config = await builtInAdapter({ targetRoot: fixture.root, env: fixture.env, provider: 'claude' })
  for (const role of ['worker', 'reviewer']) assert.equal(flag(config.roles[role].args, '--provider-flag'), SHARED_PROMPT)
  const probed = await helpCalls(fixture.root)
  // Inspection already answered: the cached probe does not ask --help again.
  const flags = await providerFlags('claude', { env: fixture.env })
  assert.deepEqual(flags, [SHARED_PROMPT])
  assert.equal(await helpCalls(fixture.root), probed)
  await executeAgentAdapter({ provider: 'claude', job: job(fixture.root, 'reviewer'), env: fixture.env, log: () => {}, flags })
  assert.ok(JSON.parse(await readFile(path.join(fixture.root, 'received.json'), 'utf8')).includes(SHARED_PROMPT))
  // Without flags from its caller a session gets none; only known optional flags reach Claude and Codex gets none.
  await executeAgentAdapter({ provider: 'claude', job: job(fixture.root, 'reviewer'), env: fixture.env, log: () => {} })
  assert.ok(!JSON.parse(await readFile(path.join(fixture.root, 'received.json'), 'utf8')).includes(SHARED_PROMPT))
  const files = { schema: 'schema', result: 'result' }
  const unitArgs = providerArguments('claude', 'unit', files, null, { flags: [SHARED_PROMPT, '--dangerous'] })
  assert.ok(unitArgs.includes(SHARED_PROMPT)); assert.ok(!unitArgs.includes('--dangerous'))
  for (const role of ['variant', 'scaffold']) assert.ok(providerArguments('claude', role, files, null, { flags: [SHARED_PROMPT] }).includes(SHARED_PROMPT), role)
  assert.ok(!providerArguments('codex', 'worker', files, null, { flags: [SHARED_PROMPT] }).includes(SHARED_PROMPT))
})

test('--help에 없는 선택 flag는 붙이지 않고, 검사 없는 경로는 프로세스당 한 번만 묻는다', async (t) => {
  const fixture = await stub(t, 'claude', claudeCli(''))
  await executeAgentAdapter({ provider: 'claude', job: job(fixture.root, 'reviewer'), env: fixture.env, log: () => {} })
  assert.ok(!JSON.parse(await readFile(path.join(fixture.root, 'received.json'), 'utf8')).includes(SHARED_PROMPT))
  assert.equal(await helpCalls(fixture.root), 0, 'a session never starts its own probe')
  assert.deepEqual(await providerFlags('claude', { env: fixture.env }), [])
  assert.deepEqual(await providerFlags('claude', { env: fixture.env }), [])
  assert.equal(await helpCalls(fixture.root), 1)
  const config = await builtInAdapter({ targetRoot: fixture.root, env: fixture.env, provider: 'claude' })
  assert.ok(!config.roles.worker.args.includes('--provider-flag'))
  // Injected probe: cached per PATH, a failure (async or a synchronous spawn error) means no flag, Codex is never asked.
  let runs = 0
  const run = async () => { runs++; return { stdout: `--print ${SHARED_PROMPT}` } }
  const env = { PATH: path.join(fixture.root, 'injected') }
  assert.deepEqual(await providerFlags('claude', { env, run }), [SHARED_PROMPT])
  assert.deepEqual(await providerFlags('claude', { env, run }), [SHARED_PROMPT])
  assert.equal(runs, 1)
  assert.deepEqual(await providerFlags('claude', { env: { PATH: path.join(fixture.root, 'broken') }, run: async () => { throw new Error('old cli') } }), [])
  assert.deepEqual(await providerFlags('claude', { env: { PATH: path.join(fixture.root, 'unspawnable') }, run: () => { throw new Error('spawn EACCES') } }), [])
  assert.deepEqual(await providerFlags('codex', { env, run: () => assert.fail('codex has no optional flags') }), [])
})

const STRICT_MCP = '--strict-mcp-config'
const sentArgs = async (root) => JSON.parse(await readFile(path.join(root, 'received.json'), 'utf8'))

test('헤드리스 Claude 세션은 MCP 서버를 하나도 싣지 않는다 — 사용자·계정 서버도 checkout의 .mcp.json도 (headless-mcp)', async (t) => {
  const files = { schema: 'schema', result: 'result' }
  // Isolated by default for every role: the strict flag and never an --mcp-config.
  for (const role of ['unit', 'worker', 'reviewer', 'scout', 'variant', 'scaffold']) {
    const args = providerArguments('claude', role, files, null, { flags: [SHARED_PROMPT, STRICT_MCP] })
    assert.deepEqual(args.slice(-2), [SHARED_PROMPT, STRICT_MCP], role); assert.ok(!args.includes('--mcp-config'), role)
  }
  // inherit keeps the user's setup; an older CLI without the flag gets none; Codex gets none.
  const inherit = providerArguments('claude', 'unit', files, null, { flags: [SHARED_PROMPT, STRICT_MCP], headlessMcp: 'inherit' })
  assert.ok(inherit.includes(SHARED_PROMPT)); assert.ok(!inherit.includes(STRICT_MCP)); assert.ok(!inherit.includes('--mcp-config'))
  assert.ok(!providerArguments('claude', 'unit', files, null, { flags: [] }).some((arg) => arg.includes('mcp')))
  assert.ok(!providerArguments('codex', 'worker', files, null, { flags: [STRICT_MCP] }).some((arg) => arg.includes('mcp')))
  assert.throws(() => providerArguments('claude', 'unit', files, null, { flags: [STRICT_MCP], headlessMcp: 'all' }), /headless-mcp/)

  // A CLI that lists the flag: detected like the other optional flags, sent per the job's headlessMcp.
  const fixture = await stub(t, 'claude', claudeCli(`${STRICT_MCP}  Only use MCP servers from --mcp-config`))
  const flags = await providerFlags('claude', { env: fixture.env })
  assert.deepEqual(flags, [STRICT_MCP])
  await executeAgentAdapter({ provider: 'claude', job: job(fixture.root, 'reviewer'), env: fixture.env, log: () => {}, flags })
  let args = await sentArgs(fixture.root)
  assert.ok(args.includes(STRICT_MCP)); assert.ok(!args.includes('--mcp-config'))
  // A committed .mcp.json is code a worker can write: an isolated session (here the reviewer) never loads it.
  await writeFile(path.join(fixture.root, '.mcp.json'), '{"mcpServers":{}}')
  await executeAgentAdapter({ provider: 'claude', job: { ...job(fixture.root, 'reviewer'), headlessMcp: 'isolate' }, env: fixture.env, log: () => {}, flags })
  args = await sentArgs(fixture.root)
  assert.ok(args.includes(STRICT_MCP)); assert.ok(!args.includes('--mcp-config')); assert.ok(!args.some((arg) => arg.includes('.mcp.json')))
  await executeAgentAdapter({ provider: 'claude', job: { ...job(fixture.root, 'reviewer'), headlessMcp: 'inherit' }, env: fixture.env, log: () => {}, flags })
  args = await sentArgs(fixture.root)
  assert.ok(!args.includes(STRICT_MCP)); assert.ok(!args.includes('--mcp-config'))
  await executeAgentAdapter({ provider: 'claude', job: job(fixture.root, 'reviewer'), env: fixture.env, log: () => {} })
  assert.ok(!(await sentArgs(fixture.root)).some((arg) => arg.includes('mcp')), 'no flags from the caller, no MCP flag')

  // work scout reads the setting from its checkout.
  const { workScout } = await import('../src/work-scout.mjs')
  const promptFile = path.join(fixture.root, 'prompt.md')
  await writeFile(promptFile, 'Assigned area: src/')
  let seen
  const scout = { inspect: async () => ({ autoProvider: 'claude', providers: [{ provider: 'claude', compatible: true }] }), flags: async () => [STRICT_MCP],
    execute: async (input) => { seen = input; return { summary: 'none', proposals: [] } } }
  await workScout({ promptFile, targetRoot: fixture.root }, scout)
  assert.equal(seen.job.headlessMcp, 'isolate')
  await mkdir(path.join(fixture.root, 'spec'))
  await writeFile(path.join(fixture.root, 'spec/SETTINGS.md'), '# SETTINGS\n- headless-mcp: inherit\n')
  await workScout({ promptFile, targetRoot: fixture.root }, scout)
  assert.equal(seen.job.headlessMcp, 'inherit')
})

test('워커는 결정 요청을 돌려줄 수 있고, 세션 ID를 미리 정해 파일에 남긴 뒤 다음 실행에서 이어 쓴다', async (t) => {
  const fixture = await stub(t, 'claude', `const fs=require('node:fs');let text='';process.stdin.on('data',chunk=>text+=chunk);process.stdin.on('end',()=>{fs.appendFileSync('calls.jsonl',JSON.stringify({args:process.argv.slice(2),text})+'\\n');console.log(JSON.stringify({type:'result',is_error:false,session_id:'ignored',structured_output:{outcome:'blocked',summary:'needs a policy',decision:{question:'Cap per user?',options:['10','unlimited'],recommendation:'10'}}}));});`)
  const sessionFile = path.join(fixture.root, 'session.txt')
  const first = await executeAgentAdapter({ provider: 'claude', job: { ...job(fixture.root), mode: 'autopilot', sessionFile, allowTools: ['Bash(npm test *)'], brief: { tasks: [] } }, env: fixture.env, log: () => {} })
  assert.deepEqual(first.decision, { question: 'Cap per user?', options: ['10', 'unlimited'], recommendation: '10' })
  const session = await readFile(sessionFile, 'utf8')
  assert.equal(first.session, session)
  const [call] = (await readFile(path.join(fixture.root, 'calls.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
  assert.equal(flag(call.args, '--session-id'), session)
  assert.equal(flag(call.args, '--allowedTools'), 'Read,Edit,Write,Glob,Grep,Bash(npm test *)')
  assert.match(call.text, /Nobody is available to answer questions/)
  assert.match(call.text, /reading scope/)
  assert.match(call.text, /# implement-task/)
  await executeAgentAdapter({ provider: 'claude', job: { ...job(fixture.root), resume: session, directive: { note: 'ITEM-4 r2: cap is 10' } }, env: fixture.env, log: () => {} })
  const resumed = (await readFile(path.join(fixture.root, 'calls.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line))[1]
  assert.equal(flag(resumed.args, '--resume'), session)
  assert.ok(!resumed.args.includes('--session-id'))
  assert.match(resumed.text, /Coordinator note: ITEM-4 r2: cap is 10/)
  assert.doesNotMatch(resumed.text, /# implement-task/)
})

test('Codex 세션은 첫 이벤트의 thread_id로 기록하고 exec resume으로 이어 간다', async (t) => {
  const fixture = await stub(t, 'codex', `const fs=require('node:fs');const args=process.argv.slice(2);let text='';process.stdin.on('data',chunk=>text+=chunk);process.stdin.on('end',()=>{fs.writeFileSync('args.json',JSON.stringify(args));console.log(JSON.stringify({type:'thread.started',thread_id:'thread-123'}));fs.writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify({outcome:'completed',summary:'done',decision:{question:'',options:[],recommendation:''}}));});`)
  const sessionFile = path.join(fixture.root, 'session.txt')
  const result = await executeAgentAdapter({ provider: 'codex', job: { ...job(fixture.root), sessionFile }, env: fixture.env, log: () => {} })
  assert.equal(result.session, 'thread-123')
  assert.equal(result.decision, null)
  assert.equal(await readFile(sessionFile, 'utf8'), 'thread-123')
  await executeAgentAdapter({ provider: 'codex', job: { ...job(fixture.root), resume: 'thread-123' }, env: fixture.env, log: () => {} })
  const args = JSON.parse(await readFile(path.join(fixture.root, 'args.json'), 'utf8'))
  assert.deepEqual(args.slice(0, 7), ['-a', 'never', '--sandbox', 'workspace-write', 'exec', 'resume', 'thread-123'])
  assert.ok(args.includes('--output-schema'))
})

test('unit adapters use fresh sessions and permit bypass only when explicitly selected', async (t) => {
  const fixture = await stub(t, 'claude', `const fs=require('node:fs');let text='';process.stdin.on('data',chunk=>text+=chunk);process.stdin.on('end',()=>{fs.writeFileSync('received.json',JSON.stringify({args:process.argv.slice(2),text,cwd:process.cwd()}));console.log(JSON.stringify({structured_output:{kind:'task',id:'T001',outcome:'completed',pushed:false,next:'implementation'}}));});`)
  const first = await executeAgentAdapter({ provider: 'claude', job: { role: 'unit', workspace: fixture.root, tag: 't060', allowTools: ['Bash(npm test *)'] }, env: fixture.env, log: () => {} })
  const second = await executeAgentAdapter({ provider: 'claude', job: { role: 'unit', workspace: fixture.root, tag: 't060' }, env: fixture.env, log: () => {} })
  assert.notEqual(first.session, second.session)
  const received = JSON.parse(await readFile(path.join(fixture.root, 'received.json'), 'utf8'))
  assert.equal(received.cwd, fixture.root)
  assert.equal(flag(received.args, '--permission-mode'), 'acceptEdits')
  assert.ok(!received.args.includes('--resume'))
  assert.match(received.text, /Exactly one task done/)
  assert.match(received.text, /No questions, no subagents/)
  const files = { schema: 'schema', result: 'result' }
  assert.equal(flag(providerArguments('claude', 'unit', files, null, { permissionMode: 'bypass' }), '--permission-mode'), 'bypassPermissions')
  assert.ok(providerArguments('codex', 'unit', files, null, { permissionMode: 'bypass' }).includes('--dangerously-bypass-approvals-and-sandbox'))
  // A resumed bypass session keeps its Codex session (exec resume takes the bypass flag too).
  assert.deepEqual(providerArguments('codex', 'worker', files, null, { permissionMode: 'bypass', resume: 'abc' }).slice(0, 4), ['exec', 'resume', 'abc', '--dangerously-bypass-approvals-and-sandbox'])
  assert.ok(!providerArguments('codex', 'unit', files).some((arg) => arg.includes('bypass')))
  await assert.rejects(executeAgentAdapter({ provider: 'claude', job: { role: 'unit', workspace: fixture.root, resume: first.session }, env: fixture.env }), /resume 금지/)
})

// Codex units used to `cat .codex/skills/start-vibe/SKILL.md` first, loading the inlined skill twice.
test('unit prompt inlines the start-vibe body once, without frontmatter, and says it is already loaded', async (t) => {
  const fixture = await stub(t, 'codex', `const fs=require('node:fs');let text='';process.stdin.on('data',chunk=>text+=chunk);process.stdin.on('end',()=>{fs.writeFileSync('prompt.txt',text);const out=process.argv[process.argv.indexOf('--output-last-message')+1];fs.writeFileSync(out,JSON.stringify({kind:'none',id:'',outcome:'no_work',pushed:false,next:''}));});`)
  await executeAgentAdapter({ provider: 'codex', job: { role: 'unit', workspace: fixture.root, tag: 't061' }, env: fixture.env, log: () => {} })
  const text = await readFile(path.join(fixture.root, 'prompt.txt'), 'utf8')
  const file = await readFile(new URL('../skills/start-vibe/SKILL.md', import.meta.url), 'utf8')
  const [, frontmatter, body] = file.match(/^---\n([\s\S]*?)\n---\n+([\s\S]*)$/)
  const note = text.search(/start-vibe skill is included below and already loaded: do not open its SKILL\.md or call a Skill tool for it/)
  assert.ok(note >= 0 && note < text.indexOf(body), 'the no-reload note comes before the skill')
  assert.match(text, /Load the skills it routes to \(implement-task, create-task, update-ssot/)
  assert.equal(text.split(body).length, 2, 'the skill body appears exactly once')
  // The trigger description is frontmatter only; none of its lines reach the unit.
  const description = frontmatter.split('\n').filter((line) => /^\s{2}\S/.test(line)).map((line) => line.trim())
  assert.ok(description.length > 0)
  for (const line of description) assert.ok(!text.includes(line), `frontmatter line leaked: ${line}`)
  assert.ok(!text.includes('name: start-vibe'))
  assert.equal(skillBody('---\nname: x\n---\n\n# x\nbody\n'), '# x\nbody\n')
  assert.equal(skillBody('# x\n---\nbody\n---\n'), '# x\n---\nbody\n---\n')
})

test('탐색 세션은 읽기 전용으로 실행되고 제안 JSON만 돌려준다', async (t) => {
  const proposal = { title: 'Cache parsed config', where: 'src/a.mjs:10', problem: 'parsed per call', evidence: 'profile.log:3', change: 'memoize', touches: ['src/a.mjs'], preserves: 'same output', checks: 'unit a', cost: 'small', risk: 'stale cache' }
  const fixture = await stub(t, 'claude', `const fs=require('node:fs');let text='';process.stdin.on('data',chunk=>text+=chunk);process.stdin.on('end',()=>{fs.writeFileSync('received.json',JSON.stringify({args:process.argv.slice(2),text}));console.log(JSON.stringify({type:'result',is_error:false,usage:{output_tokens:7},structured_output:{summary:'one',proposals:[${JSON.stringify(proposal)}]}}));});`)
  const result = await executeAgentAdapter({ provider: 'claude', job: { schemaVersion: 1, role: 'scout', workspace: fixture.root, prompt: 'Assigned area: src/' }, env: fixture.env, log: () => {} })
  assert.deepEqual(result.proposals, [proposal]); assert.equal(result.usage.output_tokens, 7)
  const { args, text } = JSON.parse(await readFile(path.join(fixture.root, 'received.json'), 'utf8'))
  assert.equal(flag(args, '--permission-mode'), 'plan')
  assert.ok(!flag(args, '--tools').includes('Edit'))
  assert.match(text, /read-only scout/); assert.match(text, /Assigned area: src\//)
  assert.equal(flag(providerArguments('codex', 'scout', { schema: 'schema', result: 'result' }), '--sandbox'), 'read-only')
  assert.throws(() => claudeResult(JSON.stringify({ structured_output: { summary: 'x', proposals: [{ title: 'only' }] } }), 'scout'), /탐색 제안/)
  await assert.rejects(executeAgentAdapter({ provider: 'claude', job: { schemaVersion: 1, role: 'scout', workspace: fixture.root, prompt: ' ' }, env: fixture.env }), /prompt/)
})

test('탐색 세션은 timeout에 끝나고 work scout는 실행기 확인·프롬프트 파일만 다룬다', async (t) => {
  const fixture = await stub(t, 'claude', `setInterval(() => {}, 1000)`)
  await assert.rejects(executeAgentAdapter({ provider: 'claude', job: { schemaVersion: 1, role: 'scout', workspace: fixture.root, prompt: 'look', timeoutMs: 200 }, env: fixture.env, log: () => {} }), /timeout/)
  const { workScout } = await import('../src/work-scout.mjs')
  const promptFile = path.join(fixture.root, 'prompt.md')
  await writeFile(promptFile, 'Assigned area: test/')
  const providers = [{ provider: 'codex', compatible: true }, { provider: 'claude', compatible: false }]
  let seen
  const result = await workScout({ promptFile, targetRoot: fixture.root }, { inspect: async () => ({ autoProvider: 'codex', providers }),
    execute: async (input) => { seen = input; return { summary: 'none', proposals: [], usage: { input_tokens: 2, cache_read_input_tokens: 9, output_tokens: 3, iterations: [] } } } })
  assert.equal(result.provider, 'codex'); assert.deepEqual(result.proposals, [])
  assert.deepEqual(result.usage, { input: 2, cacheWrite: 0, cacheRead: 9, output: 3 })
  assert.equal(seen.job.role, 'scout'); assert.equal(seen.job.prompt, 'Assigned area: test/'); assert.equal(seen.job.timeoutMs, 900000)
  assert.deepEqual(seen.flags, [])
  // The scout asks providerFlags itself and hands the answer to the session.
  const claude = [{ provider: 'claude', compatible: true }]
  await workScout({ promptFile, targetRoot: fixture.root }, { inspect: async () => ({ autoProvider: 'claude', providers: claude }),
    flags: async (provider) => provider === 'claude' ? [SHARED_PROMPT] : [], execute: async (input) => { seen = input; return { summary: 'none', proposals: [] } } })
  assert.deepEqual(seen.flags, [SHARED_PROMPT])
  await assert.rejects(workScout({ promptFile, provider: 'claude' }, { inspect: async () => ({ autoProvider: 'codex', providers }) }), /사용 가능한 claude/)
  await assert.rejects(workScout({}), /prompt-file/)
})

test('A/B 변형 세션은 쓰기 권한·허용 명령으로 실행되고 커밋·서버는 호스트 몫으로 둔다', async (t) => {
  const fixture = await stub(t, 'claude', `const fs=require('node:fs');let text='';process.stdin.on('data',chunk=>text+=chunk);process.stdin.on('end',()=>{fs.writeFileSync('received.json',JSON.stringify({args:process.argv.slice(2),text}));console.log(JSON.stringify({type:'result',is_error:false,usage:{output_tokens:4},structured_output:{outcome:'completed',summary:'card layout',view:'pricing cards',path:' /pricing '}}));});`)
  const result = await executeAgentAdapter({ provider: 'claude', job: { schemaVersion: 1, role: 'variant', workspace: fixture.root, prompt: 'Variant a: cards', allowTools: ['Bash(npm test *)'] }, env: fixture.env, log: () => {} })
  assert.deepEqual({ outcome: result.outcome, view: result.view, path: result.path }, { outcome: 'completed', view: 'pricing cards', path: '/pricing' })
  // Variant runs report usage like units and scouts, so the comparison's cost is visible.
  assert.equal(result.usage.output_tokens, 4)
  const { args, text } = JSON.parse(await readFile(path.join(fixture.root, 'received.json'), 'utf8'))
  assert.equal(flag(args, '--permission-mode'), 'acceptEdits'); assert.ok(flag(args, '--allowedTools').includes('Bash(npm test *)'))
  assert.match(text, /host commits your changes/); assert.match(text, /\$PORT/); assert.match(text, /Variant a: cards/); assert.match(text, /path \(the URL path/)
  assert.ok(JSON.parse(flag(args, '--json-schema')).required.includes('path'))
  assert.throws(() => claudeResult(JSON.stringify({ structured_output: { outcome: 'completed', summary: 'x' } }), 'variant'), /view/)
  // Results without path (older providers or records) open at the root.
  assert.equal(claudeResult(JSON.stringify({ structured_output: { outcome: 'completed', summary: 'x', view: 'home' } }), 'variant').path, '')
  assert.throws(() => claudeResult(JSON.stringify({ structured_output: { outcome: 'completed', summary: 'x', view: 'home', path: 3 } }), 'variant'), /path/)
  // The mock scaffold writes like a variant but is told it never ships: no switch read by app code.
  const scaffold = await executeAgentAdapter({ provider: 'claude', job: { schemaVersion: 1, role: 'scaffold', workspace: fixture.root, prompt: 'Screen: /pricing', permissionMode: 'bypass' }, env: fixture.env, log: () => {} })
  assert.equal(scaffold.path, '/pricing'); assert.equal(scaffold.usage.output_tokens, 4)
  const sent = JSON.parse(await readFile(path.join(fixture.root, 'received.json'), 'utf8'))
  assert.equal(flag(sent.args, '--permission-mode'), 'bypassPermissions')
  assert.match(sent.text, /never ships/); assert.match(sent.text, /Do NOT add an environment switch/); assert.match(sent.text, /request interception/)
  assert.match(sent.text, /Do NOT edit the target screen's component, route, loader or style files/); assert.match(sent.text, /Screen: \/pricing$/)
})
