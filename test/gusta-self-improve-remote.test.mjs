import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { contractHash, evaluateAttempt, recordAttempt } from '../skills/gusta-self-improve-remote/scripts/experiment.mjs'

const execute = promisify(execFile)
const script = fileURLToPath(new URL('../skills/gusta-self-improve-remote/scripts/experiment.mjs', import.meta.url))
function fixture() {
  const contract = { schemaVersion: 1, metric: { name: 'elapsed', unit: 'ms', direction: 'lower' }, minImprovementPct: 5,
    minSamples: 3, expectedWork: 100, harness: 'harness-v1', workload: 'fixed-input', environment: 'same-runtime', regressionGate: 'behavior-v1' }
  const side = (commit, values) => ({ commit: commit.repeat(40), contractHash: contractHash(contract), evidence: ['raw.json'],
    samples: values.map((value) => ({ value, workCount: 100, errorCount: 0, correct: true })) })
  const attempt = { schemaVersion: 1, id: 'attempt-a', hypothesis: 'Reuse immutable setup', premise: 'Setup dominates this workload',
    baseline: side('a', [99, 100, 101]), candidate: side('b', [79, 80, 81]), gate: { passed: true, evidence: ['checks.log'] } }
  return { contract, attempt }
}
async function temporary(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gusta-improve-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

test('experiment evaluation supports both metric directions and rejects gains within noise', () => {
  const { contract, attempt } = fixture()
  const result = evaluateAttempt(contract, attempt)
  assert.equal(result.verdict, 'keep')
  assert.ok(Math.abs(result.improvementPct - 20) < 1e-10)
  contract.metric.direction = 'higher'
  for (const side of [attempt.baseline, attempt.candidate]) side.contractHash = contractHash(contract)
  assert.equal(evaluateAttempt(contract, attempt).verdict, 'discard')
  attempt.candidate.samples.forEach((sample) => { sample.value += 50 })
  assert.equal(evaluateAttempt(contract, attempt).verdict, 'keep')
  const noisy = fixture()
  noisy.attempt.candidate.samples.forEach((sample, i) => { sample.value = [80, 94, 108][i] })
  assert.equal(evaluateAttempt(noisy.contract, noisy.attempt).verdict, 'inconclusive')
})

test('faster results never pass with less work, errors, wrong output or missing evidence', () => {
  const cases = [
    [(a) => { a.candidate.samples[0].workCount = 99 }, 'discard'],
    [(a) => { a.candidate.samples[0].errorCount = 1 }, 'discard'],
    [(a) => { a.candidate.samples[0].correct = false }, 'discard'],
    [(a) => { a.gate.passed = false }, 'discard'],
    [(a) => { a.candidate.samples[0].correct = null }, 'inconclusive'],
    [(a) => { a.gate.passed = null }, 'inconclusive'],
    [(a) => { a.gate.evidence = [] }, 'inconclusive'],
    [(a) => { a.candidate.evidence = [] }, 'inconclusive'],
    [(a) => { a.candidate.samples.pop() }, 'inconclusive'],
    [(a) => { a.baseline.samples[0].errorCount = 1 }, 'inconclusive'],
    [(a) => { a.candidate.contractHash = 'changed-harness' }, 'inconclusive'],
    [(a) => { a.candidate.commit = a.baseline.commit }, 'inconclusive'],
  ]
  for (const [change, verdict] of cases) {
    const { contract, attempt } = fixture()
    change(attempt)
    assert.equal(evaluateAttempt(contract, attempt).verdict, verdict)
  }
  const { contract, attempt } = fixture()
  attempt.candidate.samples[0].value = -1
  assert.throws(() => evaluateAttempt(contract, attempt))
})

test('experiment history preserves rejections and makes repeated recording idempotent', async (t) => {
  const root = await temporary(t), journal = path.join(root, 'attempts.jsonl')
  const { contract, attempt } = fixture()
  attempt.gate.passed = false
  await recordAttempt(journal, contract, attempt)
  const before = await readFile(journal, 'utf8')
  await recordAttempt(journal, contract, structuredClone(attempt))
  assert.equal(await readFile(journal, 'utf8'), before)
  attempt.gate.passed = true
  await assert.rejects(recordAttempt(journal, contract, attempt))
  assert.equal(await readFile(journal, 'utf8'), before)
  attempt.id = 'attempt-b'
  await recordAttempt(journal, contract, attempt)
  const rows = (await readFile(journal, 'utf8')).trim().split('\n').map(JSON.parse)
  assert.deepEqual(rows.map((row) => row.result.verdict), ['discard', 'keep'])
  assert.equal(rows[0].inputs.attempt.gate.passed, false)
  const checkpoint = await readFile(journal, 'utf8')
  const stale = structuredClone(attempt)
  stale.id = 'attempt-c'
  stale.candidate.commit = 'c'.repeat(40)
  stale.candidate.samples.forEach((sample) => { sample.value += 10 })
  await assert.rejects(recordAttempt(journal, contract, stale))
  assert.equal(await readFile(journal, 'utf8'), checkpoint)
  await recordAttempt(journal, contract, structuredClone(attempt))
  assert.equal(await readFile(journal, 'utf8'), checkpoint)
  const resumed = structuredClone(stale)
  resumed.baseline = structuredClone(attempt.candidate)
  resumed.candidate.samples.forEach((sample) => { sample.value -= 30 })
  assert.equal((await recordAttempt(journal, contract, resumed)).verdict, 'keep')
  contract.workload = 'different-input'
  await assert.rejects(recordAttempt(journal, contract, attempt))
})

test('busy and interrupted journals remain intact and do not admit a new writer', async (t) => {
  const root = await temporary(t), journal = path.join(root, 'attempts.jsonl')
  const { contract, attempt } = fixture()
  await writeFile(`${journal}.lock`, 'another writer')
  await assert.rejects(recordAttempt(journal, contract, attempt))
  assert.equal(await readFile(`${journal}.lock`, 'utf8'), 'another writer')
  await rm(`${journal}.lock`)
  const partial = '{"schemaVersion":1'
  await writeFile(journal, partial)
  await assert.rejects(recordAttempt(journal, contract, attempt))
  assert.equal(await readFile(journal, 'utf8'), partial)
})

test('the packaged command hashes contracts and returns semantic exit codes', async (t) => {
  const root = await temporary(t), contractFile = path.join(root, 'contract.json'), attemptFile = path.join(root, 'attempt.json')
  const { contract, attempt } = fixture()
  await writeFile(contractFile, JSON.stringify(contract))
  const hash = await execute(process.execPath, [script, 'hash', contractFile])
  assert.equal(hash.stdout.trim(), attempt.baseline.contractHash)
  if (process.platform !== 'win32') {
    const alias = path.join(root, 'experiment-alias.mjs')
    await symlink(script, alias)
    const throughAlias = await execute(process.execPath, [alias, 'hash', contractFile])
    assert.equal(throughAlias.stdout.trim(), hash.stdout.trim())
  }
  await writeFile(attemptFile, JSON.stringify(attempt))
  const accepted = await execute(process.execPath, [script, 'evaluate', contractFile, attemptFile, '--journal', path.join(root, 'attempts.jsonl')])
  assert.equal(JSON.parse(accepted.stdout).verdict, 'keep')
  attempt.gate.passed = false
  await writeFile(attemptFile, JSON.stringify(attempt))
  await assert.rejects(execute(process.execPath, [script, 'evaluate', contractFile, attemptFile]), (error) => error.code === 2 && JSON.parse(error.stdout).verdict === 'discard')
  attempt.gate.passed = null
  await writeFile(attemptFile, JSON.stringify(attempt))
  await assert.rejects(execute(process.execPath, [script, 'evaluate', contractFile, attemptFile]), (error) => error.code === 3 && JSON.parse(error.stdout).verdict === 'inconclusive')
})
