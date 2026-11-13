import test from 'node:test'
import { vibeLoop, runVibeCheck } from './helpers/unit-policy.mjs'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fixture, git, archiveTask } from './helpers/vibe-fixture.mjs'



const passed = async () => ({ ok: true, checks: [] })
const nextCommand = 'node --check app.js'
async function revise(root, command) {
  const arch = path.join(root, 'spec/ssot/ARCH.md'), state = path.join(root, 'spec/STATE.md')
  await writeFile(arch, (await readFile(arch, 'utf8')).replace('> r1', '> r2')
    .replace('batch, before code push: `node --version`', command === null ? 'final checks are described separately' : `batch, before code push: \`${command}\``)
    .replace('## chg\n', '## chg\n- r2 261112 ARCH-2✎ final check node version→syntax check\n'))
  await writeFile(state, (await readFile(state, 'utf8')).replace('| ARCH | 1 | 1 |', '| ARCH | 2 | 2 |'))
  const task = path.join(root, 'spec/tasks/T001.example.md')
  const content = await readFile(task, 'utf8').catch((error) => { if (error.code !== 'ENOENT') throw error; return null })
  if (content !== null) await writeFile(task, content.replace('base:ARCH@1', 'base:ARCH@2'))
  await git(root, 'add', 'spec'); await git(root, 'commit', '-qm', 'revise verification policy')
}

for (const [name, content, override, expected, revised = nextCommand] of [
  ['valid revised gate', 'export const answer = 1\n', undefined, true],
  ['failing revised gate', 'export const =\n', undefined, false],
  ['explicit caller override', 'export const =\n', ['node --version'], true],
  ['removed final command', 'export const answer = 1\n', undefined, false, ''],
]) test(`loop refreshes an approved planning revision: ${name}`, async (t) => {
  const { root } = await fixture(t, 1)
  const seen = []; let units = 0, pushes = 0
  const result = await vibeLoop({ targetRoot: root, tag: 'verify01', provider: 'codex', maxUnits: 2, ...(override ? { verify: override } : {}) }, {
    preflight: passed,
    execute: async () => {
      if (++units === 1) {
        await revise(root, revised)
        return { exitCode: 0, result: { kind: 'planning', id: '', outcome: 'completed', pushed: false, next: 'implementation' } }
      }
      await archiveTask(root, 'T001')
      await writeFile(path.join(root, 'app.js'), content)
      await git(root, 'add', 'spec', 'app.js'); await git(root, 'commit', '-qm', 'complete implementation')
      return { exitCode: 0, result: { kind: 'task', id: 'T001', outcome: 'completed', pushed: false, next: '' } }
    },
    check: async (config, command) => { seen.push(command); return runVibeCheck(config, command) },
    push: async () => { pushes++; return { ok: true, pushed: null } },
  })
  assert.equal(result.ok, expected, result.error)
  assert.deepEqual(seen, override ?? (revised ? [revised] : []))
  assert.equal(pushes, expected ? 1 : 0)
  const saved = JSON.parse(await readFile(result.manifest, 'utf8'))
  assert.deepEqual(saved.verify.batch, revised ? [revised] : [])
  assert.deepEqual(saved.batchVerify, override ?? (revised ? [revised] : []))
  assert.deepEqual(result.batchVerify, saved.batchVerify)
  if (!expected) assert.match(result.error, revised ? /node --check app\.js/ : /묶음 검증이 없습니다/)
})

test('the final gate refreshes verification after target synchronization too', async (t) => {
  const { root } = await fixture(t, 1)
  await writeFile(path.join(root, 'spec/SETTINGS.md'), '# SETTINGS\n- land: main\n- push: true\n')
  await git(root, 'add', 'spec'); await git(root, 'commit', '-qm', 'publication settings')
  const seen = []; let synced = 0
  const result = await vibeLoop({ targetRoot: root, tag: 'verify01', provider: 'codex', maxUnits: 1 }, {
    preflight: passed,
    sync: async () => { synced++; await revise(root, nextCommand); return { ok: true } },
    execute: async () => {
      await archiveTask(root, 'T001')
      await writeFile(path.join(root, 'app.js'), 'export const answer = 1\n')
      await git(root, 'add', 'spec', 'app.js'); await git(root, 'commit', '-qm', 'complete implementation')
      return { exitCode: 0, result: { kind: 'task', id: 'T001', outcome: 'completed', pushed: false, next: '' } }
    },
    check: async (config, command) => { seen.push(command); return runVibeCheck(config, command) },
    push: async () => ({ ok: true, pushed: null }),
  })
  assert.equal(result.ok, true, result.error)
  assert.equal(synced, 1)
  assert.deepEqual(seen, [nextCommand])
  assert.deepEqual(result.verify.batch, [nextCommand])
})

for (const command of [nextCommand, '']) test(`a planning-only gate ${command ? 'revision' : 'removal'} cannot bypass final verification`, async (t) => {
  const { root } = await fixture(t, 1)
  await writeFile(path.join(root, 'app.js'), 'export const =\n')
  await git(root, 'add', 'app.js'); await git(root, 'commit', '-qm', 'existing implementation')
  const seen = []
  const result = await vibeLoop({ targetRoot: root, tag: 'verify01', provider: 'codex', maxUnits: 1 }, {
    preflight: passed,
    execute: async () => {
      await revise(root, command)
      return { exitCode: 0, result: { kind: 'planning', id: '', outcome: 'completed', pushed: false, next: 'implementation' } }
    },
    check: async (config, check) => { seen.push(check); return runVibeCheck(config, check) },
    push: () => assert.fail('changed verification requirements must not publish without their gate'),
  })
  assert.equal(result.ok, false)
  assert.deepEqual(seen, command ? [command] : [])
  assert.match(result.error, command ? /node --check app\.js/ : /묶음 검증이 없습니다/)
})

for (const removeAll of [false, true]) test(`an incomplete verification revision stays blocked on restart (${removeAll ? 'all tier labels removed' : 'partial tiers'}) until repaired`, async (t) => {
  const { root, arch } = await fixture(t, 1)
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { verify: 'node --version' } }))
  await git(root, 'add', 'package.json'); await git(root, 'commit', '-qm', 'legacy fallback is available')
  let units = 0
  const options = { targetRoot: root, tag: 'verify01', provider: 'codex', maxUnits: 2 }
  const blocked = {
    preflight: passed,
    execute: async () => {
      units++; await revise(root, null)
      if (removeAll) {
        const file = path.join(root, 'spec/ssot/ARCH.md')
        await writeFile(file, (await readFile(file, 'utf8')).replace(/^  - (task|CI),.*\n/gm, ''))
        await git(root, 'add', 'spec'); await git(root, 'commit', '-qm', 'remove remaining tier labels')
      }
      return { exitCode: 0, result: { kind: 'planning', id: '', outcome: 'completed', pushed: false, next: 'implementation' } }
    },
    check: () => assert.fail('no current executable gate is configured'),
    push: () => assert.fail('invalid verification must not publish'),
  }
  const result = await vibeLoop(options, blocked)
  assert.equal(result.ok, false)
  assert.equal(units, 1)
  assert.match(result.error, /ARCH 검증 단계가 불완전/)
  const saved = JSON.parse(await readFile(result.manifest, 'utf8'))
  assert.equal(saved.requiredVerificationTiers, true)
  await assert.rejects(vibeLoop(options, blocked), /ARCH 검증 단계가 불완전/)
  assert.equal(units, 1, 'restart must not dispatch a unit or run the legacy fallback')
  // Older manifests recorded the declared contract without the new requirement field.
  const legacy = { ...saved, verify: { ...saved.verify, declared: true } }
  delete legacy.requiredVerificationTiers; delete legacy.verify.partial
  await writeFile(result.manifest, JSON.stringify(legacy))
  await assert.rejects(vibeLoop(options, blocked), /ARCH 검증 단계가 불완전/)
  assert.equal(units, 1, 'an old manifest must retain its known tier obligation too')
  // Repair the actual policy, retaining its revisions rather than manufacturing a child receipt.
  await writeFile(path.join(root, 'spec/ssot/ARCH.md'), arch.replace('> r1', '> r3')
    .replace('batch, before code push: `node --version`', `batch, before code push: \`${nextCommand}\``)
    .replace('## chg\n', '## chg\n- r3 261112 ARCH-2✎ incomplete→restored explicit tiers\n- r2 261112 ARCH-2✎ explicit→incomplete tiers\n'))
  for (const [file, from, to] of [['STATE.md', '| ARCH | 2 | 2 |', '| ARCH | 3 | 3 |'], ['tasks/T001.example.md', 'base:ARCH@2', 'base:ARCH@3']]) {
    const target = path.join(root, 'spec', file)
    await writeFile(target, (await readFile(target, 'utf8')).replace(from, to))
  }
  await git(root, 'add', 'spec'); await git(root, 'commit', '-qm', 'repair verification contract')
  const seen = []
  const repaired = await vibeLoop({ ...options, maxUnits: 1 }, {
    preflight: passed,
    execute: async () => {
      await archiveTask(root, 'T001')
      await writeFile(path.join(root, 'app.js'), 'export const answer = 1\n')
      await git(root, 'add', 'spec', 'app.js'); await git(root, 'commit', '-qm', 'complete implementation')
      return { exitCode: 0, result: { kind: 'task', id: 'T001', outcome: 'completed', pushed: false, next: '' } }
    },
    check: async (config, command) => { seen.push(command); return runVibeCheck(config, command) },
    push: async () => ({ ok: true, pushed: null }),
  })
  assert.equal(repaired.ok, true, repaired.error)
  assert.deepEqual(seen, [nextCommand])
})

for (const explicit of [false, true]) test(`${explicit ? 'explicit override permits a partial contract' : 'true legacy selects familiar scripts without executing prose'}`, async (t) => {
  const { root } = await fixture(t, 1)
  const file = path.join(root, 'spec/ssot/ARCH.md')
  let arch = (await readFile(file, 'utf8')).replace('batch, before code push: `node --version`', 'a prose example: `node -e "process.exit(33)"`')
  if (!explicit) arch = arch.replace(/^  - (task|CI),.*\n/gm, '')
  await writeFile(file, arch)
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { verify: nextCommand } }))
  await git(root, 'add', 'spec', 'package.json'); await git(root, 'commit', '-qm', 'legacy or partial verification fixture')
  const seen = []
  const result = await vibeLoop({ targetRoot: root, tag: 'verify01', provider: 'codex', maxUnits: 1, ...(explicit ? { verify: [nextCommand] } : {}) }, {
    preflight: passed,
    execute: async () => {
      await archiveTask(root, 'T001')
      await writeFile(path.join(root, 'app.js'), 'export const answer = 1\n')
      await git(root, 'add', 'spec', 'app.js'); await git(root, 'commit', '-qm', 'complete implementation')
      return { exitCode: 0, result: { kind: 'task', id: 'T001', outcome: 'completed', pushed: false, next: '' } }
    },
    check: async (config, command) => { seen.push(command); return runVibeCheck(config, command) },
    push: async () => ({ ok: true, pushed: null }),
  })
  assert.equal(result.ok, true, result.error)
  assert.deepEqual(seen, explicit ? [nextCommand] : ['npm run verify'])
  assert.equal(result.verify.partial, explicit)
})
