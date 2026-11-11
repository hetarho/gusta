import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fixture } from './helpers/vibe-fixture.mjs'
import { vibeCIWait, githubRepository, workflowPathsSkipped } from '../src/vibe-ci.mjs'
const sha = 'a'.repeat(40)
function clock() { let now = 0; const sleeps = []; return { sleeps, now: () => now, sleep: async (ms) => { sleeps.push(ms); now += ms } } }
const fakeGit = async (_, args) => args[0] === 'rev-parse' ? sha : args[0] === 'diff' ? 'src/app.js\n' : 'git@github.com:owner/project.git\n'
const response = (body, status = 200) => ({ ok: status === 200, status, json: async () => body, text: async () => body })
const options = (root) => ({ targetRoot: root, repo: 'owner/project', branch: 'main', timeoutMs: 300000, noRunMs: 30000, pollMs: 1000, env: {} })

test('repository parsing and conservative paths filters handle docs-only pushes', () => {
  assert.equal(githubRepository('git@github.com:owner/project.git'), 'owner/project')
  assert.equal(githubRepository('https://github.com/owner/project.git'), 'owner/project')
  const yaml = "on:\n  push:\n    branches: [main]\n    paths-ignore:\n      - 'spec/**'\n      - 'docs/**'\n      - '**.md'\n  pull_request:\n    paths: ['app/**']\n"
  assert.equal(workflowPathsSkipped(yaml, ['spec/STATE.md', 'docs/file.txt']), true)
  assert.equal(workflowPathsSkipped(yaml, ['src/app.js']), false)
  assert.equal(workflowPathsSkipped("on:\n  push:\n    paths: ['src/**']\n", ['docs/page.md']), true)
  assert.equal(workflowPathsSkipped("on:\n  push:\n    paths: ['!src/**']\n", ['docs/page.md']), null)
})

for (const conclusion of ['success', 'failure']) test(`gh CI ${conclusion} returns job conclusions and failed step names`, async (t) => {
  const { root } = await fixture(t)
  const time = clock(); let calls = 0
  const result = await vibeCIWait(options(root), { ...time, git: fakeGit, execute: async (command, args) => {
    assert.equal(command, 'gh'); calls++
    const data = args[1].includes('/jobs?') ? { jobs: [{ name: 'checks', status: 'completed', conclusion, html_url: 'https://github.com/owner/project/actions/runs/1/job/2', steps: [{ name: 'Test regression', conclusion }] }] }
      : { workflow_runs: [{ id: 1, head_sha: sha, head_branch: 'main', status: 'completed', conclusion, html_url: 'https://github.com/owner/project/actions/runs/1' }] }
    return { stdout: JSON.stringify(data) }
  }, fetch: () => assert.fail('gh succeeded') })
  assert.equal(result.outcome, conclusion); assert.equal(result.ok, conclusion === 'success')
  assert.equal(result.jobs[0].name, 'checks')
  assert.deepEqual(result.jobs[0].failedSteps, conclusion === 'failure' ? ['Test regression'] : [])
  assert.equal(calls, 2); assert.equal(result.polls, 1)
})

test('token API falls back to public HTML after rate limit; no unauthenticated API is ever called', async (t) => {
  const { root } = await fixture(t); const time = clock(), addresses = []
  const result = await vibeCIWait({ ...options(root), env: { GITHUB_TOKEN: 'fake-test-token' } }, { ...time, git: fakeGit, execute: async () => { throw new Error('no gh') }, fetch: async (url, init) => {
    addresses.push(url)
    if (url.startsWith('https://api.github.com/')) { assert.ok(init.headers.Authorization); return response('', 403) }
    assert.equal(init.headers.Authorization, undefined)
    if (url.includes('/job/')) return response('<div data-job-status="completed" data-conclusion="success"></div>')
    if (url.endsWith('/runs/1')) return response(`<a href="/owner/project/commit/${sha}">commit</a><a href="/owner/project/actions/runs/1/job/2">checks</a>`)
    return response('<a href="/owner/project/actions/runs/1">run</a>')
  } })
  assert.equal(result.ok, true); assert.equal(result.transport, 'public-html')
  assert.equal(addresses.filter((url) => url.startsWith('https://api.')).length, 1)
})

test('public HTML failure extracts a failed step without reading authenticated logs', async (t) => {
  const { root } = await fixture(t)
  const result = await vibeCIWait(options(root), { ...clock(), git: fakeGit, execute: async () => { throw new Error('missing') }, fetch: async (url) => {
    if (url.includes('/job/')) return response('<div data-job-status="completed" data-conclusion="failure"><div data-conclusion="failure" data-step-name="Unit tests"></div></div>')
    if (url.endsWith('/runs/1')) return response(`${sha}<a href="/owner/project/actions/runs/1/job/2">checks</a>`)
    return response('<a href="/owner/project/actions/runs/1">run</a>')
  } })
  assert.equal(result.outcome, 'failure'); assert.ok(result.jobs[0].failedSteps.includes('Unit tests'))
})

test('no run is skipped within grace; a stale run for another SHA is not success', async (t) => {
  const { root } = await fixture(t); const time = clock()
  const result = await vibeCIWait(options(root), { ...time, git: fakeGit, execute: async () => { throw new Error('missing') }, fetch: async (url) => response(url.endsWith('/runs/1') ? `${'b'.repeat(40)}` : '<a href="/owner/project/actions/runs/1">old</a>') })
  assert.equal(result.outcome, 'skipped'); assert.equal(result.reason, 'no-run-within-grace')
  assert.equal(result.polls, 2); assert.deepEqual(time.sleeps, [60000])
})

test('workflow paths-ignore skips before making any HTTP/API call', async (t) => {
  const { root } = await fixture(t)
  await mkdir(path.join(root, '.github/workflows'), { recursive: true })
  await writeFile(path.join(root, '.github/workflows/ci.yml'), "on:\n  push:\n    paths-ignore: ['spec/**', 'docs/**', '**.md']\n")
  const result = await vibeCIWait(options(root), { ...clock(), git: async (root, args) => args[0] === 'diff' ? 'spec/STATE.md' : fakeGit(root, args), execute: () => assert.fail('no CI'), fetch: () => assert.fail('no CI') })
  assert.equal(result.reason, 'workflow-paths'); assert.equal(result.polls, 0)
})

test('CI nobody can read (no gh, no token, page closed) ends unchecked after the grace instead of holding the work', async (t) => {
  const { root } = await fixture(t); const time = clock()
  const result = await vibeCIWait({ ...options(root), timeoutMs: 3600000 }, { ...time, git: fakeGit, execute: async () => { throw new Error('missing') }, fetch: async () => response('not found', 404) })
  assert.equal(result.outcome, 'unchecked'); assert.equal(result.reason, 'no-ci-access'); assert.equal(result.ok, true)
  assert.equal(result.checkUrl, `https://github.com/owner/project/commit/${sha}`)
  assert.equal(result.polls, 2); assert.deepEqual(time.sleeps, [60000])
})

test('an outage after CI was read terminates on timeout rather than claiming unchecked, skipped or success', async (t) => {
  const { root } = await fixture(t); const time = clock(); let listings = 0
  const result = await vibeCIWait({ ...options(root), timeoutMs: 240000 }, { ...time, git: fakeGit, execute: async () => { throw new Error('missing') }, fetch: async (url) => {
    if (url.includes('/actions?')) return ++listings === 1 ? response('<a href="/owner/project/actions/runs/1">run</a>') : response('rate limited', 429)
    return response(`${sha}<div data-job-status="in_progress"></div>`)
  } })
  assert.equal(result.ok, false); assert.equal(result.outcome, 'timed_out')
  assert.equal(time.sleeps.reduce((a, b) => a + b), 240000)
})

test('a checkout without a GitHub remote reports CI unchecked without any request', async (t) => {
  const { root } = await fixture(t)
  await mkdir(path.join(root, '.github/workflows'), { recursive: true })
  await writeFile(path.join(root, '.github/workflows/ci.yml'), 'on: push\n')
  const noRemote = async (_, args) => { if (args[0] === 'remote') throw new Error('no such remote'); return fakeGit(_, args) }
  const result = await vibeCIWait({ ...options(root), repo: undefined }, { ...clock(), git: noRemote, execute: () => assert.fail('no CI'), fetch: () => assert.fail('no CI') })
  assert.deepEqual([result.ok, result.outcome, result.reason, result.polls], [true, 'unchecked', 'no-github-repo', 0])
})

test('a failing step inside an unfinished public job never marks that job completed', async (t) => {
  const { publicJobResult } = await import('../src/vibe-ci.mjs')
  const pending = publicJobResult('<div data-job-status="in_progress"><span data-conclusion="failure" data-step-name="tests"></span></div>', {})
  assert.equal(pending.conclusion, null)
  const unknown = publicJobResult('<div data-job-status="completed"><span data-conclusion="success"></span><span data-conclusion="failure"></span></div>', {})
  assert.equal(unknown.conclusion, null)
})

test('github.com job pages carry the job result only in header text', async () => {
  const { publicJobResult, publicJobs } = await import('../src/vibe-ci.mjs')
  // Shape of the live markup: a multi-line <check-steps> without a job conclusion,
  // status icons labelled "failed: ", and the result word in the job header span.
  const page = (word, step) => `<svg class="octicon" aria-label="${word === 'failed' ? 'failed' : 'completed successfully'}: " role="img"></svg>
<span class="d-block f6 js-updatable-content"
  data-url="/owner/project/runs/2/header">
    ${word}
    <relative-time datetime="2026-01-01T00:00:00Z">Jan 1</relative-time> in 4m 5s
</span>
<check-steps
  class="js-socket-channel"
  data-job-status="completed"
  data-use-actions-ux>
  <check-step
    data-name="Run tests"
    data-conclusion="${step}"></check-step>
</check-steps>`
  const passed = publicJobResult(page('succeeded', 'success'), {})
  assert.equal(passed.conclusion, 'success'); assert.deepEqual(passed.failedSteps, [])
  const failed = publicJobResult(page('failed', 'failure'), {})
  assert.equal(failed.conclusion, 'failure'); assert.deepEqual(failed.failedSteps, ['Run tests'])
  assert.equal(publicJobResult(page('started', 'success').replace('"completed"', '"in_progress"'), {}).conclusion, null)
  assert.equal(publicJobs('<a href="/owner/project/actions/runs/1/job/2" class="x">\n  check\n</a>', 'owner/project')[0].name, 'check')
})
