import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { enableConflictRecovery, preparePublish, publishNpmVersion } from '../scripts/prepare-publish.mjs'

const configuration = "// signing and verification stay unchanged\nnew RekorWitness({\n            entryType: options.legacyCompatibility ? 'intoto' : 'dsse',\n            fetchOnConflict: false,\n            retry: options.retry ?? exports.DEFAULT_RETRY,\n});\n"

test('publish preparation changes only conflict recovery and is idempotent', () => {
  const prepared = enableConflictRecovery(configuration)
  assert.equal(prepared, configuration.replace('fetchOnConflict: false', 'fetchOnConflict: true'))
  assert.equal(enableConflictRecovery(prepared), prepared)
  for (const unsupported of ['', configuration.repeat(2), configuration + prepared, configuration.replace('retry:', 'retries:')]) {
    assert.throws(() => enableConflictRecovery(unsupported), /Unsupported Sigstore/)
  }
})

test('publish preparation targets the actual bundled dependency and fails closed on tool drift', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gusta-publish-fixture-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const npmFile = path.join(root, 'package.json')
  const sigstore = path.join(root, 'node_modules', 'sigstore')
  const configFile = path.join(sigstore, 'dist', 'config.js')
  await mkdir(path.dirname(configFile), { recursive: true })
  await mkdir(path.join(root, 'node_modules', 'libnpmpublish'), { recursive: true })
  await writeFile(path.join(root, 'node_modules', 'libnpmpublish', 'index.js'), '')
  await writeFile(npmFile, JSON.stringify({ name: 'npm', version: publishNpmVersion }))
  await writeFile(path.join(sigstore, 'package.json'), JSON.stringify({ name: 'sigstore', version: '4.1.1', main: 'dist/index.js' }))
  await writeFile(path.join(sigstore, 'dist', 'index.js'), '')
  await writeFile(configFile, configuration)
  assert.deepEqual(await preparePublish(root), { npm: publishNpmVersion, sigstore: '4.1.1', conflictRecovery: true })
  assert.deepEqual(await preparePublish(root), { npm: publishNpmVersion, sigstore: '4.1.1', conflictRecovery: true })
  const prepared = await readFile(configFile, 'utf8')
  await writeFile(npmFile, JSON.stringify({ name: 'npm', version: '0.0.0' }))
  await assert.rejects(preparePublish(root), /requires npm/)
  assert.equal(await readFile(configFile, 'utf8'), prepared)
  await writeFile(npmFile, JSON.stringify({ name: 'npm', version: publishNpmVersion }))
  await writeFile(path.join(sigstore, 'package.json'), JSON.stringify({ name: 'sigstore', version: '0.0.0', main: 'dist/index.js' }))
  await assert.rejects(preparePublish(root), /requires bundled sigstore/)
  assert.equal(await readFile(configFile, 'utf8'), prepared)
})

// Run against the real pinned npm installation in the release job. Normal
// consumer tests stay dependency-free and never install publishing tools.
if (process.env.GUSTA_PUBLISH_NPM_ROOT) {
  test('real publishing tools recover a 409 via GET and preserve log evidence; other errors still fail', async (t) => {
    const root = process.env.GUSTA_PUBLISH_NPM_ROOT
    await preparePublish(root)
    const npmRequire = createRequire(path.join(root, 'package.json'))
    const publishRequire = createRequire(npmRequire.resolve('libnpmpublish'))
    const { createBundleBuilder } = publishRequire(path.join(path.dirname(publishRequire.resolve('sigstore')), 'config.js'))
    let mode = 'conflict'
    const requests = []
    const body = Buffer.from(JSON.stringify({ kind: 'dsse', apiVersion: '0.0.1' })).toString('base64')
    const entry = { body, logID: 'ab'.repeat(32), logIndex: 7, integratedTime: 1700000000,
      verification: { signedEntryTimestamp: Buffer.from('signed-log-evidence').toString('base64') } }
    const server = createServer(async (request, response) => {
      for await (const _ of request) { /* consume the proposed entry */ }
      requests.push(`${request.method} ${request.url}`)
      response.setHeader('content-type', 'application/json')
      if (request.method === 'POST') {
        response.statusCode = mode === 'failure' ? 500 : 409
        if (mode !== 'missing-location') response.setHeader('location', '/api/v1/log/entries/existing-entry')
        response.end(JSON.stringify({ message: 'fixture response' }))
      } else if (mode === 'missing-entry') {
        response.statusCode = 404
        response.end('{}')
      } else {
        response.end(JSON.stringify({ 'existing-entry': entry }))
      }
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections() }))
    const builder = createBundleBuilder('dsseEnvelope', {
      rekorURL: `http://127.0.0.1:${server.address().port}`, retry: { retries: 0 }, timeout: 1000,
    })
    assert.equal(builder.witnesses.length, 1)
    const witness = builder.witnesses[0]
    const evidence = await witness.testify({ $case: 'dsseEnvelope', dsseEnvelope: {
      payload: Buffer.from('fixture'), payloadType: 'application/vnd.in-toto+json',
      signatures: [{ sig: Buffer.from('signature'), keyid: '' }],
    } }, 'fixture-public-key')
    assert.deepEqual(requests, ['POST /api/v1/log/entries', 'GET /api/v1/log/entries/existing-entry'])
    assert.equal(evidence.tlogEntries[0].logIndex, '7')
    assert.deepEqual(evidence.tlogEntries[0].canonicalizedBody, Buffer.from(body, 'base64'))
    assert.deepEqual(evidence.tlogEntries[0].inclusionPromise.signedEntryTimestamp, Buffer.from('signed-log-evidence'))
    for (const [failure, code, count] of [
      ['failure', 'TLOG_CREATE_ENTRY_ERROR', 1],
      ['missing-location', 'TLOG_CREATE_ENTRY_ERROR', 1],
      ['missing-entry', 'TLOG_FETCH_ENTRY_ERROR', 2],
    ]) {
      mode = failure
      requests.length = 0
      await assert.rejects(witness.tlogV1.createEntry({}), { code })
      assert.equal(requests.length, count)
    }
  })
}
