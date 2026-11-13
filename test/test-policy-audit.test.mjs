import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, realpath, symlink, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { upgradeContext } from '../src/upgrade-context.mjs'
import { auditTestPolicy, readAuditTimings } from '../src/test-policy-audit.mjs'

async function fixture(t) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'gusta-test-policy-'))), root = path.join(directory, 'project')
  await mkdir(root); t.after(() => rm(directory, { recursive: true, force: true }))
  return { root, directory, put: async (name, content) => { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), content) },
    inspect: async () => ({ targetRoot: root, git: null }) }
}

test('update inventory always includes a cited test audit queue with actual script/config observations, not a semantic verdict', async (t) => {
  const { root, put, inspect } = await fixture(t)
  await put('package.json', JSON.stringify({ scripts: { test: 'node --test', e2e: 'playwright test', check: 'npm test && npm run e2e', 'release:check': 'npm test' }, privateValue: 'never-return-package-secret' }, null, 2))
  await put('.github/workflows/check.yml', 'jobs:\n  verify:\n    steps:\n      - run: npm run check\n')
  await put('.github/workflows/release.yml', 'jobs:\n  publish:\n    steps:\n      - run: npm run release:check\n')
  await put('spec/checks.json', JSON.stringify({ schemaVersion: 1, checks: [{ id: 'verify', tier: 'batch', command: 'npm run check', inputs: ['src/**'] }] }))
  await put('spec/ssot/ARCH.md', '# ARCH\n- Supported browsers: Chrome\n')
  await put('playwright.config.ts', "export default {projects:[{name:'chromium'},{name:'firefox'},{name:'webkit'},{name:'msedge'}]}\n")
  await put('test/source.test.mjs', "const source = readFileSync('component.js', 'utf8'); assert.match(source, /render/);\n")
  await put('.env', 'TOKEN=never-return-environment-secret')
  const result = await upgradeContext({ targetRoot: root }, { inspect })
  assert.equal(result.ok, true); assert.equal(result.testPolicy.required, true); assert.equal(result.testPolicy.policyReviewed, false); assert.equal(result.coverage.policyReviewed, false)
  const kinds = new Set(result.testPolicy.candidates.map((entry) => entry.kind))
  for (const kind of ['browser-matrix', 'local-browser-check', 'repeated-ci-check', 'local-ci-overlap', 'source-assertion-review']) assert.ok(kinds.has(kind), kind)
  assert.deepEqual(result.testPolicy.supportedBrowsers.declared, ['chrome'])
  assert.deepEqual(result.testPolicy.candidates.find((entry) => entry.kind === 'browser-matrix').outsideDeclaredSupport, ['firefox', 'webkit', 'msedge'])
  assert.ok(result.testPolicy.candidates.every((entry) => entry.classification === 'unknown' && entry.sources.length))
  assert.equal(result.testPolicy.counts.testFiles, 1); assert.equal(result.testPolicy.checks[0].inputDeclaration, 'explicit')
  assert.ok(!JSON.stringify(result).includes('never-return-package-secret')); assert.ok(!JSON.stringify(result).includes('never-return-environment-secret'))
})

test('audit follows actual declared wider browser policy and leaves source-string tests as review candidates', () => {
  const sources = [
    { path: 'spec/ssot/ARCH.md', kind: 'policy', text: 'Supported browsers: Chrome, Firefox', sha256: 'policy' },
    { path: 'playwright.config.js', kind: 'test-config', text: "projects: [{name:'chromium'}, {name:'firefox'}]", sha256: 'config' },
    { path: 'test/contract.test.js', kind: 'test', text: 'readFile(path); assert.match(source, contract)', sha256: 'test' },
  ]
  const result = auditTestPolicy(sources)
  assert.deepEqual(result.candidates.find((entry) => entry.kind === 'browser-matrix').outsideDeclaredSupport, [])
  assert.equal(result.candidates.find((entry) => entry.kind === 'source-assertion-review').recommendation, 'unknown')
  assert.equal(result.policyReviewed, false)
})

test('known measurement samples are linked to exact commands without exposing commands or inventing savings', () => {
  const command = 'run-private-check --credential=never-return-command-secret'
  const result = auditTestPolicy([{ path: 'checks.json', kind: 'json', sha256: 'checks', text: JSON.stringify({ schemaVersion: 1, checks: [{ id: 'bounded', tier: 'batch', command }] }) }], {
    timings: { available: true, entries: { [`final\0${command}`]: { samples: [100, 250] } } },
  })
  assert.deepEqual(result.checks[0].timing, { samples: 2, totalMs: 350, maxMs: 250 })
  assert.equal(result.timings.checksWithSamples, 1); assert.ok(!JSON.stringify(result).includes('never-return-command-secret'))
})

test('symlink boundaries cannot contribute external browser configuration or timing bytes', async (t) => {
  const { root, directory, inspect } = await fixture(t), outside = path.join(directory, 'outside')
  await mkdir(outside); await writeFile(path.join(outside, 'config.ts'), "projects: [{name:'firefox'}, {name:'webkit'}]")
  await symlink(path.join(outside, 'config.ts'), path.join(root, 'playwright.config.ts'))
  const inventory = await upgradeContext({ targetRoot: root }, { inspect })
  assert.equal(inventory.testPolicy.sources.length, 0)
  const common = path.join(root, '.git'); await mkdir(common); await symlink(outside, path.join(common, 'gusta'))
  let opens = 0
  const timings = await readAuditTimings({ git: { commonDir: common } }, { open: () => { opens++; throw new Error('must not open') } })
  assert.equal(timings.available, false); assert.equal(timings.reason, 'runtime-boundary'); assert.equal(opens, 0)
})

test('bounded representative tests stay explicitly partial while preserving the full inventory count', async (t) => {
  const { root, put, inspect } = await fixture(t)
  for (let index = 0; index < 26; index++) await put(`test/case${String(index).padStart(2, '0')}.test.js`, 'assert.equal(actual, expected)\n')
  const result = await upgradeContext({ targetRoot: root }, { inspect })
  assert.equal(result.testPolicy.counts.testFiles, 26); assert.equal(result.testPolicy.counts.sampledTests, 24); assert.equal(result.testPolicy.sourceComplete, false)
  assert.ok(result.testPolicy.unknowns.some((value) => value.includes('partial')))
  assert.equal(await readFile(path.join(root, 'test/case00.test.js'), 'utf8'), 'assert.equal(actual, expected)\n')
})

test('existing safe runtime measurements are available while malformed records remain unknown', async (t) => {
  const { root, put } = await fixture(t)
  const value = { schemaVersion: 1, entries: { 'final\0npm test': { samples: [120] } } }
  await put('.git/gusta/v1/timings.json', JSON.stringify(value))
  const workspace = { git: { commonDir: path.join(root, '.git') } }
  const known = await readAuditTimings(workspace)
  assert.equal(known.available, true); assert.deepEqual(known.entries, value.entries)
  await put('.git/gusta/v1/timings.json', '{broken')
  const unknown = await readAuditTimings(workspace)
  assert.equal(unknown.available, false); assert.equal(unknown.reason, 'unreadable-timings')
})


const supportPolicy = (overrides = {}, status = 'o', extra = '') => {
  const fields = { 'product-stage': 'alpha', 'supported-browsers': 'Chrome latest stable', 'supported-platforms': 'web primary environment',
    'supported-app-versions': 'none', 'excluded-support': 'other browsers and previous versions',
    'support-review': 'before beta or first external users', 'validation-baseline': 'browser build-a in fixed image-a', ...overrides }
  return '# ARCH\n> r1 | architecture | all\n\n## decisions\n- ARCH-1 [' + status + '] Product support\n' +
    Object.entries(fields).filter(([, value]) => value !== undefined).map(([key, value]) => '  - ' + key + ': ' + value).join('\n') + '\n' + extra
}
const auditSupport = (text, extra = [], attributes = {}) => auditTestPolicy([
  { path: 'spec/ssot/ARCH.md', kind: 'policy', text, sha256: 'policy', ...attributes }, ...extra,
])

test('approved stage policy supplies current support, fixed baseline and review without accepting proposals or history', () => {
  const source = supportPolicy({}, 'o', '\n- ARCH-2 [?] Proposed wider support\n  - product-stage: beta\n  - supported-browsers: Firefox\n\n## chg\n- Former supported browsers: Safari\n')
  const result = auditSupport(source, [{ path: 'playwright.config.ts', kind: 'test-config', text: "projects: [{name:'chrome'}, {name:'firefox'}]", sha256: 'config' }])
  const policy = result.productSupport
  assert.equal(policy.declared, true); assert.equal(policy.complete, true); assert.equal(policy.stage, 'alpha')
  assert.equal(policy.fields['validation-baseline'], 'browser build-a in fixed image-a')
  assert.equal(policy.fields['support-review'], 'before beta or first external users')
  assert.equal(policy.recommendation.compatibility, 'no-broad-matrix-by-default')
  assert.deepEqual(result.supportedBrowsers.declared, ['chrome']); assert.deepEqual(result.supportedBrowsers.recommended, ['chrome'])
  assert.deepEqual(result.candidates.find((candidate) => candidate.kind === 'browser-matrix').outsideDeclaredSupport, ['firefox'])
  assert.ok(policy.sources.every((source) => source.decision === 'ARCH-1' && source.path === 'spec/ssot/ARCH.md'))
  assert.equal(source.split('\n')[policy.sources.find((source) => source.field === 'product-stage').line - 1], '  - product-stage: alpha')
  assert.equal(result.policyReviewed, false)
})

test('open, rejected, fenced and historical stage text never becomes an approved stage or browser recommendation', () => {
  for (const status of ['?', 'x']) {
    const result = auditSupport(supportPolicy({}, status, '\n## chg\n- product-stage: production\n- Supported browsers: Firefox\n'), [
      { path: 'package.json', kind: 'package', text: '{"version":"1.0.0"}', sha256: 'package' },
    ])
    assert.equal(result.productSupport.stage, null); assert.equal(result.productSupport.declared, false)
    assert.equal(result.productSupport.recommendation, null); assert.equal(result.supportedBrowsers.recommended, null)
  }
  const fence = String.fromCharCode(96).repeat(3)
  const result = auditSupport('# ARCH\n## decisions\n- ARCH-1 [o] A documentation example\n  ' + fence + '\n  - product-stage: prototype\n  - supported-browsers: Firefox\n  ' + fence + '\n## chg\n- product-stage: alpha\n')
  assert.equal(result.productSupport.stage, null); assert.equal(result.productSupport.sources.length, 0)
  const example = auditSupport('# ARCH\n## decisions\n' + fence + 'markdown\n- ARCH-1 [o] Example only\n  - product-stage: alpha\n  - supported-browsers: Firefox\n' + fence + '\n')
  assert.equal(example.productSupport.stage, null); assert.equal(example.supportedBrowsers.recommended, null)
  const withExample = auditSupport(supportPolicy({}, 'o', '\n' + fence + 'markdown\n- ARCH-1 [o] Example only\n  - product-stage: production\n  - supported-browsers: Firefox\n' + fence + '\n'))
  assert.equal(withExample.productSupport.stage, 'alpha'); assert.deepEqual(withExample.supportedBrowsers.declared, ['chrome'])
})

test('ambiguous, invalid or partial policy requires a decision instead of selecting a convenient stage', () => {
  const cases = [
    [supportPolicy({}, 'o', '\n- ARCH-2 [o] Another policy\n  - product-stage: production\n'), {}, 'multiple-approved-support-decisions'],
    [supportPolicy({}, 'o', '  - product-stage: production\n'), {}, 'duplicate-field:product-stage'],
    [supportPolicy({ 'product-stage': 'preview' }), {}, 'invalid-or-missing-product-stage'],
    [supportPolicy(), { truncated: true }, 'partial-policy-source'],
    [supportPolicy({}, 'o', '\n- ARCH-1 [o] Duplicate ID\n  - product-stage: production\n'), {}, 'duplicate-arch-decisions'],
    [supportPolicy({}, 'o', '\n- ARCH-2 [approved] Malformed policy\n  - product-stage: production\n'), {}, 'malformed-support-decision'],
  ]
  for (const [text, attributes, issue] of cases) {
    const policy = auditSupport(text, [], attributes).productSupport
    assert.equal(policy.declared, false); assert.equal(policy.stage, null); assert.ok(policy.issues.includes(issue), issue)
    assert.ok(policy.missing.includes('product-stage'))
  }
})

test('native OS and app-client windows remain distinct and non-web targets gain no browser matrix', () => {
  const native = auditSupport(supportPolicy({ 'product-stage': 'prototype', 'supported-browsers': 'none',
    'supported-platforms': 'native iOS and Android; latest stable OS on both selected targets',
    'supported-app-versions': 'current client build only' })).productSupport
  assert.match(native.fields['supported-platforms'], /iOS and Android/)
  assert.equal(native.fields['supported-app-versions'], 'current client build only')
  assert.deepEqual(native.recommendation.browsers, []); assert.equal(native.recommendation.appVersions, 'current client build only')
  const cli = auditSupport(supportPolicy({ 'supported-browsers': undefined, 'supported-platforms': 'API and CLI; selected runtime', 'supported-app-versions': 'none' }))
  assert.deepEqual(cli.productSupport.recommendation.browsers, []); assert.deepEqual(cli.supportedBrowsers.recommended, [])
  assert.ok(cli.productSupport.missing.includes('supported-browsers'))
  const noBrowsers = auditSupport(supportPolicy({ 'supported-browsers': 'none — CLI does not use Chrome or Firefox', 'supported-platforms': 'API and CLI' }), [
    { path: 'playwright.config.ts', kind: 'test-config', text: "projects: [{name:'chrome'}, {name:'firefox'}]", sha256: 'config' },
  ])
  assert.deepEqual(noBrowsers.supportedBrowsers.declared, []); assert.deepEqual(noBrowsers.supportedBrowsers.recommended, [])
  assert.deepEqual(noBrowsers.productSupport.recommendation.browsers, [])
  assert.deepEqual(noBrowsers.candidates.find((candidate) => candidate.kind === 'browser-matrix').outsideDeclaredSupport, ['chrome', 'firefox'])
  const undecided = auditSupport(supportPolicy({ 'supported-browsers': 'unknown' }))
  assert.equal(undecided.supportedBrowsers.declared, null); assert.deepEqual(undecided.productSupport.recommendation.browsers, ['chrome'])
  assert.equal(undecided.productSupport.complete, false)
})

test('early recommendations and mature stages preserve explicitly agreed wider support', () => {
  for (const stage of ['alpha', 'beta', 'production']) {
    const result = auditSupport(supportPolicy({ 'product-stage': stage, 'supported-browsers': 'Chrome and Firefox supported window',
      'supported-platforms': 'web and native; existing agreed OS window', 'supported-app-versions': 'current and previous supported client' }))
    assert.deepEqual(result.supportedBrowsers.declared, ['chrome', 'firefox'])
    assert.deepEqual(result.supportedBrowsers.recommended, ['chrome', 'firefox'])
    assert.equal(result.productSupport.fields['supported-platforms'], 'web and native; existing agreed OS window')
    assert.equal(result.productSupport.recommendation.appVersions, 'current and previous supported client')
    assert.equal(result.productSupport.recommendation.preserveDeclaredSupport, true)
  }
  const opaque = auditSupport(supportPolicy({ 'supported-browsers': 'existing agreed browser set' }))
  assert.equal(opaque.supportedBrowsers.declared, null); assert.equal(opaque.productSupport.recommendation.browsers, null)
})

test('audit exposes only declared support fields and citations, and separates unresolved baseline from another policy choice', () => {
  const result = auditSupport(supportPolicy({ 'validation-baseline': 'unresolved until setup' }, 'o', '  - private note: never-return-private-policy-body\n'))
  assert.equal(result.productSupport.declared, true); assert.equal(result.productSupport.complete, false)
  assert.deepEqual(result.productSupport.missing, ['validation-baseline'])
  assert.equal(result.productSupport.stage, 'alpha')
  assert.equal(result.productSupport.fields['support-review'], 'before beta or first external users')
  assert.ok(!JSON.stringify(result).includes('never-return-private-policy-body'))
  const historical = auditTestPolicy([{ path: 'spec/history/ARCH.md', kind: 'policy', text: supportPolicy(), sha256: 'old' }])
  assert.equal(historical.productSupport.stage, null)
})
