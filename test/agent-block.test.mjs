import assert from 'node:assert/strict'
import { access, mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { BEGIN_PREFIX, END_MARKER, renderBlock, inspectBlock, applyBlock, removeBlock, agentBlockTargets, agentBlock } from '../src/agent-block.mjs'
import { installSkills, installedAgents } from '../src/installer.mjs'
import { SETTINGS, vibeSettings } from '../src/settings.mjs'
import { SkillPackageError } from '../src/errors.mjs'
import { vibeStatus, vibePreflight, vibePush } from '../src/vibe.mjs'
import { fixture, execute, git } from './helpers/vibe-fixture.mjs'

const cli = fileURLToPath(new URL('../bin/gusta.mjs', import.meta.url))
const BLOCK = renderBlock()
const OLD = `${BEGIN_PREFIX} an older notice -->\n## GUSTA\nold body\n${END_MARKER}`
const missing = (file) => assert.rejects(access(file), { code: 'ENOENT' })

// A project directory with the given files; `{ link: target }` makes a symlink.
async function project(t, files = {}) {
  const root = path.join(await realpath(await mkdtemp(path.join(os.tmpdir(), 'gusta-block-'))), 'project')
  t.after(() => rm(path.dirname(root), { recursive: true, force: true }))
  await mkdir(root)
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true })
    if (typeof content === 'string') await writeFile(path.join(root, name), content)
    else await symlink(content.link, path.join(root, name))
  }
  return root
}
// Which agents are installed and what the owner chose are injected: no lock file, no spec/.
const deps = (agents, setting = true) => ({ installedAgents: async () => agents, readSetting: async () => setting })
const targets = async (root, agents) => (await agentBlockTargets(root, deps(agents))).targets.map((target) => [target.path, target.agents])
const read = (root, name) => readFile(path.join(root, name), 'utf8')

test('블록: 마커 한 쌍과 영어 본문 6줄 이내, 실제 스킬 이름만 가리키고 경고는 주석 안에만 둔다', async () => {
  const lines = BLOCK.split('\n')
  assert.ok(lines[0].startsWith(`${BEGIN_PREFIX} `)); assert.ok(lines[0].endsWith(' -->')); assert.match(lines[0], /do not edit inside this block/)
  assert.equal(lines.at(-1), END_MARKER)
  const body = lines.slice(1, -1).filter(Boolean)
  assert.ok(body.length <= 6, `본문 ${body.length}줄`)
  assert.doesNotMatch(body.join('\n'), /do not edit|\/gusta-|[가-힣]/)
  assert.ok(body.includes('- Branch, push, deploy and version behavior comes from `spec/SETTINGS.md` (the `gusta-preference` skill); never assume branch names.'))
  const skills = await readdir(new URL('../skills/', import.meta.url))
  const named = [...BLOCK.matchAll(/`(gusta-[a-z-]+)`/g)].map((match) => match[1])
  assert.ok(named.length >= 2)
  for (const name of named) assert.ok(skills.includes(name), `없는 스킬: ${name}`)
  assert.deepEqual([SETTINGS['agent-block'].default, SETTINGS['agent-block'].required, SETTINGS['agent-block'].values], ['?', true, '?|true|false'])
})

test('상태: missing·current·stale과, 짝이 없거나 중복·역전된 마커의 broken', () => {
  for (const text of [null, '', '# Rules\n\n- mine\n']) assert.deepEqual(inspectBlock(text), { status: 'missing' })
  assert.equal(inspectBlock(`# Rules\n\n${BLOCK}\n`).status, 'current')
  assert.equal(inspectBlock(`# Rules\n\n${OLD}\n\nmore\n`).status, 'stale')
  assert.equal(inspectBlock(BLOCK.replace('spec-first', 'my own way')).status, 'stale')
  // The begin marker is found by its prefix, the end by its line; look-alikes are not markers.
  assert.equal(inspectBlock('<!-- gusta:beginner -->\n<!-- gusta:ending -->\n').status, 'missing')
  for (const [text, reason, lines] of [
    [`a\n${BEGIN_PREFIX} x -->\nbody\n`, 'begin marker without end', [2]],
    [`a\nbody\n${END_MARKER}\n`, 'end marker without begin', [3]],
    [`${BLOCK}\n\n${BLOCK}\n`, 'duplicate markers', [1, 10, 12, 21]],
    [`${BEGIN_PREFIX} -->\n${BEGIN_PREFIX} -->\n${END_MARKER}\n`, 'duplicate markers', [1, 2, 3]],
    [`${END_MARKER}\nbody\n${BEGIN_PREFIX} -->\n`, 'end marker before begin', [1, 3]],
  ]) assert.deepEqual(inspectBlock(text), { status: 'broken', reason, lines })
})

test('적용: 없으면 빈 줄 하나 뒤에 붙이고, 있으면 마커 사이만 바꾸며, 다시 적용해도 같고 블록 밖은 그대로다', () => {
  assert.equal(applyBlock(null), `${BLOCK}\n`)
  assert.equal(applyBlock(''), `${BLOCK}\n`)
  for (const [text, gap] of [['# Rules\n\n- mine\n', '\n'], ['# Rules\n\n- mine', '\n\n'], ['# Rules\n\n- mine\n\n', ''], ['  odd  \tspacing \n\n\n# x\n', '\n']]) {
    const applied = applyBlock(text)
    assert.equal(applied, `${text}${gap}${BLOCK}\n`, '기존 내용은 접두어로 그대로 남고 빈 줄 하나를 둔다')
    assert.equal(inspectBlock(applied).status, 'current')
    assert.equal(applyBlock(applied), applied)
  }
  const [before, after] = ['# Rules\r\n keep\ttabs  \n\n', '\n\n## Mine\n- stays  \n\nno newline at end']
  const replaced = applyBlock(`${before}${OLD}${after}`)
  assert.equal(replaced, `${before}${renderBlock('\r\n')}${after}`)
  assert.equal(applyBlock(replaced), replaced)
  // CRLF files keep CRLF inside the block too, so a second run changes nothing.
  const crlf = applyBlock('# Rules\r\n\r\n- mine\r\n')
  assert.equal(crlf, `# Rules\r\n\r\n- mine\r\n\r\n${renderBlock('\r\n')}\r\n`)
  assert.equal(inspectBlock(crlf).status, 'current'); assert.equal(applyBlock(crlf), crlf)
  // An indented or edited block is still ours from the begin line to the end line.
  assert.equal(applyBlock(`x\n\n  ${BEGIN_PREFIX} -->\n  edited\n  ${END_MARKER}  \ny\n`), `x\n\n${BLOCK}\ny\n`)
})

test('코드 펜스 안의 마커는 예시일 뿐 블록이 아니다', () => {
  const example = (fence = '```') => `# Rules\n\nHow the block looks:\n\n${fence}markdown\n${OLD}\n${fence}\n`
  // 펜스 안 예시만 있으면 블록은 없다: 적용하면 예시는 그대로 두고 끝에 붙인다.
  for (const fence of ['```', '~~~', '````']) {
    const text = example(fence)
    assert.deepEqual(inspectBlock(text), { status: 'missing' })
    assert.equal(applyBlock(text), `${text}\n${BLOCK}\n`)
    assert.equal(removeBlock(text), text)
  }
  // 펜스 안에서 짝이 안 맞거나 겹친 마커도 broken이 아니다.
  assert.deepEqual(inspectBlock(`a\n\`\`\`\n${BEGIN_PREFIX} x -->\n\`\`\`\n`), { status: 'missing' })
  // 펜스 밖의 실제 블록만 블록이다: 바꾸고 지울 때 예시는 손대지 않는다.
  const both = `${example()}\n${OLD}\n\n## Mine\n`
  assert.equal(inspectBlock(both).status, 'stale')
  const applied = applyBlock(both)
  assert.equal(applied, `${example()}\n${BLOCK}\n\n## Mine\n`)
  assert.equal(inspectBlock(applied).status, 'current')
  assert.equal(removeBlock(applied), `${example()}\n## Mine\n`)
  // 짧은 펜스나 다른 문자는 펜스를 닫지 못한다.
  const open = `\`\`\`\`\n${OLD}\n\`\`\`\n~~~\n\`\`\`\`\n${BLOCK}\n`
  assert.equal(inspectBlock(open).status, 'current')
})

test('broken은 적용도 제거도 추측하지 않고 거절한다', () => {
  for (const text of [`a\n${BEGIN_PREFIX} x -->\n`, `${END_MARKER}\n`, `${BLOCK}\n${BLOCK}\n`, `${END_MARKER}\n${BEGIN_PREFIX} -->\n`]) {
    for (const change of [applyBlock, removeBlock]) assert.throws(() => change(text), (error) => error instanceof SkillPackageError && /추측해서 고치지 않습니다/.test(error.message) && /line \d/.test(error.details[0]))
  }
})

test('제거: 블록과 그 앞 빈 줄만 걷어 적용 전으로 돌아간다', () => {
  for (const text of ['# Rules\n\n- mine\n', '# Rules\r\n\r\n- mine\r\n', '']) assert.equal(removeBlock(applyBlock(text)), text)
  // The one blank line before the block goes with it, whoever wrote it; a missing final newline is not restored.
  for (const text of ['# Rules\n\n- mine\n\n', '# Rules\n\n- mine']) assert.equal(removeBlock(applyBlock(text)), '# Rules\n\n- mine\n')
  assert.equal(removeBlock('# Rules\n- mine\n'), '# Rules\n- mine\n')
  assert.equal(removeBlock(`# A\n\n${OLD}\n\n# B\n`), '# A\n\n# B\n')
  assert.equal(removeBlock(`${BLOCK}\n# B\n`), '# B\n')
})

test('대상 파일: Claude는 CLAUDE.md → .claude/CLAUDE.md → 있는 AGENTS.md → 새 CLAUDE.md, Codex는 AGENTS.md', async (t) => {
  assert.deepEqual(await targets(await project(t, { 'CLAUDE.md': '# c\n', '.claude/CLAUDE.md': '# n\n', 'AGENTS.md': '# a\n' }), ['claude']), [['CLAUDE.md', ['claude']]])
  assert.deepEqual(await targets(await project(t, { '.claude/CLAUDE.md': '# n\n', 'AGENTS.md': '# a\n' }), ['claude']), [['.claude/CLAUDE.md', ['claude']]])
  assert.deepEqual(await targets(await project(t), ['claude']), [['CLAUDE.md', ['claude']]])
  assert.deepEqual(await targets(await project(t), ['codex']), [['AGENTS.md', ['codex']]])
  assert.deepEqual(await targets(await project(t, { 'CLAUDE.md': '# c\n' }), ['codex']), [['AGENTS.md', ['codex']]])
  assert.deepEqual(await targets(await project(t), ['claude', 'codex']), [['CLAUDE.md', ['claude']], ['AGENTS.md', ['codex']]])
  assert.deepEqual(await targets(await project(t, { 'CLAUDE.md': '# c\n', 'AGENTS.md': '# a\n' }), ['claude', 'codex']), [['CLAUDE.md', ['claude']], ['AGENTS.md', ['codex']]])
  assert.deepEqual(await targets(await project(t, { 'CLAUDE.md': '# c\n' }), []), [])
})

test('AGENTS.md만 있는 프로젝트에는 CLAUDE.md를 만들지 않는다 — Claude Code가 읽던 기존 지침이 사라진다', async (t) => {
  for (const agents of [['claude'], ['claude', 'codex']]) {
    const root = await project(t, { 'AGENTS.md': '# Project rules\n\n- keep me\n' })
    assert.deepEqual(await targets(root, agents), [['AGENTS.md', agents]])
    const writes = []
    const result = await agentBlock({ targetRoot: root }, { ...deps(agents), writeFile: async (file, text) => { writes.push(file); await writeFile(file, text) } })
    assert.deepEqual(result.files, [{ path: 'AGENTS.md', agents, status: 'current', before: 'missing', changed: true }])
    assert.deepEqual(writes, [path.join(root, 'AGENTS.md')], '같은 파일은 한 번만 쓴다')
    assert.equal(await read(root, 'AGENTS.md'), `# Project rules\n\n- keep me\n\n${BLOCK}\n`)
    await missing(path.join(root, 'CLAUDE.md')); await missing(path.join(root, '.claude/CLAUDE.md'))
  }
})

test('CLAUDE.md가 AGENTS.md로의 링크이거나 @AGENTS.md를 import하면 AGENTS.md에만 쓴다', async (t) => {
  const linked = await project(t, { 'AGENTS.md': '# a\n', 'CLAUDE.md': { link: 'AGENTS.md' } })
  for (const agents of [['claude'], ['claude', 'codex']]) assert.deepEqual(await targets(linked, agents), [['AGENTS.md', agents]])
  await agentBlock({ targetRoot: linked }, deps(['claude', 'codex']))
  assert.equal(await read(linked, 'AGENTS.md'), `# a\n\n${BLOCK}\n`); assert.equal(await read(linked, 'CLAUDE.md'), await read(linked, 'AGENTS.md'))
  // A link whose AGENTS.md does not exist yet, and the reverse link, still mean one real file.
  assert.deepEqual(await targets(await project(t, { 'CLAUDE.md': { link: 'AGENTS.md' } }), ['claude']), [['AGENTS.md', ['claude']]])
  assert.deepEqual(await targets(await project(t, { 'CLAUDE.md': '# c\n', 'AGENTS.md': { link: 'CLAUDE.md' } }), ['claude', 'codex']), [['CLAUDE.md', ['claude', 'codex']]])
  for (const text of ['# c\n\n@AGENTS.md\n', 'Rules: see @./AGENTS.md.\n', '- @AGENTS.md\r\n']) {
    const root = await project(t, { 'CLAUDE.md': text, 'AGENTS.md': '# a\n' })
    assert.deepEqual(await targets(root, ['claude', 'codex']), [['AGENTS.md', ['claude', 'codex']]], text)
    await agentBlock({ targetRoot: root }, deps(['claude']))
    assert.equal(await read(root, 'CLAUDE.md'), text)
  }
  assert.deepEqual(await targets(await project(t, { '.claude/CLAUDE.md': '@../AGENTS.md\n' }), ['claude']), [['AGENTS.md', ['claude']]])
  // A mention is not an import: code spans, fenced code, other files, addresses.
  for (const text of ['Never write `@AGENTS.md` here.\n', '```\n@AGENTS.md\n```\n', '@docs/AGENTS.md\n', 'mail me@AGENTS.md\n']) {
    assert.deepEqual(await targets(await project(t, { 'CLAUDE.md': text, 'AGENTS.md': '# a\n' }), ['claude']), [['CLAUDE.md', ['claude']]], text)
  }
})

test('명령: 설정이 true일 때만 쓰고, 파일이 없으면 블록만 담아 만들며, 다시 돌리면 바꾸지 않는다', async (t) => {
  const root = await project(t)
  for (const setting of ['?', false]) {
    assert.deepEqual(await agentBlock({ targetRoot: root }, deps(['claude', 'codex'], setting)), { schemaVersion: 1, mode: 'apply', setting, ok: true, skipped: `agent-block: ${setting}`, files: [] })
    // --check still shows what would be written where (gusta-init asks with it), and passes.
    const preview = await agentBlock({ targetRoot: root, check: true }, deps(['claude', 'codex'], setting))
    assert.deepEqual([preview.ok, preview.block, preview.files], [true, BLOCK, [{ path: 'CLAUDE.md', agents: ['claude'], status: 'missing' }, { path: 'AGENTS.md', agents: ['codex'], status: 'missing' }]])
  }
  assert.deepEqual(await readdir(root), [])
  assert.equal((await agentBlock({ targetRoot: root, check: true }, deps(['claude', 'codex']))).ok, false)
  const first = await agentBlock({ targetRoot: root }, deps(['claude', 'codex']))
  assert.deepEqual(first.files, [
    { path: 'CLAUDE.md', agents: ['claude'], status: 'current', before: 'missing', changed: true, created: true },
    { path: 'AGENTS.md', agents: ['codex'], status: 'current', before: 'missing', changed: true, created: true }])
  for (const name of ['CLAUDE.md', 'AGENTS.md']) assert.equal(await read(root, name), `${BLOCK}\n`)
  const again = await agentBlock({ targetRoot: root }, { ...deps(['claude', 'codex']), writeFile: async () => assert.fail('같은 내용은 쓰지 않는다') })
  assert.deepEqual(again.files.map((file) => [file.before, file.changed]), [['current', false], ['current', false]])
  assert.equal((await agentBlock({ targetRoot: root, check: true }, deps(['claude', 'codex']))).ok, true)
  await assert.rejects(agentBlock({ targetRoot: root }, deps([])), /설치된 gusta 스킬이 없습니다/)
  await assert.rejects(agentBlock({ targetRoot: root, check: true, remove: true }, deps(['claude'])), /함께 쓸 수 없습니다/)
})

test('명령: stale은 갱신하고, 한 파일이라도 broken이면 아무 파일도 쓰지 않는다', async (t) => {
  const mine = '# Mine\n\n- rule\n\n'
  const root = await project(t, { 'CLAUDE.md': `${mine}${OLD}\n\n## After\n`, 'AGENTS.md': `# a\n${BEGIN_PREFIX} -->\n` })
  const before = [await read(root, 'CLAUDE.md'), await read(root, 'AGENTS.md')]
  for (const options of [{ check: true }, {}, { remove: true }]) {
    const result = await agentBlock({ targetRoot: root, ...options }, { ...deps(['claude', 'codex']), writeFile: async () => assert.fail('broken이면 쓰지 않는다'), unlink: async () => assert.fail('broken이면 지우지 않는다') })
    assert.equal(result.ok, false)
    assert.deepEqual(result.files.map((file) => [file.path, file.status]), [['CLAUDE.md', 'stale'], ['AGENTS.md', 'broken']])
    assert.deepEqual([result.files[1].reason, result.files[1].lines], ['begin marker without end', [2]])
  }
  assert.deepEqual([await read(root, 'CLAUDE.md'), await read(root, 'AGENTS.md')], before)
  await writeFile(path.join(root, 'AGENTS.md'), '# a\n')
  const fixed = await agentBlock({ targetRoot: root }, deps(['claude', 'codex']))
  assert.deepEqual(fixed.files.map((file) => [file.path, file.before, file.changed]), [['CLAUDE.md', 'stale', true], ['AGENTS.md', 'missing', true]])
  assert.equal(await read(root, 'CLAUDE.md'), `${mine}${BLOCK}\n\n## After\n`)
  // A target gusta must not touch (a link out of the project, a directory) is broken, never followed.
  const outside = await project(t, { 'shared.md': '# shared\n' })
  const linked = await project(t, { 'CLAUDE.md': { link: path.join(outside, 'shared.md') } })
  const refused = await agentBlock({ targetRoot: linked }, deps(['claude']))
  assert.deepEqual([refused.ok, refused.files], [false, [{ path: 'CLAUDE.md', agents: ['claude'], status: 'broken', reason: 'resolves outside the project', lines: [] }]])
  assert.equal(await read(outside, 'shared.md'), '# shared\n')
})

test('명령: --remove는 설정과 무관하게 세 후보의 블록을 걷고, 블록만 있던 파일은 지운다', async (t) => {
  const root = await project(t, { 'AGENTS.md': '# Project rules\n' })
  await agentBlock({ targetRoot: root }, deps(['claude', 'codex']))
  await writeFile(path.join(root, 'CLAUDE.md'), `${BLOCK}\n`)
  await mkdir(path.join(root, '.claude'))
  await writeFile(path.join(root, '.claude/CLAUDE.md'), '# nested, no block\n')
  const removed = await agentBlock({ targetRoot: root, remove: true }, deps([], false))
  assert.deepEqual(removed.files, [
    { path: 'CLAUDE.md', status: 'missing', before: 'current', changed: true, deleted: true },
    { path: '.claude/CLAUDE.md', status: 'missing', before: 'missing', changed: false },
    { path: 'AGENTS.md', status: 'missing', before: 'current', changed: true }])
  await missing(path.join(root, 'CLAUDE.md'))
  assert.equal(await read(root, 'AGENTS.md'), '# Project rules\n'); assert.equal(await read(root, '.claude/CLAUDE.md'), '# nested, no block\n')
})

test('설치 기록(lock)이 어느 에이전트에 쓸지 정한다', async (t) => {
  const root = await project(t, { 'source/plan/SKILL.md': '---\nname: plan\ndescription: Plan\n---\n\n# Plan\n' })
  const targetRoot = path.join(root, 'target')
  assert.deepEqual(await installedAgents(targetRoot), [])
  await installSkills({ skillsRoot: path.join(root, 'source'), targetRoot, agents: ['codex'], packageVersion: '1.0.0' })
  assert.deepEqual(await installedAgents(targetRoot), ['codex'])
  assert.deepEqual((await agentBlockTargets(targetRoot)).targets.map((target) => target.path), ['AGENTS.md'])
  await installSkills({ skillsRoot: path.join(root, 'source'), targetRoot, agents: ['claude'], packageVersion: '1.0.0' })
  assert.deepEqual(await installedAgents(targetRoot), ['claude', 'codex'])
})

test('CLI: agent-block은 적용·--check·--remove·--json을, check는 설정이 true일 때만 블록 상태를 본다', async (t) => {
  const root = await project(t, { 'CLAUDE.md': '# Project\n\n- my rule\n' })
  const run = (...args) => execute(process.execPath, [cli, ...args, '--target', root]).then(({ stdout }) => ({ code: 0, stdout }), (error) => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }))
  await run('install', '--agent', 'claude')
  // Undecided: nothing is written and check stays quiet.
  assert.match((await run('agent-block')).stdout, /건너뜀: SETTINGS agent-block: \?/)
  assert.equal((await run('check', '--agent', 'claude')).code, 0)
  assert.equal(await read(root, 'CLAUDE.md'), '# Project\n\n- my rule\n')
  const preview = JSON.parse((await run('agent-block', '--check', '--json')).stdout)
  assert.deepEqual([preview.ok, preview.setting, preview.files, preview.block], [true, '?', [{ path: 'CLAUDE.md', agents: ['claude'], status: 'missing' }], BLOCK])

  await vibeSettings({ root, set: ['agent-block=true'] })
  const unapplied = await run('check', '--agent', 'claude')
  assert.equal(unapplied.code, 1); assert.match(unapplied.stderr, /gusta 블록이 패키지와 일치하지 않습니다[\s\S]*missing: CLAUDE\.md/)
  assert.equal((await run('agent-block', '--check')).code, 1)
  assert.match((await run('agent-block')).stdout, /gusta 블록 추가: CLAUDE\.md/)
  assert.equal(await read(root, 'CLAUDE.md'), `# Project\n\n- my rule\n\n${BLOCK}\n`)
  assert.match((await run('agent-block')).stdout, /gusta 블록 동일: CLAUDE\.md/)
  assert.match((await run('check', '--agent', 'claude')).stdout, /스킬 동기화 상태 정상/)

  await writeFile(path.join(root, 'CLAUDE.md'), (await read(root, 'CLAUDE.md')).replace('spec-first', 'somehow'))
  const stale = await run('agent-block', '--check', '--json')
  assert.equal(stale.code, 1); assert.deepEqual(JSON.parse(stale.stdout).files, [{ path: 'CLAUDE.md', agents: ['claude'], status: 'stale' }])
  assert.match((await run('check', '--agent', 'claude')).stderr, /stale: CLAUDE\.md/)
  assert.match((await run('agent-block')).stdout, /gusta 블록 갱신: CLAUDE\.md/)

  await writeFile(path.join(root, 'CLAUDE.md'), `${await read(root, 'CLAUDE.md')}${BEGIN_PREFIX} again -->\n`)
  const broken = await run('agent-block')
  assert.equal(broken.code, 1); assert.match(broken.stderr, /추측해서 고치지 않습니다[\s\S]*broken: CLAUDE\.md \(duplicate markers, line 5, 14, 15\)/)
  assert.equal((await run('check', '--agent', 'claude')).code, 1)
  // false: check passes whatever the file holds, and --remove still refuses to guess.
  await vibeSettings({ root, set: ['agent-block=false'] })
  assert.equal((await run('check', '--agent', 'claude')).code, 0)
  assert.equal((await run('agent-block', '--remove')).code, 1)
  await writeFile(path.join(root, 'CLAUDE.md'), `# Project\n\n- my rule\n\n${BLOCK}\n`)
  assert.match((await run('agent-block', '--remove')).stdout, /gusta 블록 제거: CLAUDE\.md/)
  assert.equal(await read(root, 'CLAUDE.md'), '# Project\n\n- my rule\n')
  assert.match((await run('agent-block', '--check', '--remove')).stderr, /함께 쓸 수 없습니다/)
  assert.match((await run('lint', '--check')).stderr, /알 수 없는 옵션/)
})

test('맡김: agent-block 미정은 status의 unset에만 나오고 preflight·반영을 막거나 파일을 쓰지 않는다', async (t) => {
  const { root } = await fixture(t, 1)
  assert.deepEqual((await vibeStatus({ targetRoot: root })).settings.unset, ['land', 'version', 'agent-block'])
  await vibeSettings({ root, set: ['land=current'] })
  await git(root, 'add', '-A'); await git(root, 'commit', '-q', '-m', 'settings')
  const status = await vibeStatus({ targetRoot: root })
  assert.deepEqual([status.settings.unset, status.route], [['version', 'agent-block'], 'implementation'])
  const preflight = await vibePreflight({ targetRoot: root })
  assert.deepEqual([preflight.ok, preflight.needsUser], [true, []])
  assert.match(preflight.checks.find((check) => check.name === 'branch-settings').detail, /^land current/)
  assert.ok(!JSON.stringify(preflight).includes('agent-block'))
  // land is decided, so finished work still lands as SETTINGS says: never "land-unset".
  assert.equal((await vibePush({ targetRoot: root })).reason, 'push-disabled')
  await missing(path.join(root, 'CLAUDE.md')); await missing(path.join(root, 'AGENTS.md'))
})
