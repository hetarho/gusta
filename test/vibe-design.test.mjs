import test from 'node:test'
import { runVibeCheck } from './helpers/unit-policy.mjs'
import assert from 'node:assert/strict'
import { readFile, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fixture, git, execute } from './helpers/vibe-fixture.mjs'
import { vibeDesign } from '../src/vibe-design.mjs'
import { vibeStatus } from '../src/vibe.mjs'
import { lintSpec } from '../src/spec-lint.mjs'
import { vibeBrief } from '../src/vibe-brief.mjs'

const cli = fileURLToPath(new URL('../bin/gusta.mjs', import.meta.url))

test('디자인 중 상태는 checkout 로컬이다: STATE를 바꾸지 않고 다른 worktree에 보이지 않는다', async (t) => {
  const { root, temporary } = await fixture(t, 1)
  const state = await readFile(path.join(root, 'spec/STATE.md'), 'utf8')
  await vibeDesign({ targetRoot: root, step: 'start', tag: 'k3f9', scope: 'landing hero' })
  assert.equal(await readFile(path.join(root, 'spec/STATE.md'), 'utf8'), state)
  assert.equal(await git(root, 'status', '--porcelain'), '')
  const stored = JSON.parse(await readFile(path.join(root, '.git/gusta-interactive.json'), 'utf8'))
  assert.equal(stored.design.tag, 'k3f9')
  // A planning commit in this checkout carries nothing of the design to the planning branch.
  const planned = state.replace('## next', '## next\n- gusta-create-task ARCH')
  assert.notEqual(planned, state)
  await writeFile(path.join(root, 'spec/STATE.md'), planned)
  await git(root, 'commit', '-qam', 'plan')
  assert.equal(await git(root, 'show', 'HEAD:spec/STATE.md'), planned.trimEnd())
  const other = path.join(temporary, 'other')
  await git(root, 'worktree', 'add', '-q', '-b', 'other', other)
  const status = await vibeStatus({ targetRoot: other, fetch: false })
  assert.equal(status.design, null)
  assert.notEqual(status.route, 'design')
  assert.equal((await vibeDesign({ targetRoot: other })).design, null)
  assert.equal((await vibeStatus({ targetRoot: root, fetch: false })).route, 'design')
})

test('lint: 0.8.0의 STATE ## design 섹션은 경고로 정리를 요구한다', async (t) => {
  const { root, state } = await fixture(t, 1)
  await writeFile(path.join(root, 'spec/STATE.md'), state.replace('## ssot', '## design\n- since:2026-10-30T01:00Z | tag:k3f9 | scope:-\n\n## ssot'))
  const lint = await lintSpec({ targetRoot: root })
  assert.ok(lint.warnings.some((warning) => /STATE ## design/.test(warning)))
  assert.deepEqual(lint.errors.filter((error) => /design/.test(error)), [])
})

test('vibe design: 시작·재개·status route·끝 — 커밋은 하지 않는다', async (t) => {
  const { root } = await fixture(t, 1)
  const head = await git(root, 'rev-parse', 'HEAD')
  const started = await vibeDesign({ targetRoot: root, step: 'start', tag: 'k3f9', scope: '  landing\n hero ' })
  assert.equal(started.resumed, false)
  assert.match(started.design.since, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$/)
  assert.equal(started.design.scope, 'landing hero')
  const status = await vibeStatus({ targetRoot: root, fetch: false })
  assert.equal(status.route, 'design')
  assert.deepEqual(status.design, started.design)
  // A later conversation resumes the same design, keeping since and tag.
  const resumed = await vibeDesign({ targetRoot: root, step: 'start', tag: 'zz99' })
  assert.deepEqual(resumed.design, started.design)
  assert.equal(resumed.resumed, true)
  assert.equal((await vibeDesign({ targetRoot: root, step: 'start', tag: 'zz99', scope: 'pricing table' })).design.scope, 'pricing table')
  assert.equal(await git(root, 'rev-parse', 'HEAD'), head)
  const ended = await vibeDesign({ targetRoot: root, step: 'end' })
  assert.equal(ended.ended, true)
  assert.equal((await vibeDesign({ targetRoot: root })).design, null)
  assert.equal(await git(root, 'status', '--porcelain'), '')
  assert.equal((await vibeStatus({ targetRoot: root, fetch: false })).route, 'implementation')
  await assert.rejects(vibeDesign({ targetRoot: root, step: 'start', tag: 'x' }), /세션 tag/)
  await assert.rejects(vibeDesign({ targetRoot: root, step: 'publish' }), /vibe design/)
})

test('vibe design verify: 미커밋 디자인의 task 검사만 실행하고 batch·CI는 공동 마감으로 미룬다', async (t) => {
  const { root, temporary } = await fixture(t, 1)
  const runs = path.join(temporary, 'runs.txt')
  const script = (name, fails) => `require('fs').appendFileSync(${JSON.stringify(runs)}, '${name}\\n');process.exit(${fails ? "require('fs').existsSync('broken') ? 1 : 0" : '0'})\n`
  await writeFile(path.join(root, 'fast.js'), script('fast', true))
  await writeFile(path.join(root, 'slow.js'), script('slow', false))
  await writeFile(path.join(root, 'ci.js'), script('ci', false))
  const arch = path.join(root, 'spec/ssot/ARCH.md')
  await writeFile(arch, (await readFile(arch, 'utf8')).replace('task, before done: `node --version`', 'task, before done: `node fast.js`').replace('batch, before code push: `node --version`', 'batch, before code push: `node slow.js`').replace('  - CI, after push: GitHub Actions.', '  - CI, after push: GitHub Actions.\n    - `node ci.js`'))
  await git(root, 'add', '-A'); await git(root, 'commit', '-q', '-m', 'checks')
  const head = await git(root, 'rev-parse', 'HEAD')
  await vibeDesign({ targetRoot: root, step: 'start', tag: 'k3f9' })
  await writeFile(path.join(root, 'app.css'), 'h1 { color: tomato }\n')
  await writeFile(path.join(root, 'broken'), '')
  const count = async () => (await readFile(runs, 'utf8').catch(() => '')).split('\n').filter(Boolean)
  const failed = await vibeDesign({ targetRoot: root, step: 'verify' })
  assert.equal(failed.ok, false)
  assert.deepEqual(failed.results.map((result) => [result.command, result.tier, result.ok]), [['node fast.js', 'task', false]])
  assert.deepEqual(failed.skipped, [])
  assert.deepEqual(failed.deferred, [{ tier: 'batch', command: 'node slow.js', reason: 'shared-integration' }, { tier: 'ci', command: 'node ci.js', reason: 'ci-only' }])
  assert.equal(failed.finalVerified, false)
  assert.equal(failed.tree, null)
  await rm(path.join(root, 'broken'))
  const passed = await vibeDesign({ targetRoot: root, step: 'verify' })
  assert.equal(passed.ok, true)
  assert.deepEqual(passed.results.map((result) => [result.command, result.tier, result.ok, result.cached]), [['node fast.js', 'task', true, false]])
  assert.deepEqual([passed.scope, passed.finalVerified, passed.tree], ['local-design', false, null])
  assert.equal(passed.design.tag, 'k3f9')
  assert.deepEqual(await count(), ['fast', 'fast'])
  // Only the same local task check is cached; no final proof is produced.
  assert.ok((await vibeDesign({ targetRoot: root, step: 'verify' })).results.every((result) => result.cached))
  assert.equal((await count()).length, 2)
  const override = await vibeDesign({ targetRoot: root, step: 'verify', verify: ['node --version'] })
  assert.deepEqual(override.results.map((result) => result.command), ['node fast.js'])
  assert.deepEqual(override.deferred.filter(({ tier }) => tier === 'batch').map(({ command }) => command), ['node --version'])
  assert.deepEqual(await count(), ['fast', 'fast'])
  assert.equal(await git(root, 'rev-parse', 'HEAD'), head)
  assert.equal(await readFile(path.join(root, 'app.css'), 'utf8'), 'h1 { color: tomato }\n')
  assert.equal((await vibeDesign({ targetRoot: root })).design.tag, 'k3f9')
})

test('partial tiers keep the fallback gate deferred during design and preserve the task guard', async (t) => {
  const { root, temporary } = await fixture(t, 1)
  const file = path.join(root, 'spec/ssot/ARCH.md'), trace = path.join(temporary, 'fallback-ran')
  await writeFile(file, (await readFile(file, 'utf8')).replace(/^  - batch,.*\n/m, ''))
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { verify: 'node batch.js' } }))
  await writeFile(path.join(root, 'batch.js'), `require('fs').writeFileSync(${JSON.stringify(trace)}, 'ran');process.exit(1)\n`)
  await git(root, 'add', '-A'); await git(root, 'commit', '-qm', 'partial tier compatibility fixture')
  const brief = await vibeBrief({ targetRoot: root, task: 'T001', summary: true })
  assert.equal(brief.verify.declared, false); assert.equal(brief.verify.partial, true)
  await assert.rejects(runVibeCheck({ targetRoot: root, tier: 'task' }, 'npm run verify'), /ARCH batch/)
  await vibeDesign({ targetRoot: root, step: 'start', tag: 'k3f9' })
  const result = await vibeDesign({ targetRoot: root, step: 'verify' })
  assert.equal(result.ok, true)
  assert.deepEqual(result.results.map(({ command, ok }) => [command, ok]), [['node --version', true]])
  assert.deepEqual(result.deferred, [{ tier: 'batch', command: 'npm run verify', reason: 'shared-integration' }])
  assert.deepEqual([result.finalVerified, result.tree], [false, null])
  await assert.rejects(readFile(trace, 'utf8'), { code: 'ENOENT' }, 'the package fallback is reserved for the shared final candidate')
})

test('vibe CLI: design start·end는 JSON을, 잘못된 단계는 오류 JSON을 출력한다', async (t) => {
  const { root } = await fixture(t, 1)
  const run = (...args) => execute(process.execPath, [cli, 'vibe', 'design', ...args, '--target', root], { encoding: 'utf8' })
  const started = JSON.parse((await run('start', '--tag', 'k3f9', '--scope', 'hero section')).stdout)
  assert.equal(started.design.scope, 'hero section')
  assert.equal(JSON.parse((await run()).stdout).design.tag, 'k3f9')
  assert.equal(JSON.parse((await run('end')).stdout).ended, true)
  const failed = await run('publish').catch((error) => error)
  assert.equal(failed.code, 1)
  assert.match(JSON.parse(failed.stdout).error, /vibe design/)
})
