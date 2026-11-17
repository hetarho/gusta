import test from 'node:test'
import { runVibeCheck, vibeLoop } from './helpers/unit-policy.mjs'
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fixture, git, archiveTask } from './helpers/vibe-fixture.mjs'

// A failing gate that leaves evidence outside the checkout of every real run.
async function gate(t) {
  const context = await fixture(t)
  const runs = path.join(context.temporary, 'runs.txt')
  await writeFile(runs, '')
  const failing = 'node -e \'require("fs").appendFileSync(process.env.GATE_RUNS,"x");console.log("FAIL e2e checkout");process.exit(1)\''
  const check = (options = {}, command = failing) => runVibeCheck({ targetRoot: context.root, tier: 'batch', env: { GATE_RUNS: runs }, ...options }, command)
  return { ...context, check, count: async () => (await readFile(runs, 'utf8')).length }
}

test('every requested full gate runs, and a failure points to a targeted fix', async (t) => {
  const { check, count, initial } = await gate(t)
  for (let i = 1; i <= 4; i++) {
    const failed = await check()
    assert.deepEqual([failed.ok, failed.exitCode], [false, 1])
    assert.equal(await count(), i)
    assert.match(failed.next[0], /FAIL|failedTests/)
    assert.ok(failed.next.some((line) => line.includes(`vibe check --tier task --diff-base ${initial}`)))
    assert.ok(failed.next.some((line) => /inbox add --kind suggest/.test(line)))
  }
  assert.equal((await check({}, 'node -e "0"')).ok, true)
  await assert.rejects(check({ tag: 'not valid!' }), /세션 tag/)
})

test('the loop host repairs on its own and workers and reviewers stay off the full gate', async (t) => {
  const { root } = await fixture(t, 1)
  const seen = []
  const result = await vibeLoop({ targetRoot: root, tag: 'loop01', provider: 'codex', maxUnits: 1, verify: ['node --check app.js', 'node --version'] }, {
    preflight: async () => ({ ok: true, checks: [] }),
    execute: async () => {
      await archiveTask(root, 'T001')
      await writeFile(path.join(root, 'app.js'), 'export const =\n')
      await git(root, 'add', 'spec', 'app.js'); await git(root, 'commit', '-qm', 'broken implementation')
      return { exitCode: 0, result: { kind: 'task', id: 'T001', outcome: 'completed', pushed: false, next: '' } }
    },
    check: async (config, command) => { const checked = await runVibeCheck(config, command); seen.push({ config, checked }); return checked },
    push: () => assert.fail('a failed gate must not publish'),
  })
  assert.equal(result.ok, false)
  assert.deepEqual(seen.map(({ config }) => [config.tag, config.host]), [['loop01', true], ['loop01', true]])
  assert.ok(seen.every(({ checked }) => !checked.next), 'the loop queues its own repair')
  assert.equal(result.gate.failures, 1)
  const runtime = path.join(root, '.git/gusta/v1')
  await mkdir(runtime, { recursive: true })
  await writeFile(path.join(runtime, 'state.json'), JSON.stringify({ schemaVersion: 1, groups: {}, attempts: { example: { workspace: root } } }))
  await assert.rejects(runVibeCheck({ targetRoot: root, tier: 'batch' }, 'node --version'), /조정자\/호스트/)
  await assert.rejects(runVibeCheck({ targetRoot: root, tier: 'group', env: { GUSTA_VIBE_UNIT: '1' } }, 'node --version'), /조정자\/호스트/)
})

test('vibe check -- keeps each argument whole: sh -c with a cd runs in that directory', async (t) => {
  const { root } = await fixture(t)
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const { fileURLToPath } = await import('node:url')
  await mkdir(path.join(root, 'module'), { recursive: true })
  const cli = fileURLToPath(new URL('../bin/gusta.mjs', import.meta.url))
  const run = (...words) => promisify(execFile)(process.execPath, [cli, 'vibe', 'check', '--tier', 'task', '--no-cache', '--target', root, '--', ...words], { encoding: 'utf8' })
  await run('sh', '-c', "cd module && pwd > ../where.txt && echo 'it''s'")
  assert.equal((await readFile(path.join(root, 'where.txt'), 'utf8')).trim(), await (await import('node:fs/promises')).realpath(path.join(root, 'module')))
  // One word stays a shell command string, as before.
  await run('cd module && pwd > ../single.txt')
  assert.match(await readFile(path.join(root, 'single.txt'), 'utf8'), /module/)
})
