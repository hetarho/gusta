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

test('vibe design verify: 미커밋 디자인에서 task·batch 명령을 모두 돌리고, 빠른 검사가 실패하면 무거운 검사를 미룬다', async (t) => {
  const { root, temporary } = await fixture(t, 1)
  const runs = path.join(temporary, 'runs.txt')
  const script = (name, fails) => `require('fs').appendFileSync(${JSON.stringify(runs)}, '${name}\\n');process.exit(${fails ? "require('fs').existsSync('broken') ? 1 : 0" : '0'})\n`
  await writeFile(path.join(root, 'fast.js'), script('fast', true))
  await writeFile(path.join(root, 'slow.js'), script('slow', false))
  const arch = path.join(root, 'spec/ssot/ARCH.md')
  await writeFile(arch, (await readFile(arch, 'utf8')).replace('task, before done: `node --version`', 'task, before done: `node fast.js`').replace('batch, before code push: `node --version`', 'batch, before code push: `node slow.js`'))
  await git(root, 'add', '-A'); await git(root, 'commit', '-q', '-m', 'checks')
  await vibeDesign({ targetRoot: root, step: 'start', tag: 'k3f9' })
  await writeFile(path.join(root, 'app.css'), 'h1 { color: tomato }\n')
  await writeFile(path.join(root, 'broken'), '')
  const count = async () => (await readFile(runs, 'utf8').catch(() => '')).split('\n').filter(Boolean)
  const failed = await vibeDesign({ targetRoot: root, step: 'verify' })
  assert.equal(failed.ok, false)
  assert.deepEqual(failed.results.map((result) => [result.command, result.tier, result.ok]), [['node fast.js', 'task', false]])
  assert.deepEqual(failed.skipped, ['node slow.js'])
  assert.equal(failed.tree, null)
  await rm(path.join(root, 'broken'))
  const passed = await vibeDesign({ targetRoot: root, step: 'verify' })
  assert.equal(passed.ok, true)
  assert.deepEqual(passed.results.map((result) => [result.command, result.ok, result.cached]), [['node fast.js', true, false], ['node slow.js', true, false]])
  assert.match(passed.tree, /^[0-9a-f]{40}$/)
  assert.equal(passed.design.tag, 'k3f9')
  assert.deepEqual(await count(), ['fast', 'fast', 'slow'])
  // The same tree is not checked twice.
  assert.ok((await vibeDesign({ targetRoot: root, step: 'verify' })).results.every((result) => result.cached))
  assert.equal((await count()).length, 3)
  const override = await vibeDesign({ targetRoot: root, step: 'verify', verify: ['node --version'] })
  assert.deepEqual(override.results.map((result) => result.command), ['node fast.js', 'node --version'])
})

test('partial tiers preserve the design fallback gate and task guard while briefs expose the incomplete contract', async (t) => {
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
  assert.equal(result.ok, false)
  assert.deepEqual(result.results.map(({ command, ok }) => [command, ok]), [['node --version', true], ['npm run verify', false]])
  assert.equal(await readFile(trace, 'utf8'), 'ran', 'the required package fallback actually executes')
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
