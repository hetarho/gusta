import assert from 'node:assert/strict'
import { chmod, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { checkSkills, installSkills, LOCK_FILE, SkillPackageError } from '../src/index.mjs'

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gusta-installer-'))
  const skillsRoot = path.join(root, 'source')
  const targetRoot = path.join(root, 'target')
  const skillRoot = path.join(skillsRoot, 'create-plan')

  await mkdir(path.join(skillRoot, 'agents'), { recursive: true })
  await mkdir(path.join(skillRoot, 'scripts'), { recursive: true })
  await mkdir(targetRoot, { recursive: true })
  await writeFile(
    path.join(skillRoot, 'SKILL.md'),
    '---\nname: create-plan\ndescription: Create a plan\n---\n\n# Create plan\n',
  )
  await writeFile(path.join(skillRoot, 'agents', 'openai.yaml'), 'interface:\n  display_name: Plan\n')
  await writeFile(path.join(skillRoot, 'scripts', 'run.sh'), '#!/bin/sh\necho plan\n')
  await chmod(path.join(skillRoot, 'scripts', 'run.sh'), 0o755)

  return { root, skillsRoot, targetRoot, skillRoot }
}

test('하나의 원본을 Claude와 Codex 구조에 맞게 설치한다', async () => {
  const fixture = await createFixture()
  const result = await installSkills({
    skillsRoot: fixture.skillsRoot,
    targetRoot: fixture.targetRoot,
    packageVersion: '1.0.0',
  })

  assert.equal(result.counts.create, 5)
  assert.match(
    await readFile(path.join(fixture.targetRoot, '.claude/skills/create-plan/SKILL.md'), 'utf8'),
    /Create plan/,
  )
  await assert.rejects(
    readFile(path.join(fixture.targetRoot, '.claude/skills/create-plan/agents/openai.yaml')),
    { code: 'ENOENT' },
  )
  assert.match(
    await readFile(
      path.join(fixture.targetRoot, '.codex/skills/create-plan/agents/openai.yaml'),
      'utf8',
    ),
    /display_name/,
  )
  const lock = JSON.parse(await readFile(path.join(fixture.targetRoot, LOCK_FILE), 'utf8'))
  assert.equal(lock.packageVersion, '1.0.0')
  assert.deepEqual(lock.agents, ['claude', 'codex'])
})

test('패키지가 설치한 변경 전 파일은 다음 버전으로 자동 갱신한다', async () => {
  const fixture = await createFixture()
  await installSkills({
    skillsRoot: fixture.skillsRoot,
    targetRoot: fixture.targetRoot,
    packageVersion: '1.0.0',
  })
  await writeFile(
    path.join(fixture.skillRoot, 'SKILL.md'),
    '---\nname: create-plan\ndescription: Create a plan\n---\n\n# Updated plan\n',
  )

  const result = await installSkills({
    skillsRoot: fixture.skillsRoot,
    targetRoot: fixture.targetRoot,
    packageVersion: '1.1.0',
  })

  assert.equal(result.counts.update, 2)
  assert.equal((await checkSkills(fixture)).ok, true)
})

test('소비자 프로젝트의 로컬 수정은 --force 없이는 덮어쓰지 않는다', async () => {
  const fixture = await createFixture()
  await installSkills({
    skillsRoot: fixture.skillsRoot,
    targetRoot: fixture.targetRoot,
    packageVersion: '1.0.0',
  })
  const installedSkill = path.join(fixture.targetRoot, '.codex/skills/create-plan/SKILL.md')
  await writeFile(installedSkill, 'local edit\n')

  await assert.rejects(
    installSkills({
      skillsRoot: fixture.skillsRoot,
      targetRoot: fixture.targetRoot,
      agents: ['codex'],
      packageVersion: '1.0.0',
    }),
    (error) => error instanceof SkillPackageError && /충돌/.test(error.message),
  )

  await installSkills({
    skillsRoot: fixture.skillsRoot,
    targetRoot: fixture.targetRoot,
    agents: ['codex'],
    force: true,
    packageVersion: '1.0.0',
  })
  assert.match(await readFile(installedSkill, 'utf8'), /Create plan/)
})

test('잠금 파일의 대상 밖 경로를 거부한다', async () => {
  const fixture = await createFixture()
  await writeFile(
    path.join(fixture.targetRoot, LOCK_FILE),
    `${JSON.stringify({
      schemaVersion: 1,
      packageName: '@haeram/gusta',
      files: {
        '.codex/skills/../../../outside.txt': { sha256: 'a'.repeat(64) },
      },
    })}\n`,
  )

  await assert.rejects(
    installSkills({
      skillsRoot: fixture.skillsRoot,
      targetRoot: fixture.targetRoot,
      packageVersion: '1.0.0',
    }),
    (error) => error instanceof SkillPackageError && /안전하지 않거나/.test(error.message),
  )
})

test('0.5 → 0.6 lock upgrades both agents and new references without overwriting project FORMAT', async () => {
  const fixture = await createFixture()
  await mkdir(path.join(fixture.targetRoot, 'spec'), { recursive: true })
  const format = path.join(fixture.targetRoot, 'spec/FORMAT.md')
  await writeFile(format, '# Project notation\ncustom contracts\n')
  await installSkills({ ...fixture, packageVersion: '0.5.0' })
  await mkdir(path.join(fixture.skillRoot, 'references'))
  await writeFile(path.join(fixture.skillRoot, 'references/tiers.md'), '# Conditional verification\n')
  await installSkills({ ...fixture, packageVersion: '0.6.0' })
  const lock = JSON.parse(await readFile(path.join(fixture.targetRoot, LOCK_FILE), 'utf8'))
  assert.equal(lock.packageVersion, '0.6.0')
  for (const agent of ['claude', 'codex']) assert.ok(lock.files[`.${agent}/skills/create-plan/references/tiers.md`])
  assert.equal(await readFile(format, 'utf8'), '# Project notation\ncustom contracts\n')
  assert.equal((await checkSkills(fixture)).ok, true)
})
