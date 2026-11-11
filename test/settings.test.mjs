import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { parseSettings, effectiveSettings, applySettings, readSetting, vibeSettings, branchPlan, permissionMode } from '../src/settings.mjs'
import { MIGRATIONS, formatDrift, changesSince, packageVersions } from '../src/migrate.mjs'
import { lintSpec } from '../src/spec-lint.mjs'
import { fixture } from './helpers/vibe-fixture.mjs'

test('설정: 파일·키가 없으면 기본값, 잘못된 값은 오류로 남고 읽는 쪽은 추측하지 않는다', async (t) => {
  assert.deepEqual(effectiveSettings(null).settings.map(({ key, value, source }) => [key, value, source]),
    [['prune-branches', true, 'default'], ['land', '?', 'default'], ['land-via', 'merge', 'default'], ['push', false, 'default'], ['deploy', '-', 'default'], ['plan', '?', 'default'], ['permission-mode', 'bypass', 'default'], ['headless-mcp', 'isolate', 'default']])
  assert.deepEqual(effectiveSettings(null).unset, ['land'])
  assert.match(parseSettings('# SETTINGS\n- land: bad..name\n- deploy: true\n').errors.join(), /land: bad\.\.name.*deploy: true/)
  const parsed = parseSettings('# SETTINGS\n- prune-branches: false  # keep\n- color: blue\n')
  assert.deepEqual(parsed, { values: { 'prune-branches': false }, errors: [], unknown: ['color'] })
  assert.match(parseSettings('# SETTINGS\n- prune-branches: no\n').errors[0], /prune-branches: no \(true\|false\)/)
  const { root } = await fixture(t, 0)
  assert.equal(await readSetting({ targetRoot: root }, 'prune-branches'), true)
  await writeFile(path.join(root, 'spec/SETTINGS.md'), '# SETTINGS\n- prune-branches: no\n')
  await assert.rejects(readSetting({ targetRoot: root }, 'prune-branches'), /SETTINGS.md 값이 잘못/)
  assert.ok((await lintSpec({ targetRoot: root })).errors.some((error) => /SETTINGS.md: prune-branches: no/.test(error)))
})

test('headless 권한: 기본은 bypass, SETTINGS가 바꾸고, 명시한 --permission-mode가 그 실행만 덮는다', async (t) => {
  const { root } = await fixture(t, 0)
  assert.equal(await permissionMode({}, root), 'bypass')
  await vibeSettings({ targetRoot: root, set: ['permission-mode=acceptEdits'] })
  assert.equal(await permissionMode({}, root), 'acceptEdits')
  assert.equal(await permissionMode({ permissionMode: 'bypass' }, root), 'bypass')
  await assert.rejects(permissionMode({ permissionMode: 'yolo' }, root), /bypass\|acceptEdits/)
  await assert.rejects(vibeSettings({ targetRoot: root, set: ['permission-mode=plan'] }), /bypass\|acceptEdits/)
})

test('headless MCP: 기본은 isolate, vibe settings가 inherit로 바꾸고 보여 주며, 잘못된 값은 쓰지도 통과하지도 않는다', async (t) => {
  const { root } = await fixture(t, 0)
  assert.equal(await readSetting({ targetRoot: root }, 'headless-mcp'), 'isolate')
  const result = await vibeSettings({ targetRoot: root, set: ['headless-mcp=inherit'] })
  assert.deepEqual(result.changed, ['headless-mcp'])
  const shown = result.settings.find((entry) => entry.key === 'headless-mcp')
  assert.deepEqual([shown.value, shown.source, shown.default, shown.values], ['inherit', 'file', 'isolate', 'isolate|inherit'])
  assert.match(shown.note, /isolate = .*\.mcp\.json/)
  assert.equal(await readSetting({ targetRoot: root }, 'headless-mcp'), 'inherit')
  assert.match(await readFile(path.join(root, 'spec/SETTINGS.md'), 'utf8'), /^- headless-mcp: inherit {2}# /m)
  await assert.rejects(vibeSettings({ targetRoot: root, set: ['headless-mcp=none'] }), /isolate\|inherit/)
  await writeFile(path.join(root, 'spec/SETTINGS.md'), '# SETTINGS\n- headless-mcp: none\n')
  assert.ok((await lintSpec({ targetRoot: root })).errors.some((error) => /SETTINGS.md: headless-mcp: none \(isolate\|inherit\)/.test(error)))
  await assert.rejects(readSetting({ targetRoot: root }, 'headless-mcp'), /SETTINGS.md 값이 잘못/)
})

test('vibe settings --set은 파일을 만들거나 그 줄만 바꾸고, 같은 값이면 쓰지 않는다', async (t) => {
  const { root } = await fixture(t, 0)
  let result = await vibeSettings({ targetRoot: root })
  assert.equal(result.exists, false)
  assert.deepEqual(result.changed, [])
  result = await vibeSettings({ targetRoot: root, set: ['prune-branches=false'] })
  assert.deepEqual(result.changed, ['prune-branches'])
  assert.equal(result.settings[0].value, false); assert.equal(result.settings[0].source, 'file')
  const file = path.join(root, 'spec/SETTINGS.md')
  await writeFile(file, (await readFile(file, 'utf8')) + '- color: blue\n')
  result = await vibeSettings({ targetRoot: root, set: ['prune-branches=true'] })
  const text = await readFile(file, 'utf8')
  assert.match(text, /^# SETTINGS\n/); assert.match(text, /^- prune-branches: true {2}# /m); assert.match(text, /^- color: blue$/m)
  assert.equal(text.match(/prune-branches/g).length, 1)
  assert.deepEqual((await vibeSettings({ targetRoot: root, set: ['prune-branches=true'] })).changed, [])
  assert.deepEqual((await lintSpec({ targetRoot: root })).errors.filter((error) => error.includes('SETTINGS')), [])
  await assert.rejects(vibeSettings({ targetRoot: root, set: ['prune-branches=maybe'] }), /true\|false/)
  await assert.rejects(vibeSettings({ targetRoot: root, set: ['nope=1'] }), /알 수 없는 설정/)
  assert.equal(applySettings(null, { 'prune-branches': false }).split('\n')[0], '# SETTINGS')
})

test('브랜치 전략: SETTINGS가 우선이고, 없는 키만 예전 STATE cfg push·plan을 읽는다', () => {
  const state = '# STATE\n\n## cfg\n- level: expert\n- push: next\n- plan: trunk\n\n## ssot\n'
  const legacy = effectiveSettings(null, state)
  assert.deepEqual(legacy.settings.filter((entry) => ['land', 'push', 'plan'].includes(entry.key)).map(({ key, value, source }) => [key, value, source]),
    [['land', 'next', 'legacy-cfg'], ['push', true, 'legacy-cfg'], ['plan', 'trunk', 'legacy-cfg']])
  assert.deepEqual(legacy.unset, []); assert.deepEqual(legacy.legacy, ['push', 'plan'])
  const chosen = effectiveSettings('# SETTINGS\n- land: current\n- push: false\n', state)
  assert.deepEqual(chosen.settings.filter((entry) => ['land', 'push'].includes(entry.key)).map(({ value, source }) => [value, source]), [['current', 'file'], [false, 'file']])
  const values = (text) => Object.fromEntries(effectiveSettings(text).settings.map((entry) => [entry.key, entry.value]))
  // Straight to main, pushed.
  assert.deepEqual(branchPlan(values('# SETTINGS\n- land: main\n- push: true\n'), { branch: 'feat', defaultBranch: 'main' }),
    { land: 'main', via: 'merge', push: true, deploy: null, plan: 'main', pushTarget: 'main', landTarget: 'main', unset: false })
  // Staged on next, deployed to main; local only.
  assert.deepEqual(branchPlan(values('# SETTINGS\n- land: next\n- deploy: main\n'), { branch: 'next', defaultBranch: 'main' }),
    { land: 'next', via: 'merge', push: false, deploy: 'main', plan: 'next', pushTarget: null, landTarget: null, unset: false })
  // PR into main: never a direct push target.
  assert.equal(branchPlan(values('# SETTINGS\n- land: main\n- land-via: pr\n- push: true\n'), { branch: 'feat' }).pushTarget, null)
  // Unset: commit only; planning follows the repository default branch.
  assert.deepEqual(branchPlan(values(null), { branch: 'feat', defaultBranch: 'trunk' }),
    { land: null, via: 'merge', push: false, deploy: null, plan: 'trunk', pushTarget: null, landTarget: null, unset: true })
  assert.equal(branchPlan(values('# SETTINGS\n- land: current\n- push: true\n'), { branch: 'feat' }).pushTarget, 'feat')
})

test('migrate: cfg push·plan을 SETTINGS로 옮기고 다시 돌리면 바꾸지 않는다', () => {
  const [branch] = MIGRATIONS
  const state = '# STATE\n\n## cfg\n- level: expert\n- push: next  # old\n- plan: trunk\n\n## log\n- push: not cfg\n'
  const once = branch.run({ state, settings: null })
  assert.equal(once.state, '# STATE\n\n## cfg\n- level: expert\n\n## log\n- push: not cfg\n')
  assert.deepEqual(parseSettings(once.settings).values, { land: 'next', push: true, plan: 'trunk' })
  assert.deepEqual(branch.run(once), once)
  // An owner's explicit choice wins; commit-only cfg leaves land for haeram-init.
  const kept = branch.run({ state: state.replace('- push: next  # old', '- push: -'), settings: '# SETTINGS\n- plan: main\n' })
  assert.deepEqual(parseSettings(kept.settings).values, { plan: 'main' })
  assert.deepEqual(formatDrift('## A\n- one\n- two\n', '## A\n- one\n- mine\n'), { missing: [{ section: 'A', line: '- two' }], extra: [{ section: 'A', line: '- mine' }] })
})

test('outdated: lock 버전·npm 최신·그 사이 CHANGELOG 항목을 돌려주고 조회 실패는 오류로 남긴다', async (t) => {
  const changelog = '# Changelog\n\n## Unreleased\n\n- Next thing. More.\n\n## 0.3.0\n\n- Third. Detail.\n\n## 0.2.0\n\n- Second.\n\n## 0.1.0\n\n- First.\n'
  assert.deepEqual(changesSince(changelog, '0.1.0', '0.3.0'), [{ version: '0.3.0', items: ['Third.'] }, { version: '0.2.0', items: ['Second.'] }])
  const { root } = await fixture(t, 0)
  await writeFile(path.join(root, '.haeram-spec-creator-lock.json'), JSON.stringify({ packageVersion: '0.0.1' }))
  const found = await packageVersions({ targetRoot: root }, { view: async () => '99.0.0' })
  assert.deepEqual([found.installed, found.latest, found.outdated, found.error], ['0.0.1', '99.0.0', true, null])
  assert.ok(found.changes.length > 0)
  const offline = await packageVersions({ targetRoot: root }, { view: async () => { throw Object.assign(new Error('offline'), { stderr: 'ENOTFOUND' }) } })
  assert.deepEqual([offline.latest, offline.outdated, offline.error], [null, false, 'ENOTFOUND'])
})
