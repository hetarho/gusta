import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { lintSpec } from '../src/spec-lint.mjs'

const STATE = `# STATE
> control tower

## cfg
- level: mid  # expert|mid|novice
- lang: ko
- docs: en

## ssot
| id | rev | tasked | pending | [?] |
|---|---|---|---|---|
| ARCH | 2 | 2 | - | 1 |

## tasks
| id | title | ssot | dep | st |
|---|---|---|---|---|
| T002 | api | ARCH | T001 | todo |

## next
- gusta-implement-task T002

## log
- 260905 T001 done
- 260905 gusta-create-task ARCH start
`

const ARCH = `# ARCH architecture
> r2 | base architecture

## decisions
- ARCH-1 [o] stack: next 15 ← ecosystem
- ARCH-2 [?] deploy target

## chg
- r2 260905 ARCH-2+
- r1 260905 initial
`

const T001 = `# T001 scaffold
> st:done@260905 | ssot:ARCH-1 | base:ARCH@1 | dep:-

## goal
scaffold the project

## acceptance
- [v] project builds

## impl notes
- pnpm

## result
- done, files created
`

const T002 = `# T002 api
> st:todo | ssot:ARCH-1 ARCH-2 | base:ARCH@2 | dep:T001

## goal
first api

## acceptance
- [ ] GET /health returns 200
- [ ] test covers the route

## impl notes
- hono

## result
`

const REVIEW_STATE = STATE.replace(
  '## tasks\n',
  '## review\n| id | st |\n|---|---|\n| api-260906 | ready@260906 |\n\n## tasks\n',
)

const REVIEW = `# REVIEW api-260906
> st:ready@260906 | scope:src/api | at:abc1234 | base:ARCH@2

## summary
- handlers duplicate validation

## findings
- F1 [o] P1 src/api/*.ts: request validation copied in 3 handlers ← one fix must be applied 3 times
- F2 [x] P3 src/api/util.ts: rename helpers ← not worth the churn
- F3 [o] P2 src/api/health.ts: no test ← regressions go unnoticed →T002

## notes
- -
`

const IDEATION_STATE = STATE.replace('## ssot\n', '## ideation\n| id | st |\n|---|---|\n| outline | ready@260906 |\n\n## ssot\n')
const IDEATION = `# IDEATION outline
> st:ready@260906 | clarify the project foundation

## vision
Keep project conventions explicit.

## explored
- [o] Write the foundation rules first ← a shared starting point
- [x] Start with a separate tool ← outside this scope

## shape
- flow: discuss → document
- v1: foundation / not: tooling

## domains
- [o] ARCH: foundation rules →ARCH

## open
- -
`
const CONVERTED_IDEATION = IDEATION.replace('st:ready@', 'st:converted@')

async function writeFixture(
  root,
  {
    state = STATE,
    arch = ARCH,
    tasks = { 'T002.api.md': T002 },
    done = { 'T001.scaffold.md': T001 },
    review = {},
    ideation = {},
  } = {},
) {
  const specRoot = path.join(root, 'spec')
  await mkdir(path.join(specRoot, 'ssot'), { recursive: true })
  await mkdir(path.join(specRoot, 'tasks', 'done'), { recursive: true })
  if (Object.keys(review).length > 0) await mkdir(path.join(specRoot, 'review'), { recursive: true })
  for (const [name, content] of Object.entries(review)) {
    await writeFile(path.join(specRoot, 'review', name), content)
  }
  for (const [name, content] of Object.entries(ideation)) {
    const file = path.join(specRoot, 'ideation', name)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, content)
  }
  await writeFile(path.join(specRoot, 'STATE.md'), state)
  await writeFile(path.join(specRoot, 'FORMAT.md'), '# FORMAT\n')
  await writeFile(path.join(specRoot, 'ssot', 'ARCH.md'), arch)
  for (const [name, content] of Object.entries(tasks)) {
    await writeFile(path.join(specRoot, 'tasks', name), content)
  }
  for (const [name, content] of Object.entries(done)) {
    await writeFile(path.join(specRoot, 'tasks', 'done', name), content)
  }
}

async function withFixture(overrides, run) {
  const root = await mkdtemp(path.join(tmpdir(), 'spec-lint-'))
  try {
    await writeFixture(root, overrides)
    return await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('규칙을 지킨 spec은 오류 없이 통과하고, 아카이브된 done이 dep을 충족한다', async () => {
  await withFixture({}, async (root) => {
    const result = await lintSpec({ targetRoot: root })
    assert.deepEqual(result.errors, [])
    assert.equal(result.ok, true)
    assert.equal(result.counts.ssot, 1)
    assert.equal(result.counts.tasks, 1)
    assert.equal(result.counts.done, 1)
    // 아카이브된 done 태스크는 어떤 경고도 만들지 않는다
    assert.equal(result.warnings.some((w) => w.includes('T001')), false)
  })
})

test('tasked > rev 는 오류다', async () => {
  const broken = STATE.replace('| ARCH | 2 | 2 | - | 1 |', '| ARCH | 2 | 3 | - | 1 |')
  await withFixture({ state: broken }, async (root) => {
    const result = await lintSpec({ targetRoot: root })
    assert.equal(result.ok, false)
    assert.ok(result.errors.some((e) => e.includes('tasked(3) > rev(2)')))
  })
})

test('표에 있는 태스크의 파일이 없으면 오류다', async () => {
  await withFixture({ tasks: {} }, async (root) => {
    const result = await lintSpec({ targetRoot: root })
    assert.equal(result.ok, false)
    assert.ok(result.errors.some((e) => e.includes('T002') && e.includes('파일이 없습니다')))
  })
})

test('표에도 아카이브에도 없는 dep 참조는 오류다', async () => {
  const broken = STATE.replace('| T002 | api | ARCH | T001 | todo |', '| T002 | api | ARCH | T009 | todo |')
  await withFixture({ state: broken }, async (root) => {
    const result = await lintSpec({ targetRoot: root })
    assert.ok(result.errors.some((e) => e.includes('dep T009')))
  })
})

test('태스크 파일에만 있는 누락 dep도 검사하고 STATE와 불일치를 경고한다', async () => {
  await withFixture({ tasks: { 'T002.api.md': T002.replace('dep:T001', 'dep:T099') } }, async (root) => {
    const result = await lintSpec({ targetRoot: root })
    assert.ok(result.errors.some((error) => error.includes('dep T099')))
    assert.ok(result.warnings.some((warning) => warning.includes('파일 dep과 STATE dep')))
  })
})

test('dep의 자기참조와 두 태스크 순환은 오류다', async () => {
  await withFixture({ tasks: { 'T002.api.md': T002.replace('dep:T001', 'dep:T002') } }, async (root) => {
    const result = await lintSpec({ targetRoot: root })
    assert.ok(result.errors.some((error) => error.includes('T002 → T002')))
  })
  const state = STATE.replace('| T002 | api | ARCH | T001 | todo |', '| T002 | api | ARCH | T003 | todo |\n| T003 | next | ARCH | T002 | todo |')
  const tasks = {
    'T002.api.md': T002.replace('dep:T001', 'dep:T003'),
    'T003.next.md': T002.replace('# T002 api', '# T003 next').replace('dep:T001', 'dep:T002'),
  }
  await withFixture({ state, tasks }, async (root) => {
    const result = await lintSpec({ targetRoot: root })
    assert.ok(result.errors.some((error) => error.includes('T002 → T003 → T002')))
  })
})

test('서로 기다리는 lane은 태스크 순환이 없어도 오류다', async () => {
  const lane = (id, title, dep, name) => T002.replace('# T002 api', `# ${id} ${title}`).replace('dep:T001', `dep:${dep} | lane:${name}`)
  const rows = (deps) => STATE.replace('| T002 | api | ARCH | T001 | todo |', deps.map(([id, dep]) => `| ${id} | x | ARCH | ${dep} | todo |`).join('\n'))
  // T003(b) waits for T005(c) and T005 waits for T002(b): no task cycle, but lane b and c deadlock.
  const deadlock = { state: rows([['T002', 'T001'], ['T003', 'T005'], ['T005', 'T002']]),
    tasks: { 'T002.api.md': lane('T002', 'api', 'T001', 'b'), 'T003.next.md': lane('T003', 'next', 'T005', 'b'), 'T005.other.md': lane('T005', 'other', 'T002', 'c') } }
  await withFixture(deadlock, async (root) => {
    const result = await lintSpec({ targetRoot: root })
    assert.ok(!result.errors.some((error) => error.startsWith('dep 순환')), result.errors.join('\n'))
    assert.ok(result.errors.some((error) => error.includes('lane 순환') && error.includes('T003→T005') && error.includes('T005→T002')), result.errors.join('\n'))
  })
  // A lane that waits for another lane to finish before it starts is an ordering, not a deadlock.
  const ordered = { state: rows([['T002', 'T001'], ['T003', 'T002'], ['T005', 'T003']]),
    tasks: { 'T002.api.md': lane('T002', 'api', 'T001', 'b'), 'T003.next.md': lane('T003', 'next', 'T002', 'b'), 'T005.other.md': lane('T005', 'other', 'T003', 'Bad_Lane') } }
  await withFixture(ordered, async (root) => {
    const result = await lintSpec({ targetRoot: root })
    assert.ok(!result.errors.some((error) => error.includes('lane 순환')))
    assert.ok(result.errors.some((error) => error.includes('lane 형식 오류: Bad_Lane')))
  })
})

test('STATE에만 있는 순환도 감지한다', async () => {
  const state = STATE.replace('| T002 | api | ARCH | T001 | todo |', '| T002 | api | ARCH | T002 | todo |')
  await withFixture({ state }, async (root) => {
    const result = await lintSpec({ targetRoot: root })
    assert.ok(result.errors.some((error) => error.includes('T002 → T002')))
  })
})

test('done 행이 표에 남아 있으면 경고, 아카이브와 동시 존재는 오류다', async () => {
  const withDoneRow = STATE.replace(
    '| T002 | api | ARCH | T001 | todo |',
    '| T001 | scaffold | ARCH | - | done@260905 |\n| T002 | api | ARCH | T001 | todo |',
  )
  await withFixture({ state: withDoneRow }, async (root) => {
    const result = await lintSpec({ targetRoot: root })
    assert.ok(result.warnings.some((w) => w.includes('T001') && w.includes('아카이브하세요')))
    assert.ok(result.errors.some((e) => e.includes('T001') && e.includes('동시에 있습니다')))
  })
})

test('결정 라인 형식 위반과 존재하지 않는 결정 참조를 잡는다', async () => {
  const brokenArch = ARCH.replace('- ARCH-2 [?] deploy target', '- ARCH-2 deploy target')
  await withFixture({ arch: brokenArch }, async (root) => {
    const result = await lintSpec({ targetRoot: root })
    assert.ok(result.errors.some((e) => e.includes('결정 라인 형식 오류')))
    // ARCH-2가 결정으로 파싱되지 않으므로 T002의 ssot:ARCH-2 참조도 깨진다
    assert.ok(result.errors.some((e) => e.includes('존재하지 않는 결정 참조: ARCH-2')))
  })
})

test('✎ chg 항목에 old→new가 없으면 경고한다', async () => {
  const noOld = ARCH.replace('- r2 260905 ARCH-2+', '- r2 260905 ARCH-1✎ stack changed')
  await withFixture({ arch: noOld }, async (root) => {
    const result = await lintSpec({ targetRoot: root })
    assert.ok(result.warnings.some((w) => w.includes('old→new')))
  })
  const withOld = ARCH.replace('- r2 260905 ARCH-2+', '- r2 260905 ARCH-1✎ stack remix→next 15')
  await withFixture({ arch: withOld }, async (root) => {
    const result = await lintSpec({ targetRoot: root })
    assert.equal(result.warnings.some((w) => w.includes('old→new')), false)
  })
})

test('SSOT의 골격 밖 섹션은 오류, 산문 줄과 섹션 순서 위반은 경고다', async () => {
  const withDiscussion = ARCH.replace(
    '## chg',
    '## discussion\n- user asked for next because the team knows it\n\n## chg',
  )
  await withFixture({ arch: withDiscussion }, async (root) => {
    const result = await lintSpec({ targetRoot: root })
    assert.equal(result.ok, false)
    assert.ok(result.errors.some((e) => e.includes('골격 밖 섹션') && e.includes('## discussion')))
  })
  const withProse = ARCH.replace(
    '## chg',
    '## constraints\nWe discussed this at length and decided to keep it simple.\n\n## chg',
  )
  await withFixture({ arch: withProse }, async (root) => {
    const result = await lintSpec({ targetRoot: root })
    assert.deepEqual(result.errors, [])
    assert.ok(result.warnings.some((w) => w.includes('constraints') && w.includes('산문 줄')))
  })
  const reordered = ARCH.replace('## decisions', '## chg\n- r2 260905 ARCH-2+\n- r1 260905 initial\n\n## decisions').replace(
    /## chg\n- r2 260905 ARCH-2\+\n- r1 260905 initial\n$/,
    '',
  )
  await withFixture({ arch: reordered }, async (root) => {
    const result = await lintSpec({ targetRoot: root })
    assert.ok(result.warnings.some((w) => w.includes('섹션 순서')))
  })
  const noChg = ARCH.replace(/## chg[\s\S]*$/, '')
  await withFixture({ arch: noChg }, async (root) => {
    const result = await lintSpec({ targetRoot: root })
    assert.ok(result.errors.some((e) => e.includes('## chg 섹션이 없습니다')))
  })
})

test('파일 rev와 STATE rev 불일치는 오류, todo의 낡은 base는 경고다', async () => {
  const staleState = STATE.replace('| ARCH | 2 | 2 | - | 1 |', '| ARCH | 3 | 2 | ARCH-3+ | 1 |')
  await withFixture({ state: staleState }, async (root) => {
    const result = await lintSpec({ targetRoot: root })
    assert.ok(result.errors.some((e) => e.includes('rev(r2)') && e.includes('STATE rev(3)')))
    assert.ok(result.warnings.some((w) => w.includes('T002') && w.includes('base ARCH@2')))
  })
})

test('ideation: open·ready는 미반영 도메인과 질문을 유지할 수 있다', async () => {
  const partial = IDEATION.replace('## open', '- [o] DOC: documentation\n- [?] TOOL: optional tooling\n\n## open').replace('- -\n', '- Which tool is needed?\n')
  for (const st of ['open', 'ready']) {
    await withFixture({ state: IDEATION_STATE.replace('ready@', `${st}@`), ideation: { 'outline.md': partial.replace('ready@', `${st}@`) } }, async (root) => {
      assert.deepEqual((await lintSpec({ targetRoot: root })).errors, [])
    })
  }
})

test('ideation: 전환 후 STATE 행 없이 보존하고 기존 inbox 참조도 유효하다', async () => {
  const state = STATE.replace('## ssot', '## inbox\n- 260906 decided ideation/outline: Scope? → foundation (alt: tooling)\n- 260906 suggest ideation/done/outline: Review the earlier discussion.\n\n## ssot')
  await withFixture({ state, ideation: { 'done/outline.md': CONVERTED_IDEATION } }, async (root) => {
    const result = await lintSpec({ targetRoot: root })
    assert.deepEqual(result.errors, [])
    assert.ok(!result.warnings.some((w) => w.includes('ideation')))
  })
})

test('ideation: 반영 누락·미정·열린 질문을 converted로 보관할 수 없다', async () => {
  const cases = [
    [CONVERTED_IDEATION.replace(' →ARCH', ''), 'SSOT 매핑 없는'],
    [CONVERTED_IDEATION.replace('## open', '- [o] DOC: another domain\n\n## open'), 'SSOT 매핑 없는'],
    [CONVERTED_IDEATION.replace('## shape', '- [?] Decide the tool\n\n## shape'), '[?] 미정'],
    [CONVERTED_IDEATION.replace('## open', '- [?] DOC: undecided scope\n\n## open'), '[?] 미정'],
    [CONVERTED_IDEATION.replace('- -\n', '- What remains?\n'), '## open 질문'],
    [CONVERTED_IDEATION.replace('[o] ARCH: foundation rules →ARCH', '[x] ARCH: foundation rules ← deferred'), '채택한 domains가 없습니다'],
    [CONVERTED_IDEATION.replace('converted@260906', 'ready@260906'), 'st가 converted@가 아닙니다'],
    [CONVERTED_IDEATION.replace('converted@260906', 'converted@yesterday'), 'st 형식 오류'],
    [CONVERTED_IDEATION.replace('## shape', '## other'), '## shape 섹션이 없습니다'],
    [CONVERTED_IDEATION.replace('[o] ARCH:', '[v] ARCH:'), 'domains 줄 형식 오류'],
    [CONVERTED_IDEATION.replace('## open', '- [x] DOC: discarded\n\n## open'), '제외 이유'],
  ]
  for (const [content, expected] of cases) {
    await withFixture({ ideation: { 'done/outline.md': content } }, async (root) => {
      const result = await lintSpec({ targetRoot: root })
      assert.equal(result.ok, false)
      assert.ok(result.errors.some((e) => e.includes(expected)), `${expected}: ${result.errors.join('\n')}`)
    })
  }
})

test('ideation: 활성 매핑은 실제 SSOT를 가리키고 아카이브 매핑은 당시 기록이다', async () => {
  await withFixture({ state: IDEATION_STATE, ideation: { 'outline.md': IDEATION.replace('→ARCH', '→MISC') } }, async (root) => {
    assert.ok((await lintSpec({ targetRoot: root })).errors.some((e) => e.includes('→MISC') && e.includes('SSOT가 없습니다')))
  })
  await withFixture({ ideation: { 'done/outline.md': CONVERTED_IDEATION.replace('→ARCH', '→MISC') } }, async (root) => {
    assert.deepEqual((await lintSpec({ targetRoot: root })).errors, [])
  })
})

test('ideation: 아카이브와 STATE·활성 파일이 중복되면 오류다', async () => {
  await withFixture({ state: IDEATION_STATE, ideation: { 'outline.md': IDEATION, 'done/outline.md': CONVERTED_IDEATION } }, async (root) => {
    const result = await lintSpec({ targetRoot: root })
    assert.ok(result.errors.some((e) => e.includes('STATE ideation 표에 동시에')))
    assert.ok(result.errors.some((e) => e.includes('파일이 모두 있습니다')))
  })
  await withFixture({ state: IDEATION_STATE, ideation: { 'done/outline.md': CONVERTED_IDEATION } }, async (root) => {
    const result = await lintSpec({ targetRoot: root })
    assert.ok(result.errors.some((e) => e.includes('STATE ideation 표에 동시에')))
  })
})

test('ideation: 기존 상태 없는 domains와 converted 문서는 이관할 수 있다', async () => {
  const legacy = CONVERTED_IDEATION.replace('- [o] ARCH:', '- ARCH:')
  await withFixture({ state: IDEATION_STATE.replace('ready@', 'converted@'), ideation: { 'outline.md': legacy } }, async (root) => {
    const result = await lintSpec({ targetRoot: root })
    assert.deepEqual(result.errors, [])
    assert.ok(result.warnings.some((w) => w.includes('ideation/done/') && w.includes('STATE 행')))
  })
  await withFixture({ ideation: { 'done/outline.md': legacy } }, async (root) => {
    assert.deepEqual((await lintSpec({ targetRoot: root })).errors, [])
  })
})

test('ideation: 활성 파일·STATE 누락과 상태 불일치를 진단한다', async () => {
  await withFixture({ state: IDEATION_STATE, ideation: {} }, async (root) => {
    assert.ok((await lintSpec({ targetRoot: root })).errors.some((e) => e.includes('ideation/outline.md 파일이 없습니다')))
  })
  await withFixture({ state: IDEATION_STATE, ideation: { 'stray.md': IDEATION } }, async (root) => {
    assert.ok((await lintSpec({ targetRoot: root })).errors.some((e) => e.includes('stray.md이 STATE ideation 표에 없습니다')))
  })
  await withFixture({ state: IDEATION_STATE, ideation: { 'outline.md': IDEATION.replace('ready@', 'open@') } }, async (root) => {
    assert.ok((await lintSpec({ targetRoot: root })).warnings.some((w) => w.includes('파일 st(open@') && w.includes('STATE st(ready@')))
  })
})

test('리뷰 문서: 규칙을 지키면 통과하고, →T### 참조와 finding 형식을 검사한다', async () => {
  await withFixture({ state: REVIEW_STATE, review: { 'api-260906.md': REVIEW } }, async (root) => {
    const result = await lintSpec({ targetRoot: root })
    assert.deepEqual(result.errors, [])
    assert.equal(result.ok, true)
  })
  const badRef = REVIEW.replace('→T002', '→T099')
  const badLine = badRef.replace('- F2 [x] P3', '- F2 [x]')
  await withFixture({ state: REVIEW_STATE, review: { 'api-260906.md': badLine } }, async (root) => {
    const result = await lintSpec({ targetRoot: root })
    assert.ok(result.errors.some((e) => e.includes('F3') && e.includes('→T099')))
    assert.ok(result.errors.some((e) => e.includes('finding 형식 오류') && e.includes('F2')))
  })
})

test('리뷰 문서: converted인데 태스크 없는 [o] finding이 남으면 오류, 표에 없는 파일은 오류다', async () => {
  const convertedState = REVIEW_STATE.replace('| api-260906 | ready@260906 |', '| api-260906 | converted@260906 |')
  const converted = REVIEW.replace('st:ready@260906', 'st:converted@260906')
  await withFixture({ state: convertedState, review: { 'api-260906.md': converted } }, async (root) => {
    const result = await lintSpec({ targetRoot: root })
    assert.ok(result.errors.some((e) => e.includes('converted인데') && e.includes('1개')))
  })
  await withFixture(
    { state: REVIEW_STATE, review: { 'api-260906.md': REVIEW, 'stray-260906.md': REVIEW } },
    async (root) => {
      const result = await lintSpec({ targetRoot: root })
      assert.ok(result.errors.some((e) => e.includes('stray-260906.md') && e.includes('STATE review 표에 없습니다')))
    },
  )
})

test('spec이 없는 프로젝트는 부트스트랩 안내 오류를 낸다', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'spec-lint-empty-'))
  try {
    const result = await lintSpec({ targetRoot: root })
    assert.equal(result.ok, false)
    assert.ok(result.errors.some((e) => e.includes('STATE.md가 없습니다')))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// ---- 문서 품질: 구조는 lint(오류·경고)가, 의미는 gusta-doc-review(검토 후보)가 본다 ----

test('구조화된 결정 블록(하위 항목·표)은 오류도 검토 후보도 만들지 않는다', async () => {
  const structured = ARCH.replace(
    '- ARCH-1 [o] stack: next 15 ← ecosystem',
    [
      '- ARCH-1 [o] stack: next 15 ← ecosystem',
      '- ARCH-3 [o] target size follows the pointer, not the device class ← a tablet with a mouse is not a phone',
      '  - fine pointer: 40 px floor',
      '  - coarse pointer: 44 px floor, never below',
      '  | surface | replacement |',
      '  |---|---|',
      '  | form field | Listbox |',
    ].join('\n'),
  )
  await withFixture({ arch: structured }, async (root) => {
    const result = await lintSpec({ targetRoot: root })
    assert.deepEqual(result.errors, [])
    assert.deepEqual(result.reviewHints, [])
    assert.equal(result.ok, true)
  })
})

test('상위 항목 없이 시작하는 하위 줄은 오류다', async () => {
  const orphan = ARCH.replace('## decisions\n', '## decisions\n  - dangling condition with no decision above it\n')
  await withFixture({ arch: orphan }, async (root) => {
    const result = await lintSpec({ targetRoot: root })
    assert.equal(result.ok, false)
    assert.ok(result.errors.some((e) => e.includes('상위 항목 없이')))
  })
})

test('복합 결정 신호(긴 줄 · 묶음 · 이유 2개)는 검토 후보이고 오류는 아니다', async () => {
  const fused = ARCH.replace(
    '- ARCH-1 [o] stack: next 15 ← ecosystem',
    [
      `- ARCH-1 [o] stack: next 15 with ${'a policy clause '.repeat(45)}trailing`,
      '- ARCH-3 [o] buttons: cta · secondary · ghost · danger',
      '- ARCH-4 [o] cache the manifest ← fewer round trips ← smaller bundle',
    ].join('\n'),
  )
  await withFixture({ arch: fused }, async (root) => {
    const result = await lintSpec({ targetRoot: root })
    assert.deepEqual(result.errors, [])
    assert.equal(result.ok, true)
    assert.ok(result.reviewHints.some((h) => h.includes('ARCH-1') && h.includes('결정 라인이')))
    assert.ok(result.reviewHints.some((h) => h.includes('ARCH-3') && h.includes("' · ' 묶음이 4개")))
    assert.ok(result.reviewHints.some((h) => h.includes('ARCH-4') && h.includes('← 이유가 2개')))
  })
})

test('줄을 합쳐 경고를 피할 수 없다 — 하위 항목으로 펴야 신호가 사라진다', async () => {
  const clauses = [
    'login 5 per minute',
    'password reset 3 per hour',
    'over the limit the API answers 429 with retry-after, never a silent drop',
    'the counter is per account and never per IP',
  ]
  const joined = ARCH.replace(
    '- ARCH-1 [o] stack: next 15 ← ecosystem',
    `- ARCH-1 [o] rate limits: ${clauses.join('; ')} ${'and the same holds for every write endpoint '.repeat(12)}`,
  )
  const split = ARCH.replace(
    '- ARCH-1 [o] stack: next 15 ← ecosystem',
    ['- ARCH-1 [o] rate limits per account ← abuse without blocking shared offices', ...clauses.map((c) => `  - ${c}`)].join('\n'),
  )
  await withFixture({ arch: joined }, async (root) => {
    const result = await lintSpec({ targetRoot: root })
    assert.ok(result.reviewHints.some((h) => h.includes('결정 라인이')))
  })
  await withFixture({ arch: split }, async (root) => {
    const result = await lintSpec({ targetRoot: root })
    assert.deepEqual(result.reviewHints, [])
    // 조건·수치·부정 표현은 전부 남아 있어야 한다
    assert.deepEqual(result.errors, [])
  })
})

test('과거 경위·ISO 날짜·미사여구는 검토 후보, 백틱 코드 안의 값은 아니다', async () => {
  const traced = ARCH.replace(
    '- ARCH-1 [o] stack: next 15 ← ecosystem',
    [
      '- ARCH-1 [o] stack: next 15 (owner decision 2026-08-31, as discussed) ← ecosystem',
      '- ARCH-3 [o] obviously the cache stays in memory',
      '- ARCH-4 [o] the export filename is `report-2026-08-31.csv` ← the legacy importer matches on it',
    ].join('\n'),
  )
  await withFixture({ arch: traced }, async (root) => {
    const result = await lintSpec({ targetRoot: root })
    assert.deepEqual(result.errors, [])
    assert.ok(result.reviewHints.some((h) => h.includes('ARCH-1') && h.includes('과거 경위')))
    assert.ok(result.reviewHints.some((h) => h.includes('ARCH-1') && h.includes('2026-08-31')))
    assert.ok(result.reviewHints.some((h) => h.includes('ARCH-3') && h.includes('군더더기')))
    assert.equal(result.reviewHints.some((h) => h.includes('ARCH-4')), false)
  })
})

test('constraints의 과거 흔적도 검토 후보로 잡는다', async () => {
  const withConstraint = ARCH.replace(
    '## chg',
    '## constraints\n- the editor keeps the old parser as we agreed\n\n## chg',
  )
  await withFixture({ arch: withConstraint }, async (root) => {
    const result = await lintSpec({ targetRoot: root })
    assert.ok(result.reviewHints.some((h) => h.includes('constraints') && h.includes('과거 경위')))
  })
})

test('chg는 tasked와 활성 태스크 base 아래까지 이어져 있어야 한다', async () => {
  const noR2 = ARCH.replace('- r2 260905 ARCH-2+\n', '')
  await withFixture({ arch: noR2 }, async (root) => {
    const result = await lintSpec({ targetRoot: root })
    assert.ok(result.warnings.some((w) => w.includes('chg에 r2 항목이 없습니다')))
  })
  // 진행 중 태스크의 base가 낡았으면 그 아래 rev의 chg도 필요하다
  const rev3 = STATE.replace('| ARCH | 2 | 2 | - | 1 |', '| ARCH | 3 | 3 | - | 1 |')
  const archR3 = ARCH.replace('> r2 |', '> r3 |').replace('## chg\n', '## chg\n- r3 260906 ARCH-1✎ next 15→16\n')
  const staleBase = T002.replace('base:ARCH@2', 'base:ARCH@1')
  await withFixture(
    { state: rev3, arch: archR3.replace('- r2 260905 ARCH-2+\n', ''), tasks: { 'T002.api.md': staleBase } },
    async (root) => {
      const result = await lintSpec({ targetRoot: root })
      assert.ok(result.warnings.some((w) => w.includes('chg에 r2 항목이 없습니다')))
    },
  )
  await withFixture({ state: rev3, arch: archR3, tasks: { 'T002.api.md': staleBase } }, async (root) => {
    const result = await lintSpec({ targetRoot: root })
    assert.equal(result.warnings.some((w) => w.includes('chg에 r')), false)
  })
})

test('긴 chg 요약은 검토 후보다', async () => {
  const wordy = ARCH.replace('- r2 260905 ARCH-2+', `- r2 260905 ARCH-2+ ${'narrating why this changed '.repeat(20)}`)
  await withFixture({ arch: wordy }, async (root) => {
    const result = await lintSpec({ targetRoot: root })
    assert.ok(result.reviewHints.some((h) => h.includes('chg r2') && h.includes('요약이')))
  })
})

test('아카이브된 완료 태스크의 빈 result는 경고다', async () => {
  const emptyResult = T001.replace('- done, files created\n', '')
  await withFixture({ done: { 'T001.scaffold.md': emptyResult } }, async (root) => {
    const result = await lintSpec({ targetRoot: root })
    assert.deepEqual(result.errors, [])
    assert.ok(result.warnings.some((w) => w.includes('T001') && w.includes('## result가 비어 있습니다')))
  })
})

test('템플릿 자리표시자만 남은 아카이브 result는 새 경고를 만들지 않는다', async () => {
  const placeholders = T001.replace('- done, files created\n', '- outcome: <what works now>\n- verified: <the checks that actually ran>\n')
  await withFixture({ done: { 'T001.scaffold.md': placeholders } }, async (root) => {
    const result = await lintSpec({ targetRoot: root })
    assert.deepEqual(result.errors, [])
    assert.equal(result.warnings.some((w) => w.includes('T001')), false)
  })
})

test('gusta-doc-review식 분할: 새 번호를 붙여도 참조·rev·pending·완료 dep이 그대로다', async () => {
  // ARCH-1이 두 정책을 품고 있었다 → 머리 정책은 ARCH-1이 유지하고, 떨어진 정책만 새 번호를 받는다.
  const tidied = ARCH.replace(
    '- ARCH-1 [o] stack: next 15 ← ecosystem',
    ['- ARCH-1 [o] stack: next 15 ← ecosystem', '- ARCH-3 [o] package manager: pnpm ← workspace hoisting'].join('\n'),
  )
  await withFixture({ arch: tidied }, async (root) => {
    const result = await lintSpec({ targetRoot: root })
    assert.deepEqual(result.errors, []) // T002의 ssot:ARCH-1 ARCH-2 참조가 그대로 유효
    assert.equal(result.ok, true)
    assert.equal(result.counts.done, 1) // 완료 태스크 아카이브와 dep 판정은 영향받지 않는다
    // rev·pending을 건드리지 않았으므로 tasked=rev·pending='-' 경고가 새로 생기지 않는다
    assert.equal(result.warnings.some((w) => w.includes('pending')), false)
    assert.equal(result.warnings.some((w) => w.includes('chg')), false)
  })
})

const SESSION_STATE = STATE
  .replace('- docs: en\n', '- docs: en\n- push: main\n')
  .replace('| T002 | api | ARCH | T001 | todo |', '| T002 | api | ARCH | T001 | doing@261013.k3f9 |')
  .replace('## ssot\n', '## active\n| tag | host | mode | since | at | doing |\n|---|---|---|---|---|---|\n| k3f9 | mbp | autopilot | 2026-10-13T01:00Z | 2026-10-13T02:10Z | T002 |\n\n## inbox\n- 261013 decided ARCH-2 T002: deploy target unknown → static host (alt: container | serverless)\n- 261013 parked T001: needs a force push to rewrite the release tag\n- 261013 suggest -: run gusta-review-code after five tasks\n\n## ssot\n')
const DOING_T002 = T002.replace('st:todo', 'st:doing@261013.k3f9')

test('active·inbox·cfg.push를 지킨 STATE는 통과한다', async () => {
  await withFixture({ state: SESSION_STATE, tasks: { 'T002.api.md': DOING_T002 } }, async (root) => {
    const result = await lintSpec({ targetRoot: root })
    assert.deepEqual(result.errors, [])
    assert.deepEqual(result.warnings.filter((w) => /active|inbox|push/.test(w)), [])
  })
})

test('inbox의 형식·참조와 active 행 형식이 틀리면 오류다', async () => {
  const state = SESSION_STATE
    .replace('- push: main', '- push: two words')
    .replace('| k3f9 | mbp | autopilot | 2026-10-13T01:00Z | 2026-10-13T02:10Z | T002 |', '| k3f9 | mbp | solo | 26-10-13 | 2026-10-13T02:10Z | T009 |')
    .replace('- 261013 suggest -: run gusta-review-code after five tasks', '- 261013 suggest ARCH-9 T404 review/none: missing refs\n- someday decided ARCH-1: no date')
  await withFixture({ state, tasks: { 'T002.api.md': DOING_T002 } }, async (root) => {
    const { errors } = await lintSpec({ targetRoot: root })
    for (const pattern of [/cfg push/, /mode는 pair\|autopilot/, /since는 ISO UTC/, /doing T009/, /ARCH-9/, /T404/, /review\/none/, /inbox 줄 형식 오류/]) {
      assert.ok(errors.some((error) => pattern.test(error)), `${pattern} not in ${errors.join('\n')}`)
    }
  })
})

test('active의 doing 태스크 tag가 다르면 경고다', async () => {
  await withFixture({ state: SESSION_STATE.replace('doing@261013.k3f9 |', 'doing@261013.zz9 |'), tasks: { 'T002.api.md': DOING_T002.replace('k3f9', 'zz9') } }, async (root) => {
    const result = await lintSpec({ targetRoot: root })
    assert.deepEqual(result.errors, [])
    assert.ok(result.warnings.some((w) => /active k3f9: T002의 st/.test(w)), result.warnings.join('\n'))
  })
})

test('세션 섹션이 없는 STATE는 통과한다 — log는 필수가 아니고, 조정 문서(SESSIONS.md)는 트리 밖이라 검사하지 않는다', async () => {
  const state = STATE.slice(0, STATE.indexOf('\n## log'))
  assert.doesNotMatch(state, /^## (active|inbox|log)$/m)
  await withFixture({ state }, async (root) => {
    const result = await lintSpec({ targetRoot: root })
    assert.deepEqual([result.ok, result.errors], [true, []])
    assert.deepEqual(result.warnings.filter((w) => /log|active|inbox/.test(w)), [])
  })
  // 나머지 골격은 그대로 필수다.
  for (const name of ['cfg', 'ssot', 'tasks', 'next']) {
    const end = state.indexOf('\n## ', state.indexOf(`## ${name}\n`) + 1)
    const without = state.slice(0, state.indexOf(`## ${name}\n`)) + (end === -1 ? '' : state.slice(end + 1))
    await withFixture({ state: without }, async (root) => {
      const { errors } = await lintSpec({ targetRoot: root })
      assert.ok(errors.includes(`STATE.md에 ## ${name} 섹션이 없습니다.`), `${name}: ${errors.join('\n')}`)
    })
  }
})

test('이관 전 STATE에 남은 active·inbox·log는 예전 규칙 그대로 검사하고, 이관 안내로 경고·검토 후보를 늘리지 않는다', async () => {
  await withFixture({ state: SESSION_STATE, tasks: { 'T002.api.md': DOING_T002 } }, async (root) => {
    const result = await lintSpec({ targetRoot: root })
    assert.deepEqual([result.ok, result.errors], [true, []])
    for (const line of [...result.warnings, ...result.reviewHints]) assert.doesNotMatch(line, /migrate|SESSIONS|조정 브랜치|active|inbox|log/)
  })
  // 다른 worktree에서 온 것 같은 참조도 STATE 안에서는 여전히 이 트리 기준이다: 조정 문서에만 허용된다.
  const foreign = SESSION_STATE.replace('- 261013 parked T001:', '- 261013 parked T404 ARCH-9:')
  const long = SESSION_STATE.replace('## log\n', `## log\n${Array.from({ length: 20 }, (_, index) => `- 2610${String(index + 1).padStart(2, '0')} note ${index}`).join('\n')}\n`)
  await withFixture({ state: foreign, tasks: { 'T002.api.md': DOING_T002 } }, async (root) => {
    const { errors } = await lintSpec({ targetRoot: root })
    assert.deepEqual(errors, ['inbox: T404가 tasks 표에도 tasks/done/에도 없습니다.', 'inbox: 존재하지 않는 결정 참조: ARCH-9'])
  })
  await withFixture({ state: long, tasks: { 'T002.api.md': DOING_T002 } }, async (root) => {
    const result = await lintSpec({ targetRoot: root })
    assert.deepEqual(result.errors, [])
    assert.deepEqual(result.warnings.filter((w) => /log/.test(w)), ['STATE log가 22줄입니다 — 20줄 초과분은 삭제 (FORMAT).'])
  })
})

test('STATE 골격은 FORMAT·템플릿·lint가 같이 말한다: 세션 섹션은 STATE가 아니라 SESSIONS 골격에 있다 (CLAUDE.md 원칙 4)', async () => {
  const asset = (name) => readFile(new URL(`../skills/gusta-create-architecture/assets/${name}`, import.meta.url), 'utf8')
  const [format, template] = [await asset('FORMAT.md'), await asset('STATE.md')]
  const skeleton = (name) => [...format.split('\n').find((line) => line.startsWith(`- ${name}: `)).matchAll(/`## ([\w-]+)`(\(opt)?/g)].map((found) => ({ name: found[1], optional: Boolean(found[2]) }))
  const state = skeleton('STATE')
  assert.deepEqual(state.map((entry) => entry.name), ['cfg', 'ideation', 'ssot', 'review', 'tasks', 'work', 'next'])
  const required = state.filter((entry) => !entry.optional).map((entry) => entry.name)
  assert.deepEqual(required, ['cfg', 'ssot', 'tasks', 'next'])
  // 템플릿은 필수 섹션만, 골격 순서대로 갖는다.
  assert.deepEqual([...template.matchAll(/^## (.+)$/gm)].map((found) => found[1]), required)
  assert.match(template, /SESSIONS\.md on the coordination branch/)
  // lint가 요구하는 섹션도 같다.
  const dir = await mkdtemp(path.join(tmpdir(), 'spec-lint-'))
  try {
    await mkdir(path.join(dir, 'spec'), { recursive: true })
    await writeFile(path.join(dir, 'spec/STATE.md'), '# STATE\n')
    const { errors } = await lintSpec({ targetRoot: dir })
    assert.deepEqual(errors.filter((error) => /^STATE\.md에 ## /.test(error)), required.map((name) => `STATE.md에 ## ${name} 섹션이 없습니다.`))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
  // 세션 조정 섹션은 모두 선택이고 SESSIONS 골격에만 있다. 칸 정의는 그 아래 하위 줄이다.
  assert.deepEqual(skeleton('sessions'), ['active', 'inbox', 'unlanded', 'log'].map((name) => ({ name, optional: true })))
  assert.match(format, /\n  - active row `tag\|host\|mode\|since\|at\|doing\|branch\|commit\|session`: /)
  assert.match(format, /\n  - unlanded row `id\|tag\|branch\|commit\|at`: /)
})

test('explore 태스크는 시간 제한 형식과 exit 줄이 필수다', async () => {
  const explore = T002.replace('dep:T001', 'dep:T001 | explore:2h')
  await withFixture({ tasks: { 'T002.api.md': explore } }, async (root) => {
    const { errors } = await lintSpec({ targetRoot: root })
    assert.ok(errors.some((error) => /exit: …/.test(error)), errors.join('\n'))
  })
  const withExit = explore.replace('- [ ] test covers the route', '- [ ] test covers the route\n- [ ] exit: after 2h record the measured latency in result and finish')
  await withFixture({ tasks: { 'T002.api.md': withExit } }, async (root) => {
    assert.deepEqual((await lintSpec({ targetRoot: root })).errors, [])
  })
  await withFixture({ tasks: { 'T002.api.md': withExit.replace('explore:2h', 'explore:two hours') } }, async (root) => {
    const { errors } = await lintSpec({ targetRoot: root })
    assert.ok(errors.some((error) => /explore 형식 오류/.test(error)), errors.join('\n'))
  })
})

test('run 추천은 형식만 오류로 보고(필드 없음·-·done 아카이브는 통과), todo의 테스트 아닌 touches 5개 초과는 검토 후보다', async () => {
  const withRun = (value) => T002.replace('dep:T001', `dep:T001 | run:${value}`)
  for (const value of ['claude/sonnet@high', 'codex/gpt-6.1-sol@ultra', 'claude/claude-opus-5-5@xhigh', '-']) {
    await withFixture({ tasks: { 'T002.api.md': withRun(value) } }, async (root) => assert.deepEqual((await lintSpec({ targetRoot: root })).errors, [], value))
  }
  // 그 기기에 그 모델이 있는지는 판정하지 않는다: 모르는 모델 이름도 형식이 맞으면 통과.
  await withFixture({ tasks: { 'T002.api.md': withRun('codex/some-future-model@low') } }, async (root) => assert.deepEqual((await lintSpec({ targetRoot: root })).errors, []))
  for (const value of ['gemini/pro@high', 'claude/sonnet', 'claude/sonnet@huge', '<tool>/<model>@<effort>']) {
    await withFixture({ tasks: { 'T002.api.md': withRun(value) } }, async (root) => {
      const { errors } = await lintSpec({ targetRoot: root })
      assert.deepEqual(errors, [`tasks/T002.api.md: run 형식 오류: ${value} (<claude|codex>/<model>@<low|medium|high|xhigh|max|ultra>|-)`], value)
    })
  }
  // 완료 아카이브는 역사 기록이라 다시 판정하지 않는다(원칙 8).
  await withFixture({ done: { 'T001.scaffold.md': T001.replace('dep:-', 'dep:- | run:old/format') } }, async (root) => assert.deepEqual((await lintSpec({ targetRoot: root })).errors, []))
  const touches = (list) => T002.replace('dep:T001', `dep:T001 | touches:${list}`)
  const six = 'src/a.ts src/b.ts src/c.ts src/d.ts src/e.ts src/f.ts'
  await withFixture({ tasks: { 'T002.api.md': touches(six) } }, async (root) => {
    const result = await lintSpec({ targetRoot: root })
    assert.deepEqual([result.ok, result.errors], [true, []])
    assert.ok(result.reviewHints.some((hint) => hint.startsWith('tasks/T002.api.md: 테스트 아닌 touches 6개(기준 5)')), result.reviewHints.join('\n'))
  })
  // 테스트 경로는 세지 않고, todo가 아닌 태스크는 이미 나뉜 작업이라 보지 않는다.
  for (const [content, state] of [[touches('src/a.ts src/b.ts src/c.ts src/d.ts src/e.ts test/a.test.ts src/f.test.ts'), STATE], [touches(six).replace('st:todo', 'st:doing@261013.k3f9'), STATE.replace('| T001 | todo |', '| T001 | doing@261013.k3f9 |')]]) {
    await withFixture({ tasks: { 'T002.api.md': content }, state }, async (root) => assert.equal((await lintSpec({ targetRoot: root })).reviewHints.some((hint) => /touches/.test(hint)), false))
  }
})

test('보고서는 파일명·제목·인용줄·골격을 검사한다', async () => {
  const report = '# REPORT 261013-k3f9\n> mode:autopilot | host:mbp | from:2026-10-13T01:00Z | to:- | push:main\n\n## done\n- T002 api, 1a2b3c4\n\n## decided\n- ARCH-2: 정적 호스팅으로 진행\n\n## parked\n- -\n\n## checks\n- npm test: pass\n\n## next\n- inbox 확인\n'
  const root = await mkdtemp(path.join(tmpdir(), 'spec-lint-'))
  try {
    await writeFixture(root)
    await mkdir(path.join(root, 'spec/reports'), { recursive: true })
    await writeFile(path.join(root, 'spec/reports/261013-k3f9.md'), report)
    assert.deepEqual((await lintSpec({ targetRoot: root })).errors, [])
    await writeFile(path.join(root, 'spec/reports/261013-k3f9.md'), report.replace('## checks', '## notes').replace('host:mbp | ', ''))
    await writeFile(path.join(root, 'spec/reports/today.md'), report)
    const { errors } = await lintSpec({ targetRoot: root })
    for (const pattern of [/골격 밖 섹션이 있습니다: ## notes/, /## checks 섹션이 없습니다/, /host: 필드가 없습니다/, /today\.md: <YYMMDD>-<tag>\.md/]) {
      assert.ok(errors.some((error) => pattern.test(error)), `${pattern} not in ${errors.join('\n')}`)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('SSOT 참조: typed 참조가 깨지면 오류, 미분류 참조가 깨지면 경고, 정본 위임은 [o]를 가리키고 순환하지 않는다', async () => {
  const arch = ARCH.replace('- ARCH-2 [?] deploy target', '- ARCH-2 [?] deploy target\n- ARCH-3 [o] node only →!ARCH-9 →ARCH-8 →=ARCH-2\n- ARCH-4 [o] lint follows →=ARCH-5\n- ARCH-5 [o] format follows →=ARCH-4 (→ARCH-1, →~ARCH-1, UTF-8)')
  await withFixture({ arch }, async (root) => {
    const { errors, warnings, reviewHints } = await lintSpec({ targetRoot: root })
    assert.deepEqual(errors, ['ssot/ARCH.md ARCH-3: →!ARCH-9 — 결정 ARCH-9가 없습니다.'])
    for (const pattern of [/ARCH-3: 참조 →ARCH-8의 대상 ARCH-8가 없습니다/, /ARCH-3: 정본 위임 →=ARCH-2의 대상이 \[o\]가 아닙니다/, /정본 위임이 순환합니다: ARCH-4 →= ARCH-5 →= ARCH-4/, /FORMAT.md에 참조 구분/]) {
      assert.ok(warnings.some((warning) => pattern.test(warning)), `${pattern} not in ${warnings.join('\n')}`)
    }
    assert.ok(reviewHints.some((hint) => /미분류 참조\(→ID\) 2개/.test(hint)), reviewHints.join('\n'))
  })
})

test('cfg always는 있는 결정·도메인만 가리키고, 빠지면 기본(ARCH 전체)으로 둔다', async () => {
  await withFixture({ state: STATE.replace('- docs: en', '- docs: en\n- always: ARCH-1 ARCH-7 NOPE') }, async (root) => {
    const { errors } = await lintSpec({ targetRoot: root })
    assert.deepEqual(errors, ['cfg always의 ARCH-7가 없습니다 (결정 ID | 도메인 | -).', 'cfg always의 NOPE가 없습니다 (결정 ID | 도메인 | -).'])
  })
  await withFixture({ state: STATE.replace('- docs: en', '- docs: en\n- always: ARCH') }, async (root) => {
    assert.deepEqual((await lintSpec({ targetRoot: root })).errors, [])
  })
})

test('[o] 검증 결정에 단계 선언이 없으면 검토 후보만 낸다 — 오류·경고는 그대로이고, 세 단계를 선언하면 사라진다', async () => {
  const hinted = (result) => result.reviewHints.filter((hint) => hint.includes('검증 단계 선언'))
  const baseline = await withFixture({}, (root) => lintSpec({ targetRoot: root }))
  assert.deepEqual(hinted(baseline), [], '검증 결정이 없는 ARCH에는 후보가 없다')
  const undeclared = ARCH.replace('- ARCH-2 [?] deploy target', '- ARCH-2 [?] deploy target\n- ARCH-3 [o] verification: `pnpm run typecheck`, `pnpm run build` before each done')
  await withFixture({ arch: undeclared }, async (root) => {
    const result = await lintSpec({ targetRoot: root })
    assert.deepEqual([result.ok, result.errors, result.warnings], [baseline.ok, baseline.errors, baseline.warnings])
    assert.deepEqual(hinted(result), ['ssot/ARCH.md: [o] 검증 결정(ARCH-3)에 task / batch / CI 검증 단계 선언이 없습니다 — 단계를 모두 명시하고 1분 넘는 검사는 batch에 두는 개정 후보입니다(gusta-update 규칙 대조).'])
  })
  const partial = ARCH.replace('- ARCH-2 [?] deploy target', '- ARCH-2 [?] deploy target\n- ARCH-3 [o] verification tiers\n  - task, before each done commit: `pnpm run lint`\n  - batch, before code push or final completion: `pnpm run build`')
  await withFixture({ arch: partial }, async (root) => {
    assert.match(hinted(await lintSpec({ targetRoot: root }))[0], /ARCH-3\)에 .*일부만 있습니다/)
  })
  const declared = partial.replace('`pnpm run build`', '`pnpm run build`\n  - CI, after code push: remote checks')
  await withFixture({ arch: declared }, async (root) => {
    const result = await lintSpec({ targetRoot: root })
    assert.deepEqual(hinted(result), [])
    assert.deepEqual([result.ok, result.errors, result.warnings], [baseline.ok, baseline.errors, baseline.warnings])
  })
})
