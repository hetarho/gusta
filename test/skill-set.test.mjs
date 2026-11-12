import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { discoverSkills, SkillPackageError } from '../src/index.mjs'

async function temporarySkillsRoot() {
  return mkdtemp(path.join(os.tmpdir(), 'gusta-skill-set-'))
}

async function addSkill(root, folderName, frontmatterName = folderName) {
  const skillRoot = path.join(root, folderName)
  await mkdir(skillRoot, { recursive: true })
  await writeFile(
    path.join(skillRoot, 'SKILL.md'),
    `---\nname: ${frontmatterName}\ndescription: Test skill\n---\n\n# Test\n`,
  )
}

test('유효한 스킬 폴더를 발견하고 정렬한다', async () => {
  const root = await temporarySkillsRoot()
  await addSkill(root, 'second-skill')
  await addSkill(root, 'first-skill')

  const skills = await discoverSkills({ skillsRoot: root })

  assert.deepEqual(
    skills.map((skill) => skill.name),
    ['first-skill', 'second-skill'],
  )
})

test('폴더명과 frontmatter name이 다르면 거부한다', async () => {
  const root = await temporarySkillsRoot()
  await addSkill(root, 'folder-name', 'different-name')

  await assert.rejects(
    discoverSkills({ skillsRoot: root }),
    (error) => error instanceof SkillPackageError && /일치하지 않습니다/.test(error.message),
  )
})

test('allowEmpty가 없으면 빈 배포를 거부한다', async () => {
  const root = await temporarySkillsRoot()

  await assert.rejects(discoverSkills({ skillsRoot: root }), SkillPackageError)
  assert.deepEqual(await discoverSkills({ skillsRoot: root, allowEmpty: true }), [])
})

