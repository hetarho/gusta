import assert from 'node:assert/strict'
import test from 'node:test'
import { MANIFESTS, nextVersion, bumpGate, bumpLevel, versionOnly, planBump, versionBump, beyondVersion, confirmedDecisions } from '../src/version-bump.mjs'
import { effectiveSettings, branchPlan } from '../src/settings.mjs'

const [npm] = MANIFESTS
const [lock] = npm.companions
const ssot = (...ids) => `# CORE core\n> r1 | core\n\n## decisions\n${ids.map((id) => `- ${id} [o] rule`).join('\n')}\n\n## chg\n- r1 261101 initial\n`
const pkg = (version) => `{\n  "name": "example",\n  "version": "${version}"\n}\n`

// A fake repository: commit → { path: text }. versionSetAt answers from `anchors` (version → commit).
function repo(commits, anchors = {}) {
  const calls = []
  return { calls,
    read: async (commit, file) => commits[commit]?.[file] ?? null,
    changed: async (from, to) => [...new Set([...Object.keys(commits[from]), ...Object.keys(commits[to])])].filter((file) => commits[from][file] !== commits[to][file]),
    docs: async (commit, files) => files.map((file) => commits[commit]?.[file] ?? ''),
    versionSetAt: async (commit, file, marker) => { calls.push([commit, file, marker]); return anchors[marker] ?? null } }
}

test('다음 버전: X.Y.Z만 올리고 minor는 patch를 0으로, 그 밖의 표기는 올리지 않는다', () => {
  assert.equal(nextVersion('1.2.3', 'patch'), '1.2.4')
  assert.equal(nextVersion('1.2.3', 'minor'), '1.3.0')
  assert.equal(nextVersion('0.0.0', 'patch'), '0.0.1')
  assert.equal(nextVersion('10.99.99', 'minor'), '10.100.0')
  for (const odd of ['1.2', '1.2.3-beta.1', '1.2.3+build', 'v1.2.3', '01.2.3', '', null, undefined, 123]) assert.equal(nextVersion(odd, 'patch'), null, String(odd))
})

test('설정 관문: off·미정·land-via pr·운영 브랜치 없음은 올리지 않고, deploy가 있으면 deploy 때만 올린다', () => {
  const gate = (text, command, branch = 'feat') => {
    const values = Object.fromEntries(effectiveSettings(text).settings.map((entry) => [entry.key, entry.value]))
    return bumpGate(values, branchPlan(values, { branch, defaultBranch: 'trunk' }), command)
  }
  const settings = (...lines) => `# SETTINGS\n${lines.map((line) => `- ${line}\n`).join('')}`
  assert.equal(gate(null, 'push'), 'unset')
  assert.equal(gate(settings('land: trunk'), 'push'), 'unset')
  assert.equal(gate(settings('land: trunk', 'version: off'), 'push'), 'off')
  assert.equal(gate(settings('land: trunk', 'version: auto'), 'push'), null)
  assert.equal(gate(settings('land: trunk', 'push: true', 'version: auto'), 'push'), null)
  for (const command of ['push', 'deploy']) assert.equal(gate(settings('land: trunk', 'land-via: pr', 'deploy: live', 'version: auto'), command), 'land-via-pr')
  // The release branch is deploy: landing on the integration branch is not a release.
  assert.equal(gate(settings('land: next', 'deploy: trunk', 'version: auto'), 'push'), 'on-deploy')
  assert.equal(gate(settings('land: next', 'deploy: trunk', 'version: auto'), 'deploy'), null)
  // No branch the CLI moves: land current or undecided without a deploy branch.
  assert.equal(gate(settings('land: current', 'push: true', 'version: auto'), 'push'), 'no-release-branch')
  assert.equal(gate(settings('version: auto'), 'push'), 'no-release-branch')
  assert.equal(gate(settings('land: current', 'deploy: trunk', 'version: auto'), 'deploy'), null)
  // deploy naming land itself: land is the release branch.
  assert.equal(gate(settings('land: trunk', 'deploy: trunk', 'version: auto'), 'push'), null)
})

test('수준 판정: 변화 없음·운영 브랜치 없음·사람이 올린 버전은 건너뛰고, 새로 확정된 결정 ID면 minor 아니면 patch', () => {
  const facts = { base: 'b', head: 'h', changed: ['src/a.js'], baseVersion: '1.2.3', headVersion: '1.2.3', knownDecisions: ['CORE-1'], headDecisions: ['CORE-1'] }
  assert.deepEqual(bumpLevel(facts), { level: 'patch', from: '1.2.3', to: '1.2.4' })
  assert.deepEqual(bumpLevel({ ...facts, headDecisions: ['CORE-1', 'CORE-2'] }), { level: 'minor', from: '1.2.3', to: '1.3.0' })
  // A removed or reordered decision is not a new one.
  assert.equal(bumpLevel({ ...facts, knownDecisions: ['CORE-1', 'CORE-2'], headDecisions: ['CORE-2'] }).level, 'patch')
  assert.deepEqual(bumpLevel({ ...facts, base: null }), { skipped: 'no-base' })
  assert.deepEqual(bumpLevel({ ...facts, base: 'h' }), { skipped: 'unchanged' })
  // A person already changed the version in the landed range — a major included: it stands.
  assert.deepEqual(bumpLevel({ ...facts, headVersion: '2.0.0', headDecisions: ['CORE-1', 'CORE-2'] }), { skipped: 'manual', from: '1.2.3', to: '2.0.0' })
  assert.deepEqual(bumpLevel({ ...facts, baseVersion: null }), { skipped: 'manual', from: null, to: '1.2.3' })
  assert.deepEqual(bumpLevel({ ...facts, baseVersion: null, headVersion: null }), { skipped: 'no-manifest' })
  assert.deepEqual(bumpLevel({ ...facts, baseVersion: '1.0.0-rc.1', headVersion: '1.0.0-rc.1' }), { skipped: 'unsupported-version', from: '1.0.0-rc.1' })
  // Bookkeeping alone (STATE, task files, reports, work records) is not a release.
  assert.deepEqual(bumpLevel({ ...facts, changed: ['spec/STATE.md', 'spec/tasks/done/T001.a.md', 'spec/reports/261101-ab12.md', 'spec/work/x.json'] }), { skipped: 'bookkeeping-only' })
  assert.equal(bumpLevel({ ...facts, changed: ['spec/STATE.md', 'spec/ssot/CORE.md'] }).level, 'patch')
  assert.equal(bumpLevel({ ...facts, changed: ['docs/guide.md'] }).level, 'patch')
})

test('매니페스트 편집: 버전 값의 바이트만 바뀌고 들여쓰기·줄 끝·키 순서·다른 version 키는 그대로다', () => {
  const texts = [
    '{\n  "name": "example",\n  "version": "1.2.3",\n  "scripts": { "version": "echo 1.2.3" },\n  "dependencies": { "left": "1.2.3" }\n}\n',
    '{\r\n\t"private" : true,\r\n\t"config": {"version": "1.2.3", "list": [{"version": "1.2.3"}, "1.2.3"]},\r\n\t"version"\t:\t"1.2.3" ,\r\n\t"name": "example"\r\n}',
    '{"description":"say \\"version\\": \\"1.2.3\\" — 한글 \\u00e9 \\\\","version":"1.2.3","name":"example"}',
    '\n\n  {  "z": [1, 2.5e3, true, false, null, {}, []], "version": "1.2.3"  }  \n\n',
  ]
  for (const text of texts) {
    assert.equal(npm.version(text), '1.2.3')
    const edited = npm.edit(text, '1.3.0')
    assert.equal(JSON.parse(edited).version, '1.3.0')
    assert.deepEqual({ ...JSON.parse(edited), version: '1.2.3' }, JSON.parse(text))
    assert.deepEqual(Object.keys(JSON.parse(edited)), Object.keys(JSON.parse(text)))
    // Exactly one occurrence changed, and changing it back gives the original bytes.
    assert.equal(edited.length, text.length)
    assert.equal([...edited].filter((char, index) => char !== text[index]).length, 2)
    assert.equal(npm.edit(edited, '1.2.3'), text)
    assert.equal(npm.edit(text, '1.2.3'), text)
    assert.ok(versionOnly('package.json', text, edited))
  }
  assert.equal(npm.marker(texts[0]), '"version": "1.2.3"')
  assert.equal(npm.marker(texts[1]), '"version"\t:\t"1.2.3"')
  assert.equal(npm.edit(texts[0], '10.0.0').length, texts[0].length + 1)
  // Nothing this cannot rewrite safely is touched: not JSON, no string version, a repeated key.
  for (const text of ['', 'not json', '[]', '{"name": "x"}', '{"version": 3}', '{"version": null}', '\ufeff{"version": "1.2.3"}', '{"version": "1.2.3", "version": "1.2.3"}']) {
    assert.equal(npm.edit(text, '9.9.9'), null, text)
  }
  for (const text of ['', 'not json', '{"name": "x"}', '{"version": 3}']) { assert.equal(npm.version(text), null); assert.equal(npm.marker(text), null) }
})

test('lock 동기화: 최상위 version과 packages[""].version만 따라가고 의존성 버전은 그대로다', () => {
  const text = '{\n\t"name": "example",\n\t"version": "1.2.3",\n\t"lockfileVersion": 3,\n\t"packages": {\n\t\t"": {\n\t\t\t"name": "example",\n\t\t\t"version": "1.2.3",\n\t\t\t"dependencies": { "left": "^1.2.3" }\n\t\t},\n\t\t"node_modules/left": {\n\t\t\t"version": "1.2.3",\n\t\t\t"resolved": "https://registry.example/left-1.2.3.tgz"\n\t\t}\n\t}\n}\n'
  const edited = lock.edit(text, '1.2.4')
  assert.equal(edited, text.replace('"version": "1.2.3",\n\t"lockfileVersion"', '"version": "1.2.4",\n\t"lockfileVersion"').replace('"name": "example",\n\t\t\t"version": "1.2.3"', '"name": "example",\n\t\t\t"version": "1.2.4"'))
  const after = JSON.parse(edited)
  assert.deepEqual([after.version, after.packages[''].version, after.packages['node_modules/left'].version], ['1.2.4', '1.2.4', '1.2.3'])
  assert.ok(versionOnly('package-lock.json', text, edited))
  // An old lock without packages[""], or a root package without a version: only what exists follows.
  assert.equal(lock.edit('{"version": "1.2.3", "dependencies": {"left": {"version": "1.2.3"}}}', '2.0.0'), '{"version": "2.0.0", "dependencies": {"left": {"version": "1.2.3"}}}')
  assert.equal(lock.edit('{"version": "1.2.3", "packages": {"": {"name": "x"}, "a": {"version": "1.2.3"}}}', '2.0.0'), '{"version": "2.0.0", "packages": {"": {"name": "x"}, "a": {"version": "1.2.3"}}}')
  // More than the version changed, or another file: not a version-only change.
  assert.ok(!versionOnly('package-lock.json', text, edited.replace('^1.2.3', '^1.3.0')))
  assert.ok(!versionOnly('package.json', pkg('1.0.0'), pkg('1.0.1').replace('example', 'other')))
  assert.ok(!versionOnly('package.json', pkg('1.0.0'), null)); assert.ok(!versionOnly('package.json', null, pkg('1.0.0')))
  assert.ok(!versionOnly('src/package.json', pkg('1.0.0'), pkg('1.0.1')))
})

test('계획: 매니페스트와 추적 중인 lock을 함께 올리고, lock이 없으면 매니페스트만 올린다', async () => {
  const lockText = '{"name": "example", "version": "1.0.0", "packages": {"": {"version": "1.0.0"}}}\n'
  const commits = { b: { 'package.json': pkg('1.0.0'), 'package-lock.json': lockText, 'src/a.js': '1' }, h: { 'package.json': pkg('1.0.0'), 'package-lock.json': lockText, 'src/a.js': '2' } }
  assert.deepEqual(await planBump({ base: 'b', head: 'h' }, repo(commits)), { level: 'patch', from: '1.0.0', to: '1.0.1',
    files: { 'package.json': pkg('1.0.1'), 'package-lock.json': '{"name": "example", "version": "1.0.1", "packages": {"": {"version": "1.0.1"}}}\n' } })
  delete commits.b['package-lock.json']; delete commits.h['package-lock.json']
  assert.deepEqual((await planBump({ base: 'b', head: 'h' }, repo(commits))).files, { 'package.json': pkg('1.0.1') })
  // A lock that cannot be rewritten byte for byte stops the whole bump: the two must not drift apart.
  commits.h['package-lock.json'] = 'not json'
  assert.deepEqual(await planBump({ base: 'b', head: 'h' }, repo(commits)), { skipped: 'no-manifest' })
})

test('계획: 건너뛰는 이유 — 변화 없음·운영 브랜치 없음·매니페스트 없음·사람이 올린 버전·기록만 바뀜', async () => {
  const commits = {
    b: { 'package.json': pkg('1.0.0'), 'src/a.js': '1', 'spec/STATE.md': 'one' },
    h: { 'package.json': pkg('1.0.0'), 'src/a.js': '2', 'spec/STATE.md': 'one' },
    manual: { 'package.json': pkg('2.0.0'), 'src/a.js': '2', 'spec/STATE.md': 'one' },
    notes: { 'package.json': pkg('1.0.0'), 'src/a.js': '1', 'spec/STATE.md': 'two' },
    bare: { 'src/a.js': '1' }, bare2: { 'src/a.js': '2' },
    unversioned: { 'package.json': '{"name": "example"}\n', 'src/a.js': '3' },
    added: { 'package.json': pkg('0.1.0'), 'src/a.js': '2' },
  }
  const plan = (base, head) => planBump({ base, head }, repo(commits))
  assert.deepEqual(await plan(null, 'h'), { skipped: 'no-base' })
  assert.deepEqual(await plan('h', 'h'), { skipped: 'unchanged' })
  assert.deepEqual(await plan('b', 'manual'), { skipped: 'manual', from: '1.0.0', to: '2.0.0' })
  assert.deepEqual(await plan('b', 'notes'), { skipped: 'bookkeeping-only' })
  assert.deepEqual(await plan('bare', 'bare2'), { skipped: 'no-manifest' })
  assert.deepEqual(await plan('b', 'unversioned'), { skipped: 'no-manifest' })
  // A manifest that first appears in the landed range keeps the version its author gave it.
  assert.deepEqual(await plan('bare', 'added'), { skipped: 'manual', from: null, to: '0.1.0' })
})

test('계획: 새 결정은 현재 버전이 정해진 커밋부터 센다 — 기획 커밋이 운영 브랜치에 먼저 올라가 있어도 minor', async () => {
  const commits = {
    v: { 'package.json': pkg('1.0.0'), 'spec/ssot/CORE.md': ssot('CORE-1'), 'src/a.js': '1' },
    // The planning commit reached the release branch on its own (plan-push): base already holds CORE-2.
    b: { 'package.json': pkg('1.0.0'), 'spec/ssot/CORE.md': ssot('CORE-1', 'CORE-2'), 'src/a.js': '1' },
    h: { 'package.json': pkg('1.0.0'), 'spec/ssot/CORE.md': ssot('CORE-1', 'CORE-2'), 'src/a.js': '2' },
    other: { 'package.json': pkg('0.9.0'), 'spec/ssot/CORE.md': ssot(), 'src/a.js': '0' },
  }
  const since = repo(commits, { '"version": "1.0.0"': 'v' })
  assert.deepEqual(await planBump({ base: 'b', head: 'h' }, since), { level: 'minor', from: '1.0.0', to: '1.1.0', files: { 'package.json': pkg('1.1.0') } })
  assert.deepEqual(since.calls, [['b', 'package.json', '"version": "1.0.0"']])
  // Unknown history (or an answer that does not hold this version) falls back to base: a patch.
  assert.equal((await planBump({ base: 'b', head: 'h' }, repo(commits))).level, 'patch')
  assert.equal((await planBump({ base: 'b', head: 'h' }, repo(commits, { '"version": "1.0.0"': 'other' }))).level, 'patch')
  // A decision new in the landed range itself, in a document that did not exist before.
  commits.h2 = { ...commits.h, 'spec/ssot/AUTH.md': ssot('AUTH-1').replace('CORE', 'AUTH') }
  assert.equal((await planBump({ base: 'b', head: 'h2' }, repo(commits))).level, 'minor')
  // Rewording a decision, or text outside ## decisions, adds no ID.
  commits.h3 = { ...commits.h, 'spec/ssot/CORE.md': ssot('CORE-1', 'CORE-2').replace('CORE-2 [o] rule', 'CORE-2 [o] reworded').replace('- r1 261101 initial', '- r2 261102 CORE-9 mentioned\n- r1 261101 initial') }
  assert.equal((await planBump({ base: 'b', head: 'h3' }, repo(commits))).level, 'patch')
})

test('계획: 확정([o])된 결정만 minor로 센다 — 열린 [?]·기각 [x]는 새 ID여도 patch, [?]가 [o]로 확정되면 minor', async () => {
  const doc = (...lines) => `# CORE core\n> r1 | core\n\n## decisions\n${lines.map((line) => `- ${line}`).join('\n')}\n\n## chg\n- r1 261101 initial\n`
  assert.deepEqual(confirmedDecisions(doc('CORE-1 [o] rule', 'CORE-2 [?] cache: memory or disk', 'CORE-3 [x] no cache', 'CORE-4 [o] retries: 3\n  - CORE-9 [o] not a decision head')), ['CORE-1', 'CORE-4'])
  const at = (text) => ({ 'package.json': pkg('1.0.0'), 'spec/ssot/CORE.md': text, 'src/a.js': text })
  const commits = {
    b: at(doc('CORE-1 [o] rule')),
    open: at(doc('CORE-1 [o] rule', 'CORE-2 [?] cache: memory or disk')),
    rejected: at(doc('CORE-1 [o] rule', 'CORE-2 [x] cache: none')),
    confirmed: at(doc('CORE-1 [o] rule', 'CORE-2 [o] cache: memory')),
    reopened: at(doc('CORE-1 [?] rule')),
  }
  const level = async (base, head) => (await planBump({ base, head }, repo(commits))).level
  // A question written down, or an option turned down, releases no new rule.
  assert.equal(await level('b', 'open'), 'patch')
  assert.equal(await level('b', 'rejected'), 'patch')
  // Absent at the base and confirmed at head, or open at the base and confirmed at head: minor.
  assert.equal(await level('b', 'confirmed'), 'minor')
  assert.equal(await level('open', 'confirmed'), 'minor')
  assert.equal(await level('rejected', 'confirmed'), 'minor')
  // A confirmed decision that is reopened, rejected or stays confirmed is not a new one.
  assert.equal(await level('confirmed', 'open'), 'patch')
  assert.equal(await level('confirmed', 'rejected'), 'patch')
  assert.equal(await level('b', 'reopened'), 'patch')
  // Measured from the commit that set the version: open there, confirmed in a planning commit that
  // reached the release branch ahead of the code.
  assert.equal((await planBump({ base: 'confirmed', head: 'landed' }, repo({ ...commits, landed: { ...commits.confirmed, 'src/a.js': 'code' } }, { '"version": "1.0.0"': 'open' }))).level, 'minor')
})

test('커밋: 올릴 때만 head 위에 하나 만들고, 건너뛰면 만들지 않는다', async () => {
  const commits = { b: { 'package.json': pkg('1.0.0'), 'src/a.js': '1' }, h: { 'package.json': pkg('1.0.0'), 'src/a.js': '2' } }
  const made = []
  const commit = async (...args) => { made.push(args); return 'bumped' }
  assert.deepEqual(await versionBump('/repo', { base: 'b', head: 'h' }, { ...repo(commits), commit }), { commit: 'bumped', version: { level: 'patch', from: '1.0.0', to: '1.0.1' } })
  assert.deepEqual(made, [['/repo', 'h', 'chore: bump version to 1.0.1', { 'package.json': pkg('1.0.1') }]])
  assert.deepEqual(await versionBump('/repo', { base: 'h', head: 'h' }, { ...repo(commits), commit }), { commit: null, version: { skipped: 'unchanged' } })
  assert.equal(made.length, 1)
})

test('검증 이후 변경: 버전 값만 바뀐 매니페스트는 코드 변경으로 세지 않는다', async () => {
  const commits = { v: { 'package.json': pkg('1.0.0'), 'src/a.js': '1' }, bumped: { 'package.json': pkg('1.0.1'), 'src/a.js': '1' }, edited: { 'package.json': pkg('1.0.1').replace('example', 'other'), 'src/a.js': '2' } }
  assert.deepEqual(await beyondVersion('/repo', 'v', 'bumped', ['package.json'], repo(commits)), [])
  assert.deepEqual(await beyondVersion('/repo', 'v', 'edited', ['package.json', 'src/a.js'], repo(commits)), ['package.json', 'src/a.js'])
})
