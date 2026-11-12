import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import test from 'node:test'

const skillsRoot = new URL('../skills/', import.meta.url)
const HEADING = '## 공통 규칙 (모든 spec 스킬)'
const MODE = 'gusta-start가 맡긴 실행(실행기·loop 단위 포함)에서는 묻지 않는다 — 추천안으로 진행하고 STATE inbox와 보고서에 남긴다(되돌리기 어렵거나 프로젝트 밖에 영향을 주는 일은 주차). 권한 확인 창도 질문이다 — 창이 뜰 만한 명령은 실행하지 않고 주차한다(gusta-start 3절). 사용자가 직접 부른 스킬(gusta-sketch 등)은 묻는다.'
// CLAUDE.md principle 2: the same five rules everywhere, except these documented wordings.
const EXCEPTIONS = { 1: ['gusta-create-architecture', 'gusta-start'], 3: ['gusta-create-narrative'], 4: ['gusta-create-narrative'] }
// Meta skills review this skill set itself; they write no spec documents and carry no common rules.
const META = ['gusta-send-issue', 'gusta-preference', 'gusta-init', 'gusta-update']

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

test('메타 스킬 gusta-send-issue는 익명화한 회고를 확인받은 뒤 package.json의 저장소에 이슈로만 보낸다', async () => {
  const text = await readFile(new URL('gusta-send-issue/SKILL.md', skillsRoot), 'utf8')
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const repo = pkg.repository.url.match(/github\.com\/([^/]+\/[^/.]+)/)[1]
  assert.ok(!text.includes(HEADING)); assert.match(text, /읽기 전용/); assert.match(text, /````markdown/); assert.match(text, /익명화/)
  assert.ok(text.includes(`gh issue create --repo ${repo} `), `이슈 대상이 package.json 저장소(${repo})와 다릅니다`)
  assert.ok(text.includes(`https://github.com/${repo}/issues/new`)); assert.match(text, /확인을 받기 전에는 올리지 않는다/)
  for (const other of text.matchAll(/hetarho\/[A-Za-z0-9_-]+/g)) assert.equal(other[0], repo)
})

test('메타 스킬 gusta-preference는 공통 규칙 없이 CLI(vibe settings)로만 설정을 보고 바꾼다', async () => {
  const text = await readFile(new URL('gusta-preference/SKILL.md', skillsRoot), 'utf8')
  assert.ok(!text.includes(HEADING)); assert.match(text, /vibe settings --json/); assert.match(text, /vibe settings --set/); assert.match(text, /직접 편집하지 않는다/)
})

test('spec 스킬은 gusta-sketch·gusta-self-improve·gusta-showcase를 포함해 16종이고 모두 공통 규칙 5줄을 가진다', async () => {
  const rules = await commonRules()
  assert.deepEqual([...rules.keys()].sort(), ['gusta-create-architecture', 'gusta-create-narrative', 'gusta-create-ssot', 'gusta-create-task', 'gusta-design-mode', 'gusta-doc-review', 'gusta-implement-task', 'gusta-manage-work', 'gusta-review-code', 'gusta-review-task', 'gusta-self-improve', 'gusta-self-improve-remote', 'gusta-showcase', 'gusta-sketch', 'gusta-start', 'gusta-update-ssot'])
})

test('공통 규칙 1번은 미정 설정(settings.unset)을 gusta-init으로 먼저 정하게 하고 맡김은 묻지 않는다', async () => {
  for (const [name, entry] of await commonRules()) assert.ok(entry['1'].endsWith('`settings.unset`이 있으면 gusta-init으로 먼저 정한다(맡김·실행기 배정은 묻지 않고 현재 브랜치에 커밋만 한다).'), `${name}: 공통 규칙 1번에 설정 확인이 없습니다.`)
})

test('spec 스킬은 브랜치 대상을 고정하지 않는다: main 반영·cfg push/plan 대신 SETTINGS', async () => {
  for (const entry of await readdir(skillsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || META.includes(entry.name)) continue
    const text = await readFile(new URL(`${entry.name}/SKILL.md`, skillsRoot), 'utf8')
    assert.doesNotMatch(text, /main (반영|에 push|으로 push)|cfg push|cfg plan|기본 `main`/, `${entry.name}: 고정된 브랜치 대상`)
  }
})

test('메타 스킬 gusta-init·gusta-update는 CLI로 설정·이관하고 맡김에서는 묻지 않는다', async () => {
  const init = await readFile(new URL('gusta-init/SKILL.md', skillsRoot), 'utf8')
  assert.match(init, /vibe settings --set land=/); assert.match(init, /맡김/); assert.match(init, /migrate/)
  const update = await readFile(new URL('gusta-update/SKILL.md', skillsRoot), 'utf8')
  for (const pattern of [/gusta outdated/, /gusta install --dry-run/, /gusta migrate --dry-run/, /format\.missing/, /덮어쓰지 않는다/, /gusta-init/]) assert.match(update, pattern)
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
