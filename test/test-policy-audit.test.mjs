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
