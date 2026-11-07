import { createHash } from 'node:crypto'
import { appendFile, mkdir, open, readFile, realpath, unlink } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const fail = (message) => { throw new Error(message) }
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const number = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0
const text = (value) => typeof value === 'string' && value.trim() && !/^<[^>]*>$/.test(value.trim())
const evidence = (value) => Array.isArray(value) && value.every(text)
const canonical = (value) => JSON.stringify(value, (_, entry) => object(entry)
  ? Object.fromEntries(Object.keys(entry).sort().map((key) => [key, entry[key]])) : entry)
const digest = (value) => `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`

export function contractHash(contract) {
  if (!object(contract) || contract.schemaVersion !== 1 || !object(contract.metric)) fail('Invalid contract schema.')
  if (![contract.metric.name, contract.metric.unit].every(text) || !['lower', 'higher'].includes(contract.metric.direction)) fail('Invalid metric.')
  if (!number(contract.minImprovementPct) || !Number.isSafeInteger(contract.minSamples) || contract.minSamples < 2) fail('Invalid improvement threshold or sample count.')
  if (!Number.isSafeInteger(contract.expectedWork) || contract.expectedWork <= 0) fail('expectedWork must be a positive integer.')
  if (!['harness', 'workload', 'environment', 'regressionGate'].every((key) => text(contract[key]))) fail('Replace contract fingerprints before freezing the contract.')
  return digest(contract)
}

function validateAttempt(attempt) {
  if (!object(attempt) || attempt.schemaVersion !== 1 || ![attempt.id, attempt.hypothesis, attempt.premise].every(text)) fail('Invalid attempt identity, hypothesis or premise.')
  for (const key of ['baseline', 'candidate']) {
    const side = attempt[key]
    if (!object(side) || !/^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(side.commit ?? '') || !text(side.contractHash) || !evidence(side.evidence) || !Array.isArray(side.samples)) fail(`Invalid ${key} provenance or samples.`)
    for (const sample of side.samples) {
      if (!object(sample) || !number(sample.value) || !Number.isSafeInteger(sample.workCount) || sample.workCount < 0 || !Number.isSafeInteger(sample.errorCount) || sample.errorCount < 0 || ![true, false, null].includes(sample.correct)) fail(`Invalid ${key} sample; correctness must be true, false or null.`)
    }
  }
  if (!object(attempt.gate) || ![true, false, null].includes(attempt.gate.passed) || !evidence(attempt.gate.evidence)) fail('Invalid fast regression gate evidence.')
}

function summarize(samples) {
  if (!samples.length) return { count: 0, median: null, min: null, max: null, spreadPct: null }
  const values = samples.map((sample) => sample.value).sort((a, b) => a - b)
  const mid = Math.floor(values.length / 2)
  const median = values.length % 2 ? values[mid] : values[mid - 1] / 2 + values[mid] / 2
  const min = values[0], max = values.at(-1)
  const spreadPct = median > 0 ? (max - min) / median * 100 : null
  return { count: values.length, median, min, max, spreadPct: Number.isFinite(spreadPct) ? spreadPct : null }
}

export function evaluateAttempt(contract, attempt) {
  const hash = contractHash(contract)
  validateAttempt(attempt)
  const baseline = summarize(attempt.baseline.samples), candidate = summarize(attempt.candidate.samples)
  let improvementPct = null, thresholdPct = null
  const result = (verdict, reason) => ({ schemaVersion: 1, id: attempt.id, contractHash: hash, verdict, reason,
    baseline, candidate, improvementPct, thresholdPct })
  const sides = [attempt.baseline, attempt.candidate]
  if (sides.some((side) => side.contractHash !== hash)) return result('inconclusive', 'Measurement contracts differ; start a separate comparison.')
  if (attempt.baseline.commit === attempt.candidate.commit) return result('inconclusive', 'The same commit does not establish a changed candidate.')
  const invalid = (sample) => sample.errorCount > 0 || sample.workCount !== contract.expectedWork || sample.correct === false
  if (attempt.baseline.samples.some(invalid)) return result('inconclusive', 'The baseline did not complete the required correct work.')
  if (attempt.candidate.samples.some(invalid)) return result('discard', 'The candidate errored, omitted work or produced an incorrect result.')
  if (attempt.gate.passed === false) return result('discard', 'The fast regression gate failed.')
  if (sides.some((side) => side.samples.length < contract.minSamples || !side.evidence.length || side.samples.some((sample) => sample.correct === null)) || attempt.gate.passed !== true || !attempt.gate.evidence.length) return result('inconclusive', 'Required samples, correctness or execution evidence are missing.')
  if (baseline.median <= 0 || candidate.median <= 0 || baseline.spreadPct === null || candidate.spreadPct === null) return result('inconclusive', 'Relative comparison needs positive, measurable medians and finite spread.')
  improvementPct = (1 - candidate.median / baseline.median) * (contract.metric.direction === 'lower' ? 100 : -100)
  if (!Number.isFinite(improvementPct)) { improvementPct = null; return result('inconclusive', 'The relative change is not finite.') }
  thresholdPct = Math.max(contract.minImprovementPct, baseline.spreadPct, candidate.spreadPct)
  if (improvementPct <= 0) return result('discard', 'The metric did not improve.')
  if (improvementPct <= thresholdPct + 1e-10) return result('inconclusive', 'The gain does not exceed the frozen threshold and observed spread.')
  return result('keep', 'The local gain exceeds the threshold with complete work and a passing fast gate.')
}

export async function recordAttempt(journal, contract, attempt) {
  const result = evaluateAttempt(contract, attempt)
  const inputHash = digest({ contract, attempt })
  const file = path.resolve(journal), lock = `${file}.lock`
  await mkdir(path.dirname(file), { recursive: true })
  let owner
  try { owner = await open(lock, 'wx') }
  catch (error) { if (error.code === 'EEXIST') fail('Journal is busy; verify its writer before retrying.'); throw error }
  try {
    await owner.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }))
    const content = await readFile(file, 'utf8').catch((error) => { if (error.code === 'ENOENT') return ''; throw error })
    if (content && !content.endsWith('\n')) fail('Journal has an incomplete final line; preserve it for recovery.')
    const rows = content ? content.slice(0, -1).split('\n').map((line) => JSON.parse(line)) : []
    if (rows.some((row) => !object(row) || row.schemaVersion !== 1 || !text(row.id) || !object(row.inputs) || !object(row.inputs.attempt) || row.inputs.attempt.id !== row.id || digest(row.inputs) !== row.inputHash || !object(row.result))) fail('Invalid journal entry; preserve it for recovery.')
    if (rows.some((row) => row.contractHash !== result.contractHash)) fail('The frozen contract changed; use a separate journal and preserve the original.')
    const previous = rows.find((row) => row.id === attempt.id)
    if (previous) {
      if (previous.inputHash !== inputHash) fail('Attempt ID already records different inputs; use a new ID.')
      return { ...result, recorded: false }
    }
    const best = rows.findLast((row) => row.result.verdict === 'keep')
    const expectedBaseline = best?.inputs.attempt.candidate.commit ?? rows[0]?.inputs.attempt.baseline.commit
    if (expectedBaseline && attempt.baseline.commit !== expectedBaseline) fail('Baseline is not the recorded best candidate; measure from the current best before recording.')
    const row = { schemaVersion: 1, id: attempt.id, at: new Date().toISOString(), contractHash: result.contractHash,
      inputHash, inputs: { contract, attempt }, result }
    await appendFile(file, `${JSON.stringify(row)}\n`)
    return { ...result, recorded: true }
  } finally {
    await owner.close()
    await unlink(lock)
  }
}

async function main(args) {
  const [action, contractFile, attemptFile, option, journal] = args
  if (!contractFile || !['hash', 'evaluate'].includes(action) || (action === 'hash' && args.length !== 2) || (action === 'evaluate' && (!attemptFile || ![3, 5].includes(args.length) || (args.length === 5 && (option !== '--journal' || !journal))))) fail('Usage: experiment.mjs hash <contract.json> | evaluate <contract.json> <attempt.json> [--journal <attempts.jsonl>]')
  const contract = JSON.parse(await readFile(contractFile, 'utf8'))
  if (action === 'hash') { process.stdout.write(`${contractHash(contract)}\n`); return }
  const attempt = JSON.parse(await readFile(attemptFile, 'utf8'))
  const result = journal ? await recordAttempt(journal, contract, attempt) : evaluateAttempt(contract, attempt)
  process.stdout.write(`${JSON.stringify(result)}\n`)
  process.exitCode = { keep: 0, discard: 2, inconclusive: 3 }[result.verdict]
}

const entry = process.argv[1] && await realpath(process.argv[1]).catch(() => null)
if (entry && entry === await realpath(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
}
