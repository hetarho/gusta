import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import test from 'node:test'

const skillsRoot = new URL('../skills/', import.meta.url)
const HEADING = '## 공통 규칙 (모든 spec 스킬)'
const MODE = '맡김 모드(start-vibe)에서는 묻지 않는다 — 추천안으로 진행하고 STATE inbox와 보고서에 남긴다(되돌리기 어렵거나 프로젝트 밖에 영향을 주는 일은 주차). 권한 확인 창도 질문이다 — 창이 뜰 만한 명령은 실행하지 않고 주차한다(start-vibe 3절). 모드가 정해지지 않았으면 함께 모드다.'
// CLAUDE.md principle 2: the same five rules everywhere, except these documented wordings.
const EXCEPTIONS = { 1: ['create-architecture', 'ideation', 'start-vibe'], 3: ['create-narrative', 'ideation'], 4: ['create-narrative', 'ideation'] }
// Meta skills review this skill set itself; they write no spec documents and carry no common rules.
const META = ['haeram-report']

async function commonRules() {
  const result = new Map()
  for (const entry of await readdir(skillsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || META.includes(entry.name)) continue
    const lines = (await readFile(new URL(`${entry.name}/SKILL.md`, skillsRoot), 'utf8')).split('\n')
    const start = lines.indexOf(HEADING)
    assert.notEqual(start, -1, `${entry.name}: ${HEADING} 없음`)
    const rules = {}
    for (const line of lines.slice(start + 1, start + 6)) {
      const match = line.match(/^([1-5])\. (.+)$/)
      assert.ok(match, `${entry.name}: 공통 규칙 줄 형식 — ${line}`)
      rules[match[1]] = match[2]
    }
    result.set(entry.name, rules)
  }
  return result
}

test('메타 스킬 haeram-report는 읽기 전용 회고이며 공통 규칙 없이 코드 블록 하나를 돌려준다', async () => {
  const text = await readFile(new URL('haeram-report/SKILL.md', skillsRoot), 'utf8')
  assert.ok(!text.includes(HEADING)); assert.match(text, /읽기 전용/); assert.match(text, /````markdown/); assert.match(text, /익명화/)
})

test('spec 스킬은 self-improve-local을 포함해 15종이고 모두 공통 규칙 5줄을 가진다', async () => {
  const rules = await commonRules()
  assert.deepEqual([...rules.keys()].sort(), ['create-architecture', 'create-narrative', 'create-ssot', 'create-task', 'doc-review', 'ideation', 'implement-task', 'manage-work', 'review-code', 'review-task', 'self-improve', 'self-improve-local', 'start-design', 'start-vibe', 'update-ssot'])
})

test('공통 규칙 2번은 디자인 중 커밋·push 전에 디자인이 끝났는지 묻게 한다', async () => {
  for (const [name, entry] of await commonRules()) assert.ok(entry['2'].includes('`vibe status`에 `design`이 있으면(이 checkout이 디자인 중) 커밋·push 전에 사용자에게 디자인이 끝났는지 묻고'), `${name}: 공통 규칙 2번에 디자인 확인이 없습니다.`)
})

test('공통 규칙은 정해진 예외 스킬 밖에서 한 글자까지 같다 (5번 읽기·2번 문서 먼저는 예외 없음)', async () => {
  const rules = await commonRules()
  for (const number of ['1', '2', '3', '4', '5']) {
    const exempt = EXCEPTIONS[number] ?? []
    const texts = new Set([...rules].filter(([name]) => !exempt.includes(name)).map(([, entry]) => entry[number]))
    assert.equal(texts.size, 1, `공통 규칙 ${number}번이 스킬마다 다릅니다:\n${[...texts].join('\n')}`)
  }
})

test('공통 규칙 4번은 모든 스킬에서 같은 모드 문장으로 끝난다', async () => {
  for (const [name, entry] of await commonRules()) assert.ok(entry['4'].endsWith(MODE), `${name}: 공통 규칙 4번에 모드 문장이 없습니다.`)
})
