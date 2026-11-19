import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import test from 'node:test'
import { agentPrompt } from '../src/agent-adapter.mjs'

// Skill text is paid every time it is loaded (CLAUDE.md principle 14). These ceilings sit just above
// today's sizes: raising one needs the same change to cut as much somewhere else.
const BUDGET = {
  description: 340, // each frontmatter description: rides in every target session
  descriptions: 5200, // all of them together
  commonRules: 1600, // the five common rules, repeated in 17 spec skills
  skill: 11200, // one SKILL.md
  skills: 130000, // every SKILL.md together
  unitContract: 3800, // gusta-start/references/unit.md
  taskUnitPrompt: 12800, // the prompt of one loop unit with a task (contract + gusta-implement-task)
  unitPrompt: 6000, // the prompt of one loop unit without a task
  claudeMd: 11000, // this repository's CLAUDE.md, loaded in every development session
}

const root = new URL('../', import.meta.url)
const bytes = (text) => Buffer.byteLength(text, 'utf8')
const over = (what, size, limit) => `${what}: ${size}B > ${limit}B — 상한을 올리기 전에 같은 변경에서 줄일 곳을 찾는다 (CLAUDE.md 원칙 14)`

async function skills() {
  const result = []
  for (const entry of await readdir(new URL('skills/', root), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const text = await readFile(new URL(`skills/${entry.name}/SKILL.md`, root), 'utf8')
    const description = text.match(/^---\n[\s\S]*?\ndescription: >-\n((?: {2}[^\n]*\n)+)/)?.[1] ?? ''
    result.push({ name: entry.name, text, description: description.replace(/^ {2}/gm, '').trim() })
  }
  return result
}

test('스킬 설명은 언제 부를지만 말한다: 하나와 전체의 상한', async () => {
  const all = await skills()
  for (const { name, description } of all) {
    assert.ok(description, `${name}: description 없음`)
    assert.ok(bytes(description) <= BUDGET.description, over(`${name} description`, bytes(description), BUDGET.description))
  }
  const total = all.reduce((sum, { description }) => sum + bytes(description), 0)
  assert.ok(total <= BUDGET.descriptions, over('descriptions', total, BUDGET.descriptions))
})

test('SKILL.md 본문과 공통 규칙의 상한', async () => {
  const all = await skills()
  for (const { name, text } of all) assert.ok(bytes(text) <= BUDGET.skill, over(`${name}/SKILL.md`, bytes(text), BUDGET.skill))
  const total = all.reduce((sum, { text }) => sum + bytes(text), 0)
  assert.ok(total <= BUDGET.skills, over('SKILL.md total', total, BUDGET.skills))
  const plan = all.find(({ name }) => name === 'gusta-plan').text
  const lines = plan.split('\n')
  const rules = lines.slice(lines.indexOf('## 공통 규칙 (모든 spec 스킬)'), lines.indexOf('## 공통 규칙 (모든 spec 스킬)') + 6).join('\n')
  assert.ok(bytes(rules) <= BUDGET.commonRules, over('common rules', bytes(rules), BUDGET.commonRules))
})

test('loop 단위 프롬프트는 단위 계약만 싣는다: 계약·태스크 단위·태스크 없는 단위의 상한', async () => {
  const contract = await readFile(new URL('skills/gusta-start/references/unit.md', root), 'utf8')
  assert.ok(bytes(contract) <= BUDGET.unitContract, over('unit.md', bytes(contract), BUDGET.unitContract))
  const task = await agentPrompt({ role: 'unit', workspace: '/tmp/w', tag: 't1', brief: { taskId: 'T001' } })
  assert.ok(bytes(task) <= BUDGET.taskUnitPrompt, over('task unit prompt', bytes(task), BUDGET.taskUnitPrompt))
  const planning = await agentPrompt({ role: 'unit', workspace: '/tmp/w', tag: 't1' })
  assert.ok(bytes(planning) <= BUDGET.unitPrompt, over('unit prompt', bytes(planning), BUDGET.unitPrompt))
})

test('이 저장소 CLAUDE.md의 상한', async () => {
  const text = await readFile(new URL('CLAUDE.md', root), 'utf8')
  assert.ok(bytes(text) <= BUDGET.claudeMd, over('CLAUDE.md', bytes(text), BUDGET.claudeMd))
})
