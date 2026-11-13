import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fingerprintVerificationCheck, parseVerificationPlan, readVerificationPlan } from '../src/verification-plan.mjs'

const execute = promisify(execFile)
const fixture = async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gusta-check-inputs-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const git = async (...args) => (await execute('git', ['-C', root, ...args])).stdout.trim()
  await git('init', '-q')
  await git('config', 'user.email', 'test@example.invalid')
  await git('config', 'user.name', 'Test')
  await mkdir(path.join(root, 'src'))
  await writeFile(path.join(root, 'src/main.mjs'), 'export const value = 1\n')
  await writeFile(path.join(root, 'package.json'), '{"type":"module"}\n')
  await git('add', '.')
  await git('commit', '-qm', 'initial')
  return { root, git }
}
const plan = (overrides = {}) => parseVerificationPlan({ schemaVersion: 1, checks: [
  { id: 'unit', tier: 'batch', command: 'node --test', inputs: ['src/**', 'package.json'], ...overrides },
] }, { source: 'checks.json' })
const key = (root, value, options = {}) => fingerprintVerificationCheck(root, value, value.checks[0], { env: { MODE: 'test' }, ...options })

test('plan validates stable check identities and preserves CI declarations without inferred shell children', () => {
  const parsed = parseVerificationPlan({ schemaVersion: 1, checks: [
    { id: 'unit', tier: 'task', command: 'node --test && node scripts/check.mjs' },
    { id: 'browser', tier: 'ci', command: 'npm run browser', inputs: ['tests', 'src/**', 'tests'] },
  ] })
  assert.equal(parsed.checks.length, 2)
  assert.equal(parsed.checks[0].command, 'node --test && node scripts/check.mjs')
  assert.deepEqual(parsed.checks[0].inputs, ['.'])
  assert.deepEqual(parsed.checks[1].inputs, ['src/**', 'tests'])
  for (const value of [
    { schemaVersion: 2, checks: [] },
    { schemaVersion: 1, checks: [] },
    { schemaVersion: 1, checks: [{ id: 'unit', tier: 'batch', command: 'true' }, { id: 'unit', tier: 'task', command: 'true' }] },
    { schemaVersion: 1, checks: [{ id: 'unit', tier: 'unknown', command: 'true' }] },
    { schemaVersion: 1, checks: [{ id: 'unit', tier: 'batch', command: 'true', dependency: 'other' }] },
  ]) assert.throws(() => parseVerificationPlan(value), /invalid verification plan/)
  for (const input of ['../secret', 'src/../../secret', '/tmp/secret', 'C:\\secret', ':!src', ':(exclude)src', '.git/config', 'nested/.git/config', 'src\\file', '']) {
    assert.throws(() => plan({ inputs: [input] }), /root-relative Git pathspec/)
  }
})

test('plan source is project-relative and rejects source symlinks escaping the project', async (t) => {
  const { root } = await fixture(t)
  const raw = { schemaVersion: 1, checks: [{ id: 'unit', tier: 'batch', command: 'true' }] }
  await writeFile(path.join(root, 'checks.json'), JSON.stringify(raw))
  assert.equal((await readVerificationPlan(root, 'checks.json')).source, 'checks.json')
  assert.equal((await readVerificationPlan(root, path.join(root, 'checks.json'))).checks[0].id, 'unit')
  await assert.rejects(readVerificationPlan(root, '../checks.json'), /inside the project/)
  await assert.rejects(readVerificationPlan(root, '.git/config'), /Git control/)
  const external = await mkdtemp(path.join(os.tmpdir(), 'gusta-external-plan-'))
  t.after(() => rm(external, { recursive: true, force: true }))
  await writeFile(path.join(external, 'checks.json'), JSON.stringify(raw))
  await symlink(path.join(external, 'checks.json'), path.join(root, 'external.json'))
  await assert.rejects(readVerificationPlan(root, 'external.json'), /inside the project/)
})

test('a selected revision supplies the plan from that same immutable source', async (t) => {
  const { root } = await fixture(t)
  const raw = { schemaVersion: 1, checks: [{ id: 'unit', tier: 'batch', command: 'old-check' }] }
  await writeFile(path.join(root, 'checks.json'), JSON.stringify({ ...raw, checks: [{ ...raw.checks[0], command: 'working-check' }] }))
  const reads = [], selected = await readVerificationPlan(root, 'checks.json', { readSource: async (filename) => {
    reads.push(filename)
    return JSON.stringify(raw)
  } })
  assert.deepEqual(reads, ['checks.json'])
  assert.equal(selected.checks[0].command, 'old-check')
  await assert.rejects(readVerificationPlan(root, 'missing.json', { readSource: async () => null }), /missing from the selected revision/)
})

test('explicit inputs reuse across reporting changes but dependency, new-file and deleted-file changes invalidate', async (t) => {
  const { root, git } = await fixture(t), value = plan()
  const indexBefore = await readFile(path.join(root, '.git/index'))
  const initial = await key(root, value)
  await writeFile(path.join(root, 'report.md'), 'Verification completed.\n')
  assert.equal((await key(root, value)).key, initial.key)
  await writeFile(path.join(root, 'package.json'), '{"type":"module","private":true}\n')
  assert.notEqual((await key(root, value)).key, initial.key)
  await writeFile(path.join(root, 'package.json'), '{"type":"module"}\n')
  assert.equal((await key(root, value)).key, initial.key)
  await writeFile(path.join(root, 'src/new.mjs'), 'export const added = true\n')
  assert.notEqual((await key(root, value)).key, initial.key)
  await unlink(path.join(root, 'src/new.mjs'))
  assert.equal((await key(root, value)).key, initial.key)
  await unlink(path.join(root, 'src/main.mjs'))
  assert.notEqual((await key(root, value)).key, initial.key)
  assert.deepEqual(await readFile(path.join(root, '.git/index')), indexBefore)
  assert.match(await git('status', '--porcelain'), /D src\/main.mjs/)
})

test('a missing declared input invalidates when created and omitted inputs include reporting changes', async (t) => {
  const { root } = await fixture(t), value = plan({ inputs: ['src/**', 'future.json'] })
  const missing = await key(root, value)
  await writeFile(path.join(root, 'future.json'), '{}\n')
  assert.notEqual((await key(root, value)).key, missing.key)
  const conservative = plan({ inputs: undefined }), beforeReport = await key(root, conservative)
  await writeFile(path.join(root, 'report.md'), 'A report is an input unless explicitly excluded.\n')
  assert.notEqual((await key(root, conservative)).key, beforeReport.key)
})

test('check definitions, scope, runtime and effective environment invalidate without exposing secret values', async (t) => {
  const { root } = await fixture(t), value = plan(), initial = await key(root, value)
  for (const options of [
    { scope: { tasks: ['TASK-EXAMPLE'] } },
    { env: { MODE: 'test', TOKEN: 'do-not-persist-this-secret' } },
    { runtime: { node: 'another-runtime' } },
  ]) {
    const changed = await key(root, value, options)
    assert.notEqual(changed.key, initial.key)
    assert.equal(JSON.stringify(changed).includes('do-not-persist-this-secret'), false)
  }
  assert.notEqual((await key(root, plan({ command: 'node --test --test-concurrency=1' }))).key, initial.key)
  assert.notEqual((await key(root, plan({ inputs: ['src/**'] }))).key, initial.key)
  assert.notEqual((await key(root, plan({ id: 'other-unit' }))).key, initial.key)
  const withSibling = { ...value, checks: [...value.checks, { id: 'lint', tier: 'batch', command: 'npm run lint', inputs: ['.'] }] }
  assert.equal((await key(root, withSibling)).key, initial.key)
  assert.equal((await key(root, value, { scope: { b: 2, a: 1 } })).key,
    (await key(root, value, { scope: { a: 1, b: 2 } })).key)
})

test('explicit ignored input files are hashed, while ignored directories must not silently count as covered', async (t) => {
  const { root } = await fixture(t)
  await writeFile(path.join(root, '.gitignore'), '.local-config\n.cache/\n')
  const value = plan({ inputs: ['src/**', '.local-config'] }), absent = await key(root, value)
  await writeFile(path.join(root, '.local-config'), 'secret-one\n')
  const initial = await key(root, value)
  assert.notEqual(initial.key, absent.key)
  await writeFile(path.join(root, '.local-config'), 'secret-two\n')
  const changed = await key(root, value)
  assert.notEqual(changed.key, initial.key)
  assert.equal(JSON.stringify(changed).includes('secret-two'), false)
  await mkdir(path.join(root, '.cache'))
  await writeFile(path.join(root, '.cache/generated.json'), '{}\n')
  await assert.rejects(key(root, plan({ inputs: ['.cache'] })), /ignored directory input/)
  const broad = plan({ inputs: ['.'] }), before = await key(root, broad)
  await writeFile(path.join(root, '.cache/generated.json'), '{"changed":true}\n')
  assert.equal((await key(root, broad)).key, before.key)
})

test('internal symlink referents invalidate selected inputs; external and directory targets cannot produce reusable evidence', async (t) => {
  const { root } = await fixture(t)
  await writeFile(path.join(root, 'shared.json'), '{"value":1}\n')
  await symlink('../shared.json', path.join(root, 'src/config.json'))
  const value = plan(), initial = await key(root, value)
  await writeFile(path.join(root, 'shared.json'), '{"value":2}\n')
  assert.notEqual((await key(root, value)).key, initial.key)
  await symlink(os.tmpdir(), path.join(root, 'src/external'))
  await assert.rejects(key(root, value), /escapes the project input boundary/)
  await assert.rejects(key(root, plan({ inputs: ['src/external/**'] })), /escapes the project input boundary/)
  await unlink(path.join(root, 'src/external'))
  await symlink('../src', path.join(root, 'src/directory'))
  await assert.rejects(key(root, value), /directory symlink input/)
})

test('fingerprint dependencies can supply snapshots without invoking Git', async () => {
  const value = plan({ inputs: ['src/**'] })
  const first = await key('/project', value, { deps: {
    realpath: async (filename) => filename,
    stat: async () => ({ isDirectory: () => true }),
    workingInputs: async () => [{ path: 'src/main.mjs', mode: '100644', hash: 'first' }],
  } })
  const second = await key('/project', value, { deps: {
    realpath: async (filename) => filename,
    stat: async () => ({ isDirectory: () => true }),
    workingInputs: async () => [{ path: 'src/main.mjs', mode: '100644', hash: 'second' }],
  } })
  assert.notEqual(first.key, second.key)
})

test('ref fingerprints use committed bytes and preserve the index even when current input files differ', async (t) => {
  const { root, git } = await fixture(t), value = plan(), ref = await git('rev-parse', 'HEAD')
  const indexBefore = await readFile(path.join(root, '.git/index')), initial = await key(root, value)
  const historical = await key(root, value, { ref })
  assert.equal(historical.verifiable, true)
  assert.equal(historical.inputFingerprint, initial.inputFingerprint)
  await writeFile(path.join(root, 'src/main.mjs'), 'export const value = 2\n')
  await writeFile(path.join(root, 'src/new.mjs'), 'export const added = true\n')
  await writeFile(path.join(root, 'package.json'), '{"changed":true}\n')
  assert.notEqual((await key(root, value)).inputFingerprint, historical.inputFingerprint)
  assert.equal((await key(root, value, { ref })).inputFingerprint, historical.inputFingerprint)
  assert.deepEqual(await readFile(path.join(root, '.git/index')), indexBefore)
})

test('ref fingerprints distinguish declared bookkeeping inputs while reusing explicitly excluded changes', async (t) => {
  const { root, git } = await fixture(t)
  await mkdir(path.join(root, 'spec'))
  await writeFile(path.join(root, 'spec/STATE.md'), 'initial state\n')
  await git('add', '.')
  await git('commit', '-qm', 'record state')
  const before = await git('rev-parse', 'HEAD')
  await writeFile(path.join(root, 'spec/STATE.md'), 'changed state\n')
  await git('add', '.')
  await git('commit', '-qm', 'close state')
  const after = await git('rev-parse', 'HEAD'), included = plan({ inputs: ['src/**', 'spec/STATE.md'] }), excluded = plan({ inputs: ['src/**'] })
  assert.notEqual((await key(root, included, { ref: before })).inputFingerprint, (await key(root, included, { ref: after })).inputFingerprint)
  assert.equal((await key(root, excluded, { ref: before })).inputFingerprint, (await key(root, excluded, { ref: after })).inputFingerprint)
})

test('historical literal non-Git input is unverifiable and never replaced with present ignored bytes', async (t) => {
  const { root, git } = await fixture(t), ref = await git('rev-parse', 'HEAD')
  await writeFile(path.join(root, '.gitignore'), '.local-config\n')
  await writeFile(path.join(root, '.local-config'), 'present-secret\n')
  const value = plan({ inputs: ['src/**', '.local-config'] }), historical = await key(root, value, { ref })
  assert.equal(historical.verifiable, false)
  assert.equal(historical.inputFingerprint, null)
  assert.equal(historical.key, null)
  assert.equal((await key(root, value)).verifiable, true)
  assert.equal(JSON.stringify(historical).includes('present-secret'), false)
  await unlink(path.join(root, '.local-config'))
  assert.equal((await key(root, value, { ref })).verifiable, false)
})

test('historical symlink targets come from the selected ref rather than the current filesystem', async (t) => {
  const { root, git } = await fixture(t)
  await writeFile(path.join(root, 'shared.json'), '{"value":1}\n')
  await symlink('../shared.json', path.join(root, 'src/config.json'))
  await git('add', '.')
  await git('commit', '-qm', 'record linked input')
  const before = await git('rev-parse', 'HEAD'), value = plan({ inputs: ['src/**'] }), original = await key(root, value)
  assert.equal((await key(root, value, { ref: before })).inputFingerprint, original.inputFingerprint)
  await writeFile(path.join(root, 'shared.json'), '{"value":2}\n')
  assert.equal((await key(root, value, { ref: before })).inputFingerprint, original.inputFingerprint)
  await git('add', '.')
  await git('commit', '-qm', 'change linked input')
  assert.notEqual((await key(root, value, { ref: 'HEAD' })).inputFingerprint, original.inputFingerprint)
  await symlink('../untracked.json', path.join(root, 'src/local.json'))
  await git('add', 'src/local.json')
  await git('commit', '-qm', 'record non-Git target')
  await writeFile(path.join(root, 'untracked.json'), '{}\n')
  assert.equal((await key(root, value, { ref: 'HEAD' })).verifiable, false)
})
