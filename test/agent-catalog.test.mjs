import test from 'node:test'
import assert from 'node:assert/strict'
import { agentCatalog, buildCatalog, parseClaudeHelp, parseCodexModels, parseCodexLogin, parseClaudeAuth, capability, costOrder, TIERS } from '../src/agent-catalog.mjs'

const CLAUDE_HELP = `Usage: claude [options] [command] [prompt]

Options:
  --effort <level>                      Effort level for the current session
                                        (low, medium, high, xhigh, max)
  --fallback-model <model>              Enable automatic fallback
  --model <model>                       Model for the current session. Provide
                                        an alias for the latest model (e.g.
                                        'fable', 'opus', or 'sonnet') or a
                                        model's full name.
  -n, --name <name>                     Set a display name
`
const level = (effort) => ({ effort, description: `${effort} reasoning` })
const CODEX_MODELS = JSON.stringify({ models: [
  { slug: 'gpt-x-astra', visibility: 'list', priority: 2, context_window: 272000, supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map(level), upgrade: null },
  { slug: 'gpt-x.1-sol', visibility: 'list', priority: 1, context_window: 272000, supported_reasoning_levels: ['low', 'medium', 'high'].map(level), upgrade: null },
  { slug: 'gpt-x-sol', visibility: 'list', priority: 3, context_window: 128000, supported_reasoning_levels: ['low', 'medium', 'high'].map(level), upgrade: null },
  { slug: 'gpt-w-sol', visibility: 'list', priority: 5, context_window: 64000, supported_reasoning_levels: ['low'].map(level), upgrade: { model: 'gpt-x-sol' } },
  { slug: 'gpt-x-luna', visibility: 'list', priority: 4, context_window: 500000, supported_reasoning_levels: ['low', 'minimal'].map(level), upgrade: null },
  { slug: 'mystery-1', visibility: 'list', priority: 9, context_window: 100000, supported_reasoning_levels: ['low'].map(level), upgrade: null },
  { slug: 'gpt-x-cyber', visibility: 'hide', priority: 11, context_window: 1000, supported_reasoning_levels: ['low'].map(level), upgrade: null },
] })

// A fake CLI: answers keyed by the command line, ENOENT for anything not listed.
function fakeCall(answers) {
  const calls = []
  const call = async (command, args) => {
    const line = [command, ...args].join(' ')
    calls.push(line)
    if (!Object.hasOwn(answers, command)) return { missing: true, code: null, stdout: '', stderr: '' }
    const answer = answers[command][args.join(' ')]
    return answer ?? { code: 1, stdout: '', stderr: 'unknown command' }
  }
  return Object.assign(call, { calls })
}
const ok = (stdout, stderr = '') => ({ code: 0, stdout, stderr })
const BOTH = {
  claude: { '--version': ok('9.9.9 (Claude Code)\n'), '--help': ok(CLAUDE_HELP), 'auth status --json': ok(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'someone@example.com', orgName: 'secret org' })) },
  codex: { '--version': ok('codex-cli 1.0.0\n'), 'debug models --bundled': ok(CODEX_MODELS), 'login status': { code: 1, stdout: '', stderr: 'Not logged in\n' } },
}

test('파서: claude --help의 에포트·별칭, codex 카탈로그의 표시 모델·에포트·context·대체, 로그인은 추측하지 않는다', () => {
  assert.deepEqual(parseClaudeHelp(CLAUDE_HELP), { efforts: ['low', 'medium', 'high', 'xhigh', 'max'], aliases: ['fable', 'opus', 'sonnet'] })
  assert.deepEqual(parseClaudeHelp('Usage: claude\n'), { efforts: [], aliases: [] })
  const models = parseCodexModels(CODEX_MODELS)
  assert.deepEqual(models.map((entry) => entry.model), ['gpt-x-astra', 'gpt-x.1-sol', 'gpt-x-sol', 'gpt-w-sol', 'gpt-x-luna', 'mystery-1'])
  assert.deepEqual(models.find((entry) => entry.model === 'gpt-w-sol'), { model: 'gpt-w-sol', efforts: ['low'], context: 64000, priority: 5, superseded: 'gpt-x-sol' })
  assert.throws(() => parseCodexModels('{"nothing":1}'))
  assert.deepEqual(parseCodexLogin(ok('Logged in using ChatGPT\n')), { loggedIn: true, auth: 'ChatGPT' })
  assert.deepEqual(parseCodexLogin({ code: 1, stdout: '', stderr: 'Not logged in' }), { loggedIn: false })
  assert.deepEqual(parseCodexLogin({ code: 2, stdout: '', stderr: 'config error' }), { loggedIn: null })
  // only the login fact and its method leave the probe — never account details
  assert.deepEqual(parseClaudeAuth(BOTH.claude['auth status --json']), { loggedIn: true, auth: 'claude.ai' })
  assert.deepEqual(parseClaudeAuth(ok('not json')), { loggedIn: null })
})

test('점수·비용: 계열 순위와 에포트 순위를 한 척도로, 비용은 계열 먼저 — 표가 두 도구를 같은 위치로 맞춘다', () => {
  assert.deepEqual(Object.values(TIERS.claude), [1, 2, 3, 4]); assert.deepEqual(Object.values(TIERS.codex), [1, 2, 3, 4])
  assert.deepEqual([capability(1, 'low'), capability(2, 'xhigh'), capability(3, 'low'), capability(4, 'max'), capability(4, 'ultra')], [1, 7, 7, 14, 15])
  assert.ok(costOrder(2, 'max') < costOrder(3, 'low'))
  assert.ok(costOrder(3, 'low') < costOrder(3, 'medium'))
})

test('카탈로그: 설치·버전·로그인·모델, 대체된 모델과 숨긴 모델은 제안하지 않고, 칸마다 알려진 모델·카탈로그 우선순위 하나', async () => {
  const call = fakeCall(BOTH)
  const result = await agentCatalog({}, { call, agents: 'codex,claude' })
  assert.deepEqual([result.schemaVersion, result.modelRequests, result.agents, result.unset], [1, 0, ['codex', 'claude'], false])
  const [claude, codex] = result.tools
  assert.deepEqual({ ...claude, models: claude.models.map((entry) => [entry.model, entry.tier, entry.known, entry.inHelp]) }, {
    tool: 'claude', installed: true, version: '9.9.9 (Claude Code)', loggedIn: true, auth: 'claude.ai', allowed: true, status: 'ok',
    models: [['haiku', 1, true, false], ['sonnet', 2, true, true], ['opus', 3, true, true], ['fable', 4, true, true]] })
  assert.ok(claude.models.every((entry) => entry.context === null && entry.efforts.length === 5))
  assert.deepEqual([codex.loggedIn, codex.version, codex.allowed, codex.models.length], [false, 'codex-cli 1.0.0', true, 6])
  assert.doesNotMatch(JSON.stringify(result), /someone@example\.com|secret org/)
  const codexOptions = result.options.filter((option) => option.tool === 'codex').map((option) => `${option.model}@${option.effort}`)
  // gpt-x.1-sol wins the sol slots over gpt-x-sol (priority 1 < 3); gpt-w-sol is superseded; luna's
  // unknown 'minimal' effort is listed on the model but never offered; the hidden model is absent.
  assert.deepEqual(codexOptions.filter((option) => /sol/.test(option)), ['gpt-x.1-sol@low', 'gpt-x.1-sol@medium', 'gpt-x.1-sol@high'])
  assert.deepEqual(codexOptions.filter((option) => /luna|mystery/.test(option)), ['gpt-x-luna@low'])
  assert.deepEqual(codex.models.find((entry) => entry.model === 'mystery-1').known, false)
  assert.ok(!codexOptions.some((option) => /cyber|gpt-w-sol/.test(option)))
  // cheapest first; on a tie the SETTINGS order decides (codex before claude here)
  assert.deepEqual(result.options.slice(0, 2).map((option) => [option.tool, option.model, option.effort, option.score, option.cost]), [['codex', 'gpt-x-luna', 'low', 1, 11], ['claude', 'haiku', 'low', 1, 11]])
  for (let index = 1; index < result.options.length; index += 1) assert.ok(result.options[index - 1].cost <= result.options[index].cost)
  // the smallest window among offered models of allowed tools; Claude cannot tell its window without a model call
  assert.deepEqual([result.minContext, result.contextUnknown], [{ tool: 'codex', model: 'gpt-x.1-sol', tokens: 272000 }, ['claude']])
  assert.ok(call.calls.every((line) => !/(^| )(-p|--print|exec)( |$)/.test(line)), call.calls.join('\n'))
})

test('카탈로그: agents 미정·목록 밖 도구는 allowed가 아니고, 미설치·출력을 못 읽은 도구는 추측 없이 표시한다', async () => {
  const unset = await agentCatalog({}, { call: fakeCall(BOTH), agents: '?' })
  assert.deepEqual([unset.agents, unset.unset, unset.minContext, unset.contextUnknown], [null, true, null, []])
  assert.ok(unset.tools.every((tool) => tool.allowed === false) && unset.options.every((option) => option.allowed === false))
  const claudeOnly = await agentCatalog({}, { call: fakeCall(BOTH), agents: 'claude' })
  assert.deepEqual([claudeOnly.minContext, claudeOnly.contextUnknown], [null, ['claude']])
  assert.deepEqual([...new Set(claudeOnly.options.filter((option) => option.allowed).map((option) => option.tool))], ['claude'])
  // codex not installed; claude's help does not list efforts any more
  const broken = await agentCatalog({}, { call: fakeCall({ claude: { ...BOTH.claude, '--help': ok('Usage: claude\n') } }), agents: 'claude,codex' })
  const [claude, codex] = broken.tools
  assert.deepEqual([claude.status, claude.error, claude.models, claude.loggedIn], ['unknown', 'help-unparsed', [], true])
  assert.deepEqual([codex.installed, codex.status, codex.loggedIn, codex.version], [false, 'not-installed', false, null])
  assert.deepEqual(broken.options, [])
  const unreadable = await agentCatalog({}, { call: fakeCall({ codex: { ...BOTH.codex, 'debug models --bundled': ok('{not json') } }), agents: 'codex' })
  assert.deepEqual([unreadable.tools[1].status, unreadable.tools[1].error, unreadable.options], ['unknown', 'models-unavailable', []])
})

test('buildCatalog: 별칭 표에 없는 claude 별칭은 낮은 순위로 두고 알려진 모델이 같은 칸을 차지한다', () => {
  const probes = { claude: { installed: true, version: '1', loggedIn: true, models: ['haiku', 'pico'].map((model) => ({ model, efforts: ['low'], context: null })) } }
  const { tools, options } = buildCatalog(probes, ['claude'])
  assert.deepEqual(tools[0].models.map((entry) => [entry.model, entry.tier, entry.known]), [['haiku', 1, true], ['pico', 1, false]])
  assert.deepEqual(options.map((option) => option.model), ['haiku'])
})
