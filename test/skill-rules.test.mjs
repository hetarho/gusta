import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import test from 'node:test'

const skillsRoot = new URL('../skills/', import.meta.url)
const HEADING = '## 공통 규칙 (모든 spec 스킬)'
const MODE = 'gusta-start가 맡긴 실행(실행기·loop 단위 포함)에서는 묻지 않는다 — 추천안으로 진행하고 inbox(`vibe inbox add`)와 보고서에 남긴다(되돌리기 어렵거나 프로젝트 밖에 영향을 주는 일은 주차). 권한 확인 창도 질문이다 — 창이 뜰 만한 명령은 실행하지 않고 주차한다(gusta-start 3절). 사용자가 직접 부른 스킬(gusta-sketch 등)은 묻는다.'
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
  assert.match(text, /`agent-block`을 바꿨으면 `npx @haeram\/gusta agent-block`\(false로 바꿨으면 `--remove`\)을 실행/)
})

test('spec 스킬은 gusta-sketch·gusta-self-improve·gusta-showcase를 포함해 16종이고 모두 공통 규칙 5줄을 가진다', async () => {
  const rules = await commonRules()
  assert.deepEqual([...rules.keys()].sort(), ['gusta-create-architecture', 'gusta-create-narrative', 'gusta-create-ssot', 'gusta-create-task', 'gusta-design-mode', 'gusta-doc-review', 'gusta-implement-task', 'gusta-manage-work', 'gusta-review-code', 'gusta-review-task', 'gusta-self-improve', 'gusta-self-improve-remote', 'gusta-showcase', 'gusta-sketch', 'gusta-start', 'gusta-update-ssot'])
})

test('공통 규칙 1번은 미정 설정(settings.unset)을 gusta-init으로 먼저 정하게 하고 맡김은 묻지 않는다', async () => {
  for (const [name, entry] of await commonRules()) assert.ok(entry['1'].endsWith('`settings.unset`이 있으면 gusta-init으로 먼저 정한다(맡김·실행기 배정은 묻지 않는다 — land 미정이면 현재 브랜치에 커밋만 한다).'), `${name}: 공통 규칙 1번에 설정 확인이 없습니다.`)
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
  // The managed block of CLAUDE.md/AGENTS.md is written by the CLI only, after the owner said yes once.
  for (const pattern of [/agent-block --check --json/, /`npx @haeram\/gusta agent-block`으로 적용/, /직접 편집하지 않는다/, /agent-block 미정이면 지침 파일을 쓰지 않고/]) assert.match(init, pattern)
  for (const pattern of [/`gusta install`, `gusta agent-block`, `gusta check` 순서/, /broken이면 아무것도 쓰지 않는다/, /승인받아/]) assert.match(update, pattern)
  // The session sections move to the coordination branch; a taken name is changed, never forced, and every machine upgrades together.
  for (const pattern of [/STATE의 active·inbox·log를 조정 브랜치\(SETTINGS `coord`, 기본 `gusta`\)의 SESSIONS\.md로 옮긴다/, /`vibe settings --set coord=<다른 이름>`/, /모든 기기를 함께 올리라고/]) assert.match(update, pattern)
  // One question decides land·land-via·deploy: is there a development branch? The default branch is never named here.
  for (const pattern of [/"개발\(통합\) 브랜치를 운영합니까\?"/, /아니오: [^\n]*`land=<기본>`, `land-via=merge`, `deploy=-`/, /예: [^\n]*`develop`을 새로 만드는 안을 추천[^\n]*`land=<통합>`, `deploy=<기본>`/, /그 밖: PR[^\n]*`land-via=pr`[^\n]*커밋만[^\n]*`land=current`/]) assert.match(init, pattern)
  assert.doesNotMatch(init.slice(init.indexOf('## 2.'), init.indexOf('## 3.')), /\b(main|master)\b/)
  // version is asked once with what it means for releases; autopilot leaves it undecided.
  for (const pattern of [/\*\*version\*\*: [^\n]*\(auto\/off\)/, /major는 사람이 직접 올린다/, /반영이 곧 릴리스/, /`package\.json`에 `version`이 없거나 land-via가 pr이면 적용되지 않는다고 알리고 `off`로 쓴다/, /version 미정이면 버전을 올리지 않고 미정으로 둔다/]) assert.match(init, pattern)
})

test('공통 규칙 2번은 디자인 중 커밋·push 전에 디자인이 끝났는지 묻게 한다', async () => {
  for (const [name, entry] of await commonRules()) assert.ok(entry['2'].includes('`vibe status`에 `design`이 있으면(이 checkout이 디자인 중) 커밋·push 전에 사용자에게 디자인이 끝났는지 묻고'), `${name}: 공통 규칙 2번에 디자인 확인이 없습니다.`)
})

// Session records live in SESSIONS.md on the coordination branch: skills reach them through vibe only.
test('공통 규칙 2번은 세션 기록을 vibe 명령으로만 남기고 SESSIONS.md를 직접 고치지 않게 한다', async () => {
  for (const [name, entry] of await commonRules()) {
    assert.ok(entry['2'].includes('세션 기록(시작·상태 변화·활동)을 `vibe` 명령으로만(`beat`·`claim`·`inbox`·`log`) 남기고 SESSIONS.md를 직접 고치지 않는다.'), `${name}: 공통 규칙 2번에 세션 기록 규칙이 없습니다.`)
    assert.ok(entry['2'].includes('워커는 STATE·SSOT·세션 기록 대신 runtime과'), `${name}: 공통 규칙 2번에 워커 규칙이 없습니다.`)
  }
})

// STATE no longer has active·inbox·log: a skill sentence that edits them there would write a section lint rejects.
test('스킬 본문·references는 STATE의 옛 세션 섹션(active·inbox·log)에 직접 쓰라고 하지 않는다', async () => {
  const stale = /STATE(의)? ?(inbox|log|active|`## (inbox|log|active)`)|STATE: log|log에 `- YYMMDD|, log 1줄|\/ log 1줄/
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const url = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, directory)
      if (entry.isDirectory()) { if (entry.name !== 'assets') await visit(url); continue }
      if (!entry.name.endsWith('.md')) continue
      for (const [index, line] of (await readFile(url, 'utf8')).split('\n').entries()) {
        // The one sentence that names them: gusta-update moves them to the coordination branch.
        if (!line.includes('SESSIONS.md로 옮긴다')) assert.doesNotMatch(line, stale, `${url.pathname.split('/skills/')[1]}:${index + 1}`)
      }
    }
  }
  await visit(skillsRoot)
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

test('gusta-start: 인자 없으면 STATE·태스크로 실행하고, 기획 변경 요청이면 SSOT·태스크부터 만들어 그 범위만 구현한다', async () => {
  const start = await readFile(new URL('gusta-start/SKILL.md', skillsRoot), 'utf8')
  const request = await readFile(new URL('gusta-start/references/request.md', skillsRoot), 'utf8')
  assert.match(start, /인자가 없으면 STATE·태스크대로 실행한다/)
  assert.match(start, /\[요청 실행\]\(references\/request\.md\)/)
  assert.match(start, /기획 변경 요청 인자 없이 실행할 태스크가 없으면\(route `sketch-first`\)/)
  for (const pattern of [/시작 대화만 읽는다/, /요청문이 직접 정한 것은 사용자 결정이다/, /`vibe plan-sync`/, /`vibe plan-push`/, /gusta-update-ssot/, /gusta-create-task/, /`vibe loop --tasks '<범위>'`/, /다른 기존 태스크는 하지 않는다/, /`\[\?\]`/]) assert.match(request, pattern)
  for (const name of ['gusta-update-ssot', 'gusta-create-ssot']) assert.match(await readFile(new URL(`${name}/SKILL.md`, skillsRoot), 'utf8'), /gusta-start 요청 실행이면 요청문이/, name)
})

test('검증 단계 계약: 태스크 검사는 커밋 직전 한 번, 태스크는 태스크 단계 검사만 적고, ARCH는 세 단계를 선언한다', async () => {
  const read = (file) => readFile(new URL(file, skillsRoot), 'utf8')
  assert.match(await read('gusta-implement-task/SKILL.md'), /바뀐 범위의 태스크 단계 검사[^\n]*커밋 직전에 `vibe check --tier task`로 한 번[^\n]*편집할 때마다 반복하지 않/)
  assert.match(await read('gusta-create-task/SKILL.md'), /acceptance·검증 줄에는 태스크 단계 검사[^\n]*빌드·통합·e2e·전체 스위트는 적지 않고 최종 관문/)
  assert.match(await read('gusta-create-task/assets/task.md'), /task-tier checks only: build, full suite and e2e run at the final gate/)
  assert.match(await read('gusta-create-architecture/SKILL.md'), /세 단계를 모두 명시적으로 선언한다[^\n]*1분 넘게 걸리는\(측정 또는 예상\) 검사는 task가 아니라 batch/)
  const format = await read('gusta-create-architecture/assets/FORMAT.md')
  for (const pattern of [/a task names task-tier checks only/, /declares all three tiers as `task`, `batch` \(a work group's `--group-verify`\), `CI`/, /A check over a minute \(measured or expected\) goes under batch, not task/]) assert.match(format, pattern)
  assert.match(await read('gusta-update/references/project-rules.md'), /단계 선언이 없거나\(lint 검토 후보\) 태스크 단계에 느린 명령이 있으면\(`vibe status`의 `taskChecks\.slow`/)
  // The same contract reaches headless sessions through the CLI's prompt (a variant here: no skill files read).
  const { agentPrompt } = await import('../src/agent-adapter.mjs')
  assert.match(await agentPrompt({ role: 'variant', workspace: '/tmp/w', prompt: 'p' }), /task-tier checks of the changed scope [^.]*once, when the edits are done and before any commit, with vibe check --tier task[^;]*; never after each edit/)
})
