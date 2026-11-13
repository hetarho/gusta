import assert from 'node:assert/strict'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { vibePush } from './helpers/unit-policy.mjs'
import { fileURLToPath } from 'node:url'
import { vibeDeploy, vibeStatus, vibePreflight } from '../src/vibe.mjs'
import { vibeSettings } from '../src/settings.mjs'
import { machines, execute, git } from './helpers/vibe-fixture.mjs'

const cli = fileURLToPath(new URL('../bin/gusta.mjs', import.meta.url))
// CRLF, tabs, an odd key order and another "version" key: none of it may change.
const PKG = '{\r\n\t"private": true,\r\n\t"scripts": { "version": "echo 1.0.0" },\r\n\t"version": "1.0.0",\r\n\t"name": "example"\r\n}\r\n'
const LOCK = '{\n  "name": "example",\n  "version": "1.0.0",\n  "lockfileVersion": 3,\n  "packages": {\n    "": { "name": "example", "version": "1.0.0" },\n    "node_modules/left": { "version": "1.0.0" }\n  }\n}\n'
const versioned = (text, from, to) => text.replaceAll(`"version": "${from}"`, (found, offset) => text.slice(0, offset).includes('node_modules/left') ? found : `"version": "${to}"`)
const patch = (from, to) => ({ level: 'patch', from, to })

const commitAll = async (root, message) => { await git(root, 'add', '-A'); await git(root, 'commit', '-q', '-m', message); return git(root, 'rev-parse', 'HEAD') }
const change = async (root, name) => { await writeFile(path.join(root, `${name}.txt`), `${name}\n`); return commitAll(root, name) }
// Exact blob bytes (the fixture's git trims). `root` may be the bare remote.
const blob = async (root, spec) => (await execute('git', ['-C', root, 'cat-file', 'blob', spec], { encoding: 'utf8' })).stdout
const tip = async (remote, branch) => (await execute('git', ['--git-dir', remote, 'rev-parse', branch], { encoding: 'utf8' })).stdout.trim()
const subjects = async (root, ref) => (await git(root, 'log', '--format=%s', ref)).split('\n')
const bumps = async (root, ref) => (await subjects(root, ref)).filter((subject) => subject.startsWith('chore: bump version'))
const versionAt = async (root, ref) => JSON.parse(await blob(root, `${ref}:package.json`)).version

// Two machines on one project with an npm manifest; `settings` are spec/SETTINGS.md lines.
async function project(t, settings) {
  const env = await machines(t)
  for (const root of [env.a, env.b]) await git(root, 'config', 'core.autocrlf', 'false')
  for (const [name, text] of [['package.json', PKG], ['package-lock.json', LOCK]]) await writeFile(path.join(env.a, name), text)
  await writeFile(path.join(env.a, 'spec/SETTINGS.md'), `# SETTINGS\n${settings.map((line) => `- ${line}\n`).join('')}`)
  const start = await commitAll(env.a, 'project')
  await git(env.a, 'push', '-q', 'origin', 'main')
  await git(env.b, 'pull', '-q')
  return { ...env, start }
}

// A new SSOT decision, as a planning commit would add it: confirmed (`o`) or still open (`?`).
async function decide(root, id, status = 'o') {
  const file = path.join(root, 'spec/ssot/ARCH.md')
  await writeFile(file, (await readFile(file, 'utf8')).replace('> r1 |', '> r2 |').replace('\n\n## chg\n', `\n- ${id} [${status}] cache: memory\n\n## chg\n- r2 261101 ${id}+ cache\n`))
  const state = path.join(root, 'spec/STATE.md')
  await writeFile(state, (await readFile(state, 'utf8')).replace('| ARCH | 1 | 1 | - | 0 |', `| ARCH | 2 | 1 | ${id}+ | ${status === '?' ? 1 : 0} |`))
  return commitAll(root, `plan ${id}`)
}
// The owner settles an open decision: `[?]` becomes `[o]`.
async function confirm(root, id) {
  const file = path.join(root, 'spec/ssot/ARCH.md')
  await writeFile(file, (await readFile(file, 'utf8')).replace(`- ${id} [?]`, `- ${id} [o]`))
  const state = path.join(root, 'spec/STATE.md')
  await writeFile(state, (await readFile(state, 'utf8')).replace(/(\| ARCH \| \d+ \| \d+ \| [^|]+ \|) 1 \|/, '$1 0 |'))
  return commitAll(root, `confirm ${id}`)
}

// Machine A's pre-push hook lets machine B push to `branch` first (once or always), or refuses A's
// own push (fail). race(null) switches it off.
async function racing(env) {
  const hooks = path.join(env.temporary, 'hooks a')
  await mkdir(hooks)
  const mode = path.join(env.temporary, 'race')
  await writeFile(path.join(hooks, 'pre-push'), `#!/bin/sh
unset $(git rev-parse --local-env-vars)
[ -e "${mode}" ] || exit 0
read kind branch < "${mode}"
[ "$kind" = fail ] && exit 1
[ "$kind" = once ] && rm "${mode}"
git -C "${env.b}" fetch -q origin && git -C "${env.b}" checkout -q -B race "origin/$branch" && git -C "${env.b}" commit -q --allow-empty -m race && git -C "${env.b}" push -q origin "HEAD:$branch"
exit 0
`)
  await chmod(path.join(hooks, 'pre-push'), 0o755)
  await git(env.a, 'config', 'core.hooksPath', hooks)
  return (kind, branch = 'main') => kind ? writeFile(mode, `${kind} ${branch}\n`) : rm(mode, { force: true })
}

test('push true, deploy 없음: 원격 land가 전진할 때 검증한 HEAD 위에 버전 커밋 하나를 얹고, 다시 실행하면 올리지 않는다', async (t) => {
  const { a, remote } = await project(t, ['land: main', 'push: true', 'version: auto'])
  const head = await change(a, 'feature')
  const pushed = await vibePush({ targetRoot: a, verifiedCommit: head })
  assert.deepEqual(pushed.version, patch('1.0.0', '1.0.1'))
  assert.deepEqual([await tip(remote, 'main'), await git(a, 'rev-parse', 'HEAD'), await git(a, 'rev-parse', `${pushed.pushed}^`)], [pushed.pushed, pushed.pushed, head])
  assert.equal(await git(a, 'log', '-1', '--format=%s', pushed.pushed), 'chore: bump version to 1.0.1')
  assert.deepEqual((await git(a, 'diff', '--name-only', head, pushed.pushed)).split('\n'), ['package-lock.json', 'package.json'])
  // Only the version bytes changed, in the commit and in the checkout that adopted it; no tag.
  assert.equal(await blob(a, `${pushed.pushed}:package.json`), PKG.replace('"version": "1.0.0"', '"version": "1.0.1"'))
  assert.equal(await blob(a, `${pushed.pushed}:package-lock.json`), versioned(LOCK, '1.0.0', '1.0.1'))
  assert.equal(JSON.parse(await blob(a, `${pushed.pushed}:package-lock.json`)).packages['node_modules/left'].version, '1.0.0')
  assert.equal(await readFile(path.join(a, 'package.json'), 'utf8'), PKG.replace('"version": "1.0.0"', '"version": "1.0.1"'))
  assert.deepEqual([await git(a, 'status', '--porcelain'), await git(a, 'tag')], ['', ''])
  // Nothing new: the same verified commit still passes (only the version moved) and nothing rises.
  const again = await vibePush({ targetRoot: a, verifiedCommit: head })
  assert.deepEqual([again.pushed, again.version, await tip(remote, 'main')], [pushed.pushed, { skipped: 'unchanged' }, pushed.pushed])
  // A closing report after the release (STATE, reports) is bookkeeping, not another release.
  const state = path.join(a, 'spec/STATE.md')
  await writeFile(state, (await readFile(state, 'utf8')).replace('## log\n', '## log\n- 261101 report recorded\n'))
  const report = await commitAll(a, 'report')
  const closing = await vibePush({ targetRoot: a, verifiedCommit: head })
  assert.deepEqual([closing.pushed, closing.version, await tip(remote, 'main')], [report, { skipped: 'bookkeeping-only' }, report])
  assert.deepEqual(await bumps(a, 'HEAD'), ['chore: bump version to 1.0.1'])
  // Code changed after the gate is still refused: the exemption is the version value alone.
  await change(a, 'unverified')
  await assert.rejects(vibePush({ targetRoot: a, verifiedCommit: head }), /최종 검증 이후 코드가 변경/)
})

test('수준: 새로 확정된 결정 ID는 minor(기획 커밋이 먼저 올라가 있어도), 그다음은 patch, 사람이 올린 버전은 그대로 둔다', async (t) => {
  const { a, remote } = await project(t, ['land: main', 'push: true', 'version: auto'])
  // The planning commit reaches the release branch on its own, as vibe plan-push does.
  await decide(a, 'ARCH-2')
  await git(a, 'push', '-q', 'origin', 'HEAD:main')
  await change(a, 'feature')
  const minor = await vibePush({ targetRoot: a })
  assert.deepEqual(minor.version, { level: 'minor', from: '1.0.0', to: '1.1.0' })
  await change(a, 'fix')
  assert.deepEqual((await vibePush({ targetRoot: a })).version, patch('1.1.0', '1.1.1'))
  // A major is a person's own commit: the CLI keeps it and counts on from there.
  await writeFile(path.join(a, 'package.json'), (await readFile(path.join(a, 'package.json'), 'utf8')).replace('"version": "1.1.1"', '"version": "2.0.0"'))
  const major = await change(a, 'breaking')
  const kept = await vibePush({ targetRoot: a })
  assert.deepEqual([kept.pushed, kept.version, await versionAt(remote, 'main')], [major, { skipped: 'manual', from: '1.1.1', to: '2.0.0' }, '2.0.0'])
  await change(a, 'after')
  assert.deepEqual((await vibePush({ targetRoot: a })).version, patch('2.0.0', '2.0.1'))
  assert.deepEqual(await bumps(remote, 'main'), ['chore: bump version to 2.0.1', 'chore: bump version to 1.1.1', 'chore: bump version to 1.1.0'])
  // The lock follows only while it agrees: the hand edit left it at 1.1.1, the next bump realigns it.
  assert.equal(JSON.parse(await blob(a, 'HEAD:package-lock.json')).version, '2.0.1')
})

test('수준: 열린 [?] 결정은 새 ID여도 patch이고, 그 결정이 [o]로 확정돼 반영될 때 minor다', async (t) => {
  const { a } = await project(t, ['land: main', 'push: true', 'version: auto'])
  await decide(a, 'ARCH-2', '?')
  await change(a, 'feature')
  assert.deepEqual((await vibePush({ targetRoot: a })).version, patch('1.0.0', '1.0.1'))
  await confirm(a, 'ARCH-2')
  await change(a, 'cache')
  assert.deepEqual((await vibePush({ targetRoot: a })).version, { level: 'minor', from: '1.0.1', to: '1.1.0' })
  // Confirmed before this version was set: not new again.
  await change(a, 'fix')
  assert.deepEqual((await vibePush({ targetRoot: a })).version, patch('1.1.0', '1.1.1'))
})

test('push가 거절돼 다시 맞춘 뒤에도 버전은 한 번만 오르고, 끝내 실패하면 버전 커밋을 남기지 않는다', async (t) => {
  const env = await project(t, ['land: main', 'push: true', 'version: auto'])
  const { a, remote } = env
  const race = await racing(env)
  await change(a, 'feature')
  await race('once')
  const pushed = await vibePush({ targetRoot: a })
  assert.deepEqual([pushed.attempts, pushed.sync, pushed.version], [2, 'rebase', patch('1.0.0', '1.0.1')])
  assert.deepEqual((await subjects(remote, 'main')).slice(0, 4), ['chore: bump version to 1.0.1', 'feature', 'race', 'project'])
  assert.deepEqual([await git(a, 'rev-parse', 'HEAD'), await versionAt(a, 'HEAD'), await git(a, 'status', '--porcelain')], [pushed.pushed, '1.0.1', ''])
  // The remote keeps moving: three rejections end the push. HEAD carries the work but no bump.
  await change(a, 'second')
  await race('always')
  await assert.rejects(vibePush({ targetRoot: a }), /push하지 못했습니다/)
  assert.deepEqual(await bumps(a, 'HEAD'), ['chore: bump version to 1.0.1'])
  assert.deepEqual(await bumps(remote, 'main'), ['chore: bump version to 1.0.1'])
  assert.deepEqual([await versionAt(a, 'HEAD'), JSON.parse(await readFile(path.join(a, 'package.json'), 'utf8')).version, await git(a, 'status', '--porcelain')], ['1.0.1', '1.0.1', ''])
  assert.equal((await git(a, 'for-each-ref', '--format=%(refname)', 'refs/heads')), 'refs/heads/main')
  // Once the remote settles, the same work lands with exactly one new version.
  await race(null)
  const settled = await vibePush({ targetRoot: a })
  assert.deepEqual([settled.version, await versionAt(remote, 'main'), await bumps(remote, 'main')], [patch('1.0.1', '1.0.2'), '1.0.2', ['chore: bump version to 1.0.2', 'chore: bump version to 1.0.1']])
})

test('push false: 로컬 land가 전진할 때 올리고 작업 브랜치도 따라가며, 다시 실행하면 올리지 않는다', async (t) => {
  const { a, remote, start } = await project(t, ['land: main', 'push: false', 'version: auto'])
  await git(a, 'checkout', '-q', '-b', 'feat')
  const head = await change(a, 'feature')
  const landed = await vibePush({ targetRoot: a, verifiedCommit: head })
  assert.deepEqual([landed.mode, landed.target, landed.local, landed.version], ['local', 'main', 'ff', patch('1.0.0', '1.0.1')])
  assert.deepEqual([await git(a, 'rev-parse', 'main'), await git(a, 'rev-parse', 'HEAD'), await git(a, 'rev-parse', `${landed.landed}^`)], [landed.landed, landed.landed, head])
  assert.deepEqual([await versionAt(a, 'main'), JSON.parse(await readFile(path.join(a, 'package.json'), 'utf8')).version, await git(a, 'status', '--porcelain')], ['1.0.1', '1.0.1', ''])
  assert.equal(await tip(remote, 'main'), start)
  const again = await vibePush({ targetRoot: a, verifiedCommit: head })
  assert.deepEqual([again.landed, again.local, again.version], [landed.landed, 'current', { skipped: 'unchanged' }])
})

test('deploy(로컬): 버전 커밋을 land 위에 먼저 만들고 deploy를 그 커밋으로 fast-forward한다 — land가 현재 checkout일 때와 아닐 때', async (t) => {
  const { a, temporary } = await project(t, ['land: next', 'push: false', 'deploy: main', 'version: auto'])
  await git(a, 'checkout', '-q', '-b', 'next')
  const head = await change(a, 'feature')
  // Work done on land itself: nothing for vibe push to move, and landing there is no release anyway.
  assert.deepEqual(await vibePush({ targetRoot: a }), { schemaVersion: 1, ok: true, pushed: null, reason: 'push-disabled' })
  const first = await vibeDeploy({ targetRoot: a })
  assert.deepEqual([first.from, first.to, first.version], ['next', 'main', patch('1.0.0', '1.0.1')])
  assert.deepEqual([await git(a, 'rev-parse', 'next'), await git(a, 'rev-parse', 'main'), await git(a, 'rev-parse', 'HEAD'), await git(a, 'rev-parse', `${first.deployed}^`)], [first.deployed, first.deployed, first.deployed, head])
  assert.deepEqual([JSON.parse(await readFile(path.join(a, 'package.json'), 'utf8')).version, await git(a, 'status', '--porcelain')], ['1.0.1', ''])
  assert.equal((await vibeDeploy({ targetRoot: a })).reason, 'up-to-date')
  // From a work branch: land is not checked out anywhere, so the commit is built without a checkout.
  await git(a, 'checkout', '-q', '-b', 'feat')
  await decide(a, 'ARCH-2')
  const work = await change(a, 'second')
  const landed = await vibePush({ targetRoot: a })
  assert.deepEqual([landed.landed, landed.version], [work, { skipped: 'on-deploy' }])
  const second = await vibeDeploy({ targetRoot: a })
  assert.deepEqual(second.version, { level: 'minor', from: '1.0.1', to: '1.1.0' })
  assert.deepEqual([await git(a, 'rev-parse', 'next'), await git(a, 'rev-parse', 'main'), await git(a, 'rev-parse', `${second.deployed}^`)], [second.deployed, second.deployed, work])
  // The work branch and its files were not touched.
  assert.deepEqual([await git(a, 'rev-parse', 'HEAD'), JSON.parse(await readFile(path.join(a, 'package.json'), 'utf8')).version, await git(a, 'status', '--porcelain')], [work, '1.0.1', ''])
  // land checked out elsewhere with uncommitted changes cannot take the commit: deploy does not move.
  await git(a, 'merge', '-q', '--ff-only', 'next')
  const third = await change(a, 'third')
  await vibePush({ targetRoot: a })
  const other = path.join(temporary, 'next checkout')
  await git(a, 'worktree', 'add', '-q', other, 'next')
  await writeFile(path.join(other, 'feature.txt'), 'edited\n')
  await assert.rejects(vibeDeploy({ targetRoot: a }), /next에 버전 커밋을 올리지 못해 main에 배포하지 않았습니다\(dirty\)/)
  assert.deepEqual([await git(a, 'rev-parse', 'next'), await git(a, 'rev-parse', 'main')], [third, second.deployed])
  await git(other, 'checkout', '-q', '--', 'feature.txt')
  const fourth = await vibeDeploy({ targetRoot: a })
  assert.deepEqual([fourth.version, await git(other, 'rev-parse', 'HEAD'), await git(a, 'rev-parse', 'main')], [patch('1.1.0', '1.1.1'), fourth.deployed, fourth.deployed])
  assert.equal(JSON.parse(await readFile(path.join(other, 'package.json'), 'utf8')).version, '1.1.1')
})

test('deploy(원격): land를 먼저 push한 뒤 deploy를 올려 다른 기기의 배포가 거절되지 않고, land push가 거절되면 다시 계산한다', async (t) => {
  const env = await project(t, ['land: next', 'push: true', 'deploy: main', 'version: auto'])
  const { a, b, remote } = env
  const race = await racing(env)
  await git(a, 'checkout', '-q', '-b', 'next')
  await change(a, 'feature')
  const pushed = await vibePush({ targetRoot: a })
  assert.deepEqual([pushed.target, pushed.version, await tip(remote, 'next')], ['next', { skipped: 'on-deploy' }, pushed.pushed])
  const first = await vibeDeploy({ targetRoot: a })
  assert.deepEqual([first.version, first.remote], [patch('1.0.0', '1.0.1'), 'origin'])
  assert.deepEqual([await tip(remote, 'next'), await tip(remote, 'main'), await git(a, 'rev-parse', 'HEAD'), await git(a, 'rev-parse', `${first.deployed}^`)], [first.deployed, first.deployed, first.deployed, pushed.pushed])
  assert.equal(JSON.parse(await readFile(path.join(a, 'package.json'), 'utf8')).version, '1.0.1')
  // Another machine sees deploy inside land: nothing to refuse, nothing to do.
  assert.equal((await vibeDeploy({ targetRoot: b })).reason, 'up-to-date')
  assert.equal((await vibeDeploy({ targetRoot: a })).reason, 'up-to-date')
  // Someone pushes land while the bump is on its way: the bump is rebuilt on the new tip, once.
  await change(a, 'second')
  await vibePush({ targetRoot: a })
  await race('once', 'next')
  const second = await vibeDeploy({ targetRoot: a })
  assert.deepEqual(second.version, patch('1.0.1', '1.0.2'))
  assert.deepEqual([await tip(remote, 'next'), await tip(remote, 'main'), await git(a, 'rev-parse', 'HEAD')], [second.deployed, second.deployed, second.deployed])
  assert.deepEqual((await subjects(a, second.deployed)).slice(0, 4), ['chore: bump version to 1.0.2', 'race', 'second', 'chore: bump version to 1.0.1'])
  // land refuses the bump for good: deploy stays where it was and land holds no half release.
  await change(a, 'third')
  const third = (await vibePush({ targetRoot: a })).pushed
  await race('fail')
  await assert.rejects(vibeDeploy({ targetRoot: a }), /next에 버전 커밋을 올리지 못해 main에 배포하지 않았습니다/)
  assert.deepEqual([await tip(remote, 'next'), await tip(remote, 'main'), await git(a, 'rev-parse', 'HEAD')], [third, second.deployed, third])
  assert.equal((await bumps(a, 'HEAD')).length, 2)
})

test('deploy 브랜치가 아직 없으면 만들기만 하고 올리지 않는다', async (t) => {
  const { a } = await project(t, ['land: main', 'push: false', 'deploy: live', 'version: auto'])
  const head = await change(a, 'feature')
  const created = await vibeDeploy({ targetRoot: a })
  assert.deepEqual([created.deployed, created.local, created.version, await git(a, 'rev-parse', 'live')], [head, 'created', { skipped: 'no-base' }, head])
  await change(a, 'next')
  assert.deepEqual((await vibeDeploy({ targetRoot: a })).version, patch('1.0.0', '1.0.1'))
})

test('올리지 않는 경우: 미정·off·운영 브랜치 없음·지원하지 않는 매니페스트는 이유를 싣고 반영은 계속한다', async (t) => {
  const { a, remote } = await project(t, ['land: main', 'push: true'])
  const manifest = path.join(a, 'package.json')
  // Each step is one landing: the settings or manifest change travels with a code change.
  const landing = async (name, prepare) => {
    await prepare?.()
    const head = await change(a, name)
    const pushed = await vibePush({ targetRoot: a })
    assert.deepEqual([pushed.ok, pushed.pushed, await tip(remote, 'main'), await git(a, 'rev-parse', 'HEAD')], [true, head, head, head], name)
    return pushed.version
  }
  assert.deepEqual(await landing('undecided'), { skipped: 'unset' })
  assert.deepEqual(await landing('off', () => vibeSettings({ root: a, set: ['version=off'] })), { skipped: 'off' })
  assert.deepEqual(await landing('current', () => vibeSettings({ root: a, set: ['version=auto', 'land=current'] })), { skipped: 'no-release-branch' })
  // A prerelease line is a person's: their change stands, and the CLI does not count on from it.
  const prerelease = () => writeFile(manifest, PKG.replace('"version": "1.0.0"', '"version": "1.0.0-rc.1"'))
  assert.deepEqual(await landing('prerelease', async () => { await vibeSettings({ root: a, set: ['land=main'] }); await prerelease() }), { skipped: 'manual', from: '1.0.0', to: '1.0.0-rc.1' })
  assert.deepEqual(await landing('after prerelease'), { skipped: 'unsupported-version', from: '1.0.0-rc.1' })
  assert.deepEqual(await landing('no version field', () => writeFile(manifest, '{ "name": "example" }\n')), { skipped: 'no-manifest' })
  assert.deepEqual(await landing('no manifest', async () => { await rm(manifest); await rm(path.join(a, 'package-lock.json')) }), { skipped: 'no-manifest' })
  assert.deepEqual(await bumps(a, 'HEAD'), [])
})

test('commit.gpgsign이면 버전 커밋에 서명하고, 서명에 실패하면 버전업만 건너뛰고 반영한다 — 조정 브랜치 커밋에는 서명하지 않는다', async (t) => {
  const { a, remote, temporary } = await project(t, ['land: main', 'push: true', 'version: auto'])
  const gpg = path.join(temporary, 'fake-gpg.sh')
  const signing = '#!/bin/sh\ncat >/dev/null\nprintf \'\\n[GNUPG:] SIG_CREATED D 1 8 00 1700000000 0000\\n\' >&2\nprintf -- \'-----BEGIN PGP SIGNATURE-----\\n\\nZmFrZQ==\\n-----END PGP SIGNATURE-----\\n\'\n'
  await writeFile(gpg, signing)
  await chmod(gpg, 0o755)
  for (const [key, value] of [['commit.gpgsign', 'true'], ['gpg.program', gpg]]) await git(a, 'config', key, value)
  const signed = async (commit) => /^gpgsig /m.test(await git(a, 'cat-file', 'commit', commit))
  const head = await change(a, 'feature')
  const pushed = await vibePush({ targetRoot: a, verifiedCommit: head })
  assert.deepEqual([pushed.version, await tip(remote, 'main'), await signed(pushed.pushed)], [patch('1.0.0', '1.0.1'), pushed.pushed, true])
  // 조정 브랜치는 사람 없이 자주 쓰는 곳이라 서명 프롬프트를 부르지 않는다.
  const { vibeBeat } = await import('../src/vibe.mjs')
  await vibeBeat({ targetRoot: a, tag: 'aaaa', mode: 'pair' })
  assert.equal(await signed('gusta'), false)
  // 서명이 실패하면(키 없음·잠긴 에이전트) 버전 커밋 없이 검증한 HEAD를 그대로 반영하고 이유를 싣는다.
  const next = await change(a, 'next')
  await writeFile(gpg, '#!/bin/sh\necho "gpg: signing failed: No secret key" >&2\nexit 2\n')
  const unsigned = await vibePush({ targetRoot: a, verifiedCommit: next })
  assert.deepEqual([unsigned.ok, unsigned.pushed, await tip(remote, 'main'), unsigned.version.skipped, unsigned.version.to], [true, next, next, 'sign-failed', '1.0.2'])
  assert.match(unsigned.version.error, /sign|gpg/i)
  assert.deepEqual(await bumps(a, 'HEAD'), ['chore: bump version to 1.0.1'])
})

test('land-via pr: 병합 시점을 CLI가 쥐지 않으므로 올리지 않는다', async (t) => {
  const { a, remote, start } = await project(t, ['land: main', 'land-via: pr', 'push: true', 'version: auto'])
  await git(a, 'checkout', '-q', '-b', 'work/x')
  const head = await change(a, 'feature')
  const result = await vibePush({ targetRoot: a })
  assert.deepEqual([result.mode, result.pushed, result.version], ['pr', head, { skipped: 'land-via-pr' }])
  assert.deepEqual([await tip(remote, 'work/x'), await tip(remote, 'main')], [head, start])
})

test('version 값은 status·preflight·settings와 CLI 결과(JSON)에 나온다', async (t) => {
  const { a, remote } = await project(t, ['land: main', 'push: true', 'version: auto'])
  assert.equal((await vibeStatus({ targetRoot: a })).settings.version, 'auto')
  const detail = async () => (await vibePreflight({ targetRoot: a })).checks.find((check) => check.name === 'branch-settings').detail
  assert.equal(await detail(), 'land main · version auto (vibe push)')
  const shown = (await vibeSettings({ root: a })).settings.find((entry) => entry.key === 'version')
  assert.deepEqual([shown.value, shown.source, shown.default, shown.values], ['auto', 'file', '?', '?|off|auto'])
  assert.match(shown.note, /a version a person changed stands/)
  await change(a, 'feature')
  const { stdout } = await execute(process.execPath, [cli, 'vibe', 'push', '--target', a], { encoding: 'utf8' })
  const printed = JSON.parse(stdout)
  assert.deepEqual([printed.ok, printed.version, await tip(remote, 'main')], [true, patch('1.0.0', '1.0.1'), printed.pushed])
  await vibeSettings({ root: a, set: ['deploy=live'] })
  assert.equal(await detail(), 'land main → deploy live · version auto (vibe deploy)')
  await vibeSettings({ root: a, set: ['land-via=pr'] })
  assert.equal(await detail(), 'land main → deploy live · version auto (land-via-pr)')
  // Undecided or off: nothing about versions is shown.
  await vibeSettings({ root: a, set: ['version=off'] })
  assert.equal(await detail(), 'land main → deploy live')
})
