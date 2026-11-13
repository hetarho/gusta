import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { classifyFailure, parseResetText, parseFailure, failureLine, noteLimit, activeLimits, limitBlocks, earliestReset, readLimits, recordLimit, limitHint, fallbackNote,
  GUESS_MS, MAX_GUESS_MS } from '../src/provider-limits.mjs'

// Anonymous fixtures in the shape the tools print; times are local wall clocks built with the Date
// constructor, so the expectations hold in any machine time zone.
const at = (month, day, hour, minute = 0) => new Date(2026, month, day, hour, minute).getTime()
const iso = (ms) => new Date(ms).toISOString()

test('Claude: rejected rate_limit_event가 먼저(resetsAt·계열), 없으면 result 문구의 한도 종류와 "resets <시각>"을 읽는다', () => {
  const now = at(10, 13, 10)
  const opus = classifyFailure({ tool: 'claude', model: 'opus', events: [
    { type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', resetsAt: 1 } },
    { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: Math.floor(now / 1000) + 3600, rateLimitType: 'seven_day_opus' } },
    { type: 'result', is_error: true, result: "You've hit your Opus limit · resets 3:45pm" }] }, { now })
  assert.deepEqual([opus.kind, opus.scope, opus.family, opus.model, opus.resetAt], ['usage-limit', 'family', 'opus', 'opus', iso(now + 3600000)])
  // session and weekly limits are the whole tool's; the reset comes from the message.
  for (const word of ['session', 'weekly']) {
    const tool = classifyFailure({ tool: 'claude', events: [{ type: 'result', is_error: true, result: `You've hit your ${word} limit · resets 3:45pm` }] }, { now })
    assert.deepEqual([tool.kind, tool.scope, tool.family, tool.resetAt], ['usage-limit', 'tool', undefined, iso(at(10, 13, 15, 45))])
  }
  const sonnet = classifyFailure({ tool: 'claude', events: [{ type: 'result', is_error: true, result: "You've hit your Sonnet limit · resets 9am" }] }, { now })
  assert.deepEqual([sonnet.scope, sonnet.family, sonnet.resetAt], ['family', 'sonnet', iso(at(10, 14, 9))])
  // The five-hour window is the session limit: the tool, with its reset in epoch seconds.
  const five = classifyFailure({ tool: 'claude', events: [{ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: Math.floor(now / 1000) + 600, rateLimitType: 'five_hour' } }] }, { now })
  assert.deepEqual([five.kind, five.scope, five.resetAt], ['usage-limit', 'tool', iso(now + 600000)])
  // A blocking terminal reason with no reset anywhere: a usage limit with an unknown reset.
  assert.deepEqual(Object.keys(classifyFailure({ tool: 'claude', events: [{ type: 'result', is_error: true, terminal_reason: 'blocking_limit', result: 'limit' }] }, { now })).includes('resetAt'), false)
})

test('Claude API 재시도·상태 코드와 문구: 속도 한도·과부하·로그인·과금은 구별되고, 그 밖은 other다', () => {
  const now = at(10, 13, 10)
  const kind = (events, text = '') => classifyFailure({ tool: 'claude', events, text }, { now }).kind
  assert.equal(kind([{ type: 'system', subtype: 'api_retry', error: 'rate_limit' }, { type: 'result', is_error: true, result: 'API Error' }]), 'rate-limit')
  assert.equal(kind([{ type: 'system', subtype: 'api_retry', error: 'overloaded' }]), 'overloaded')
  assert.equal(kind([{ type: 'system', subtype: 'api_retry', error: 'billing_error' }]), 'usage-limit')
  assert.equal(kind([{ type: 'result', is_error: true, api_error_status: 401, result: 'API Error' }]), 'auth')
  assert.equal(kind([{ type: 'result', is_error: true, api_error_status: 529, result: 'API Error' }]), 'overloaded')
  assert.equal(kind([], 'Invalid API key · Please run /login'), 'auth')
  assert.equal(kind([], 'Error: OAuth token has expired'), 'auth')
  assert.equal(kind([{ type: 'system', subtype: 'init' }], 'TypeError: cannot read properties of undefined (line 401)'), 'other')
  // A success result's text is the model's answer, never read as an error.
  assert.equal(kind([{ type: 'result', is_error: false, result: 'I hit the usage limit of the API in the code' }]), 'other')
  const auth = classifyFailure({ tool: 'claude', text: 'Not logged in · Please run /login' }, { now })
  assert.deepEqual([auth.scope, auth.resetAt], ['tool', undefined])
})

test('"resets <시각>"은 로컬 시각이고 이미 지난 시각은 다음 날(자정 넘김), 날짜가 있으면 그 날, 괄호 속 시간대는 그 시간대다', () => {
  assert.equal(parseResetText('resets 3:45pm', at(10, 13, 16)), at(10, 14, 15, 45))
  assert.equal(parseResetText('resets 12:15am', at(10, 13, 23, 30)), at(10, 14, 0, 15))
  assert.equal(parseResetText('resets 12pm', at(10, 13, 9)), at(10, 13, 12))
  assert.equal(parseResetText('resets 15:45', at(10, 13, 9)), at(10, 13, 15, 45))
  assert.equal(parseResetText("You've hit your weekly limit · resets Nov 18, 9am", at(10, 13, 9)), at(10, 18, 9))
  assert.equal(parseResetText('resets Jan 2, 9am', at(11, 30, 9)), new Date(2027, 0, 2, 9).getTime())
  assert.equal(parseResetText('resets in 2h 5m', at(10, 13, 9)), at(10, 13, 11, 5))
  assert.equal(parseResetText('resets 3:45pm (UTC)', Date.UTC(2026, 10, 13, 10)), Date.UTC(2026, 10, 13, 15, 45))
  assert.equal(parseResetText('resets 9am (Asia/Seoul)', Date.UTC(2026, 10, 13, 10)), Date.UTC(2026, 10, 14, 0))
  // Not a time: a count, a bare number, an unknown month.
  for (const text of ['resets 3 times', 'resets 15', 'resets Foo 3, 9am', 'no reset here']) assert.equal(parseResetText(text, at(10, 13, 9)), null, text)
})

test('Codex: turn.failed·error 문구와 코드로 분류하고 "Try again at <날짜 시각>"·"in ..."·resets_in_seconds를 읽는다', () => {
  const now = at(10, 13, 10)
  const limited = classifyFailure({ tool: 'codex', events: [{ type: 'thread.started', thread_id: 't' }, { type: 'turn.failed', error: { message: "You've hit your usage limit. Upgrade to Pro or try again at Nov 14, 2026 3:45 PM." } }] }, { now })
  assert.deepEqual([limited.kind, limited.scope, limited.tool, limited.resetAt], ['usage-limit', 'tool', 'codex', iso(at(10, 14, 15, 45))])
  assert.equal(classifyFailure({ tool: 'codex', events: [{ type: 'error', message: 'usage_limit_reached' }] }, { now }).kind, 'usage-limit')
  assert.equal(classifyFailure({ tool: 'codex', events: [{ type: 'error', message: '{"error":{"type":"quota_exceeded"}}' }] }, { now }).kind, 'usage-limit')
  assert.equal(classifyFailure({ tool: 'codex', events: [{ type: 'turn.failed', error: { message: 'server_overloaded: try later' } }] }, { now }).kind, 'overloaded')
  assert.equal(classifyFailure({ tool: 'codex', events: [{ type: 'error', message: 'stream error: 429 Too Many Requests: rate limit exceeded' }] }, { now }).kind, 'rate-limit')
  assert.equal(classifyFailure({ tool: 'codex', events: [], text: 'Error: Not logged in. Run codex login.' }, { now }).kind, 'auth')
  assert.equal(classifyFailure({ tool: 'codex', events: [{ type: 'error', message: "You've hit your usage limit. Try again in 3 hours 20 minutes." }] }, { now }).resetAt, iso(now + 200 * 60000))
  assert.equal(classifyFailure({ tool: 'codex', events: [{ type: 'turn.failed', error: { message: 'usage_limit_reached', resets_in_seconds: 90 } }] }, { now }).resetAt, iso(now + 90000))
  assert.equal(classifyFailure({ tool: 'codex', events: [{ type: 'turn.failed', error: { message: 'tests failed' } }] }, { now }).kind, 'other')
})

test('리셋을 모르면 30분, 같은 대상이 다시 걸리면 두 배씩 최대 5시간; 리셋이 지난 기록은 막지 않고 하루 뒤 지워진다', () => {
  let now = at(10, 13, 10), store = { schemaVersion: 1, entries: [] }
  const guesses = []
  for (let hit = 0; hit < 6; hit++) {
    store = noteLimit(store, { kind: 'usage-limit', tool: 'claude', message: 'limit' }, now)
    const entry = store.entries.find((item) => item.tool === 'claude')
    guesses.push(Date.parse(entry.resetAt) - now)
    now = Date.parse(entry.resetAt) + 60000
  }
  assert.deepEqual(guesses, [GUESS_MS, 2 * GUESS_MS, 4 * GUESS_MS, 8 * GUESS_MS, MAX_GUESS_MS, MAX_GUESS_MS])
  assert.equal(store.entries[0].hits, 6)
  // A reported reset is taken as given; another family is its own target.
  store = noteLimit(store, { kind: 'usage-limit', tool: 'claude', family: 'opus', resetAt: iso(now + 7200000) }, now)
  store = noteLimit(store, { kind: 'rate-limit', tool: 'codex' }, now)
  assert.deepEqual(activeLimits(store, now).map(({ tool, family, reason, source }) => [tool, family, reason, source]), [['claude', 'opus', 'usage-limit', 'reported'], ['codex', undefined, 'rate-limit', 'estimated']])
  assert.deepEqual(limitBlocks(activeLimits(store, now)), [{ tool: 'claude', family: 'opus', reason: 'usage-limit' }, { tool: 'codex', reason: 'rate-limit' }])
  assert.equal(earliestReset(activeLimits(store, now)), now + GUESS_MS)
  // Past every reset nothing blocks; a day later the records are gone; an overload or sign-in is never recorded.
  assert.deepEqual(activeLimits(store, now + 3 * 3600000), [])
  assert.deepEqual(noteLimit(store, { kind: 'auth', tool: 'claude' }, now), store)
  assert.deepEqual(noteLimit(store, { kind: 'rate-limit', tool: 'codex' }, now + 2 * 86400000).entries.map(({ tool }) => tool), ['codex'])
})

test('기록은 주입한 fs·now로 읽고 쓰며, 깨진 파일은 빈 기록이다', async () => {
  const files = new Map()
  const fs = {
    readFile: async (file) => { if (!files.has(file)) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return files.get(file) },
    writeFile: async (file, text) => { files.set(file, text) }, rename: async (from, to) => { files.set(to, files.get(from)); files.delete(from) },
    mkdir: async () => {}, rm: async (file) => { files.delete(file) },
  }
  const runtime = path.join('/runtime', 'gusta', 'v1'), now = at(10, 13, 10)
  assert.deepEqual(await readLimits(runtime, { fs }), { schemaVersion: 1, entries: [] })
  const entry = await recordLimit(runtime, { kind: 'usage-limit', tool: 'claude', resetAt: iso(now + 3600000), message: 'limit' }, { fs, now })
  assert.deepEqual([entry.tool, entry.resetAt, entry.since, entry.source], ['claude', iso(now + 3600000), iso(now), 'reported'])
  assert.deepEqual([...files.keys()], [path.join(runtime, 'limits.json')])
  assert.equal((await readLimits(runtime, { fs })).entries.length, 1)
  files.set(path.join(runtime, 'limits.json'), '{broken')
  assert.deepEqual(await readLimits(runtime, { fs }), { schemaVersion: 1, entries: [] })
})

test('failure 한 줄·힌트·보고서 메모', () => {
  const failure = { kind: 'usage-limit', scope: 'tool', tool: 'claude', resetAt: iso(at(10, 13, 15, 45)), message: 'limit' }
  assert.deepEqual(parseFailure(`progress\n${failureLine(failure)}\n`), failure)
  assert.equal(parseFailure('{"kind":"task"}'), null)
  assert.equal(parseFailure(JSON.stringify({ failure: { kind: 'strange', tool: 'claude' } })), null)
  const now = at(10, 13, 10)
  assert.equal(limitHint([{ tool: 'codex', resetAt: iso(at(10, 14, 9, 5)) }, { tool: 'claude', family: 'opus', resetAt: iso(at(10, 13, 15, 45)) }], now), 'claude/opus 15:45·codex 11-14 09:05까지 사용량 한도 — 그 뒤 다시 실행하세요')
  assert.equal(fallbackNote({ kind: 'usage-limit', tool: 'claude', resetAt: iso(at(10, 13, 15, 45)) }, now), 'claude limit, resets 15:45')
  assert.equal(fallbackNote({ kind: 'rate-limit', tool: 'codex', resetAt: iso(at(10, 13, 10, 30)), estimated: true }, now), 'codex rate-limit, resets ~10:30')
  assert.equal(fallbackNote({ kind: 'auth', tool: 'claude' }, now), 'claude auth')
})
