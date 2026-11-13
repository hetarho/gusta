import { verificationTiers } from './vibe-brief.mjs'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { sections, tableRows, quoteLine, quoteFields, splitRefs, TASK_ID, TASK_ST, EXPLORE, exploreValue, EXIT_LINE, SESSION_TAG, ISO_UTC, INBOX_LINE, REPORT_FILE, REPORT_SECTIONS, parseSsot, references, refId } from './spec-format.mjs'
import { touchesErrors } from './work-policy.mjs'
import { dependencyErrors, laneErrors, laneValue } from './task-graph.mjs'
import { parseSettings } from './settings.mjs'

const DOMAIN_ID = /^[A-Z]{2,6}$/
const DOC_ST = /^(open|ready|converted)@\d{6}$/ // ideation · review
const IDEATION_SECTIONS = ['vision', 'explored', 'shape', 'domains', 'open']
const IDEATION_DOMAIN = /^-\s+(?:\[(o|x|\?)\]\s+)?([A-Z]{2,6}):\s+\S/
const FINDING_LINE = /^-\s+F(\d+)\s+\[(o|x|\?)\]\s+P[123]\s+\S/
const LEVELS = new Set(['expert', 'mid', 'novice', '?'])
const SSOT_SECTIONS = ['decisions', 'flow', 'constraints', 'chg']
const SSOT_REQUIRED = ['decisions', 'chg']
const TOP_BULLET = /^-\s+\S/
const SUB_LINE = /^\s+-\s+\S/
const TABLE_ROW = /^\s*\|/

// 의미 품질 신호(검토 후보). 구조 위반이 아니라 gusta-doc-review가 판단할 거리다 — 임계값은 신호일 뿐
// 자동 교정 기준이 아니고, 줄을 합치면 오히려 더 걸리도록 '한 줄' 길이만 센다.
const DECISION_LINE_MAX = 700
const DOT_GROUP_MAX = 2 // ' · ' 묶음이 3개 이상이면 여러 정책이 붙은 신호
const REASON_MAX = 1 // ' ← ' 가 2개면 결정도 2개
const CHG_LINE_MAX = 400
const TRACE_PATTERNS = [
  /\bas\s+(?:the\s+user\s+|you\s+|we\s+)?(?:asked|requested|discussed|agreed)\b/i,
  /\bwe\s+(?:decided|agreed|chose)\b/i,
  /\bowner\s+(?:decision|decided|kept|chose|picked|approved)\b/i,
  /\bper\s+(?:the\s+)?(?:owner|user)(?:'s)?\s+(?:request|decision)\b/i,
  /\bfor\s+historical\s+reasons\b/i,
]
const FILLER_PATTERNS = [
  /\bobviously\b/i,
  /\bof\s+course\b/i,
  /\bneedless\s+to\s+say\b/i,
  /\bit\s+is\s+worth\s+noting\b/i,
  /\bnote\s+that\b/i,
  /\bas\s+we\s+all\s+know\b/i,
  /\bsimply\s+put\b/i,
  /\bin\s+other\s+words\b/i,
  /\bbasically\b/i,
]
const ISO_DATE = /\b(?:19|20)\d{2}-\d{2}-\d{2}\b/

function withoutCode(text) {
  return text.replace(/`[^`]*`/g, ' ')
}

function countOccurrences(text, needle) {
  return text.split(needle).length - 1
}

// 결정 라인 하나(또는 flow·constraints 한 줄)에서 찾을 수 있는 의미 신호를 모은다.
function proseHints(line) {
  const hints = []
  const text = withoutCode(line)
  for (const pattern of TRACE_PATTERNS) {
    const found = text.match(pattern)
    if (found) {
      hints.push(`과거 경위 표현: "${found[0].trim()}" — 현재 동작과 무관하면 지웁니다`)
      break
    }
  }
  const date = text.match(ISO_DATE)
  if (date) {
    hints.push(`날짜 ${date[0]} — FORMAT 날짜는 YYMMDD이고, 결정 안의 날짜는 측정 출처(measured YYMMDD)만 남깁니다`)
  }
  for (const pattern of FILLER_PATTERNS) {
    const found = text.match(pattern)
    if (found) {
      hints.push(`군더더기 표현: "${found[0].trim()}"`)
      break
    }
  }
  return hints
}

// 결정 '한 줄'의 구조 신호. 하위 항목으로 펴면 사라지고, 줄을 합치면 더 강해진다.
function decisionShapeHints(headLine) {
  const hints = []
  const text = headLine.trimEnd()
  if (text.length > DECISION_LINE_MAX) {
    hints.push(
      `결정 라인이 ${text.length}자입니다 — 조건·예외를 하위 항목이나 표로 펴거나, 따로 바뀌는 정책이면 나눕니다`,
    )
  }
  const dots = countOccurrences(text, ' · ')
  if (dots > DOT_GROUP_MAX) {
    hints.push(`한 줄에 ' · ' 묶음이 ${dots + 1}개입니다 — 독립적으로 바뀌는 정책이 섞였는지 봅니다`)
  }
  const reasons = countOccurrences(text, ' ← ')
  if (reasons > REASON_MAX) {
    hints.push(`한 줄에 ← 이유가 ${reasons}개입니다 — 이유가 둘이면 결정도 둘입니다`)
  }
  return hints
}

async function readIfExists(filePath) {
  try {
    return await readFile(filePath, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

async function listIfExists(dirPath) {
  try {
    return await readdir(dirPath)
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

function cfgValues(lines = []) {
  const map = new Map()
  for (const line of lines) {
    const match = line.match(/^-\s+([\w-]+):\s*([^#]*)/)
    if (match) map.set(match[1], match[2].trim())
  }
  return map
}

function ideationChecks({ content, file, archived, ssotInfo, errors, warnings }) {
  const st = quoteFields(quoteLine(content) ?? '').get('st')
  const converted = /^converted@\d{6}$/.test(st ?? '')
  if (!DOC_ST.test(st ?? '')) errors.push(`${file}: st 형식 오류: ${st ?? '(없음)'} (open|ready|converted@날짜)`)
  if (archived && !converted) errors.push(`${file}: 아카이브된 ideation의 st가 converted@가 아닙니다.`)
  if (!archived && converted) warnings.push(`${file}: converted 문서는 반영 범위 확인 후 ideation/done/으로 이동하고 STATE 행을 제거하세요.`)
  const parts = sections(content)
  for (const name of IDEATION_SECTIONS) {
    if (!parts.has(name)) errors.push(`${file}: ## ${name} 섹션이 없습니다.`)
  }
  let adopted = 0, unmapped = 0
  for (const line of parts.get('domains') ?? []) {
    if (!line.trim() || ['-', '- -'].includes(line.trim())) continue
    const domain = line.match(IDEATION_DOMAIN)
    if (!domain) {
      errors.push(`${file}: domains 줄 형식 오류: "${line.trim().slice(0, 60)}" (- [o|x|?] ID: summary)`)
      continue
    }
    const status = domain[1] ?? 'o' // Legacy unmarked domains were adopted scope.
    if (status === 'x' && !/←\s*\S/.test(line)) errors.push(`${file}: [x] 도메인 ${domain[2]}에 제외 이유(←)가 없습니다.`)
    const refs = [...line.matchAll(/→([A-Z]{2,6})(?![\w-])/g)].map((match) => match[1])
    // Archived mappings describe completion-time history, not today's domain set.
    if (!archived) for (const ref of refs) {
      if (!ssotInfo.get(ref)?.doc) errors.push(`${file}: 매핑 →${ref}의 SSOT가 없습니다.`)
    }
    if (status === 'o') {
      adopted += 1
      if (refs.length === 0) unmapped += 1
    }
  }
  if (converted) {
    if (adopted === 0) errors.push(`${file}: converted인데 채택한 domains가 없습니다.`)
    if (unmapped > 0) errors.push(`${file}: converted인데 SSOT 매핑 없는 채택 도메인이 ${unmapped}개 있습니다.`)
    if (['explored', 'domains'].some((name) => (parts.get(name) ?? []).some((line) => /^\s*-\s+\[\?\]/.test(line)))) {
      errors.push(`${file}: converted인데 [?] 미정 항목이 남아 있습니다 — 해결하거나 별도 활성 ideation으로 분리하세요.`)
    }
    if ((parts.get('open') ?? []).some((line) => line.trim() && !['-', '- -'].includes(line.trim()))) {
      errors.push(`${file}: converted인데 ## open 질문이 남아 있습니다 — 질문이 없으면 '- -'로 비우세요.`)
    }
  }
  return st
}

// References between decisions (FORMAT reference notation). A typed reference (→! →= →~) is an
// explicit contract, so a broken one is an error; an unclassified one predates the kinds, so a
// broken one is a warning and the count of them is a review hint, never a reason to guess kinds.
function referenceChecks({ ssotInfo, cfg, format, errors, warnings, reviewHints }) {
  let unclassified = 0
  let typed = 0
  const canonical = new Map()
  for (const [id, info] of ssotInfo) {
    const check = (text, from) => {
      for (const ref of references(text)) {
        const target = refId(ref)
        if (target === from) continue
        const owner = ssotInfo.get(ref.domain)?.doc
        const where = `ssot/${id}.md ${from}`
        if (ref.kind === 'unclassified') {
          if (!owner) continue // not a domain ID at all (UTF-8, SHA-256)
          if (!ref.mention) unclassified += 1
          if (ref.number !== null && !owner.decisions.has(target)) warnings.push(`${where}: 참조 ${ref.raw}의 대상 ${target}가 없습니다.`)
          continue
        }
        typed += 1
        if (!owner) { errors.push(`${where}: ${ref.raw} — 도메인 ${ref.domain}이 STATE ssot 표에 없습니다.`); continue }
        if (ref.number === null) continue
        const decision = owner.decisions.get(target)
        if (!decision) { errors.push(`${where}: ${ref.raw} — 결정 ${target}가 없습니다.`); continue }
        if (ref.kind === 'canonical' && decision.status !== 'decided') warnings.push(`${where}: 정본 위임 ${ref.raw}의 대상이 [o]가 아닙니다 — 지금 유효한 규칙을 가진 결정을 가리키세요.`)
        if (ref.kind === 'requires' && decision.status === 'rejected') warnings.push(`${where}: 필수 의존 ${ref.raw}의 대상이 [x]입니다.`)
        if (ref.kind === 'canonical' && /-\d+$/.test(from)) canonical.set(from, [...(canonical.get(from) ?? []), target])
      }
    }
    if (!info.doc) continue
    for (const block of info.doc.decisions.values()) check(block.text, block.id)
    for (const name of ['flow', 'constraints']) if (info.doc.sections.get(name)?.text) check(info.doc.sections.get(name).text, name)
  }
  // A canonical owner that delegates back to its delegator owns nothing.
  const reported = new Set()
  for (const start of canonical.keys()) {
    const trail = [start]
    for (let next = canonical.get(start)?.[0]; next && canonical.has(next); next = canonical.get(next)[0]) {
      if (trail.includes(next)) {
        const cycle = trail.slice(trail.indexOf(next))
        const key = [...cycle].sort().join(' ')
        if (!reported.has(key)) { reported.add(key); warnings.push(`정본 위임이 순환합니다: ${[...cycle, next].join(' →= ')} — 규칙을 가진 쪽 하나만 정본으로 두세요.`) }
        break
      }
      trail.push(next)
    }
  }
  if (typed > 0 && format !== null && !format.includes('→!')) {
    warnings.push('spec/FORMAT.md에 참조 구분(→! →= →~) 정의가 없습니다 — 패키지 FORMAT의 reference 줄을 옮기세요(README 기존 프로젝트 이관).')
  }
  if (unclassified > 0) {
    reviewHints.push(`미분류 참조(→ID) ${unclassified}개 — brief는 이것을 1단계만 따라갑니다. 결정을 쓰거나 고칠 때 문장으로 판단해 필수(→!)·정본(→=)·관련(→~)으로 적고, 추측으로 일괄 바꾸지 않습니다.`)
  }
  // cfg brief: the scope of a task brief (absent ⇒ domain).
  if (cfg.has('brief') && !['domain', 'cited'].includes(cfg.get('brief'))) errors.push(`cfg brief 값이 잘못됐습니다: ${cfg.get('brief') || '(빈 값)'} (domain|cited)`)
  // cfg always: the global rules every task brief carries (absent ⇒ every ARCH decision).
  if (cfg.has('always')) {
    for (const token of splitRefs(cfg.get('always'))) {
      const decision = token.match(/^([A-Z]{2,6})-(\d+)$/)
      const found = decision ? ssotInfo.get(decision[1])?.doc?.decisions.get(token) : ssotInfo.has(token)
      if (!found) errors.push(`cfg always의 ${token}가 없습니다 (결정 ID | 도메인 | -).`)
      else if (decision && found.status === 'rejected') warnings.push(`cfg always의 ${token}가 [x]입니다 — 전역 규칙에서 빼세요.`)
    }
  }
}

export async function lintSpec({ targetRoot } = {}) {
  const specRoot = path.join(path.resolve(targetRoot ?? process.cwd()), 'spec')
  const errors = []
  const warnings = []
  const reviewHints = []
  const counts = { ssot: 0, tasks: 0, done: 0 }

  const state = await readIfExists(path.join(specRoot, 'STATE.md'))
  if (state === null) {
    errors.push('spec/STATE.md가 없습니다 — gusta-create-architecture로 부트스트랩하세요.')
    return { ok: false, errors, warnings, reviewHints, counts }
  }
  const format = await readIfExists(path.join(specRoot, 'FORMAT.md'))
  if (format === null) {
    errors.push('spec/FORMAT.md가 없습니다.')
  }

  // Session coordination (active·inbox·unlanded·log) lives in SESSIONS.md on the coordination
  // branch, outside this tree: the CLI validates it when it writes, and lint never reads it — its
  // refs may name tasks and decisions another worktree has not landed here. A STATE that still
  // carries active·inbox·log (before `gusta migrate`) is checked below by the rules it always had,
  // with no new warning: integration requires a warning-free spec, and migrate reports the move.
  const stateSections = sections(state)
  for (const name of ['cfg', 'ssot', 'tasks', 'next']) {
    if (!stateSections.has(name)) errors.push(`STATE.md에 ## ${name} 섹션이 없습니다.`)
  }

  const cfg = cfgValues(stateSections.get('cfg'))
  const level = cfg.get('level')
  if (!level) errors.push('STATE cfg에 level이 없습니다.')
  else if (!LEVELS.has(level)) errors.push(`cfg level 값이 잘못됐습니다: ${level} (expert|mid|novice|?)`)
  else if (level === '?') warnings.push('cfg level이 ?입니다 — gusta-create-architecture 캘리브레이션 미완.')
  const push = cfg.get('push')
  if (push !== undefined && !['-', '?'].includes(push) && !/^[A-Za-z0-9._/-]+$/.test(push)) {
    errors.push(`cfg push 값이 잘못됐습니다: ${push || '(빈 값)'} (브랜치 이름|-|?)`)
  }
  // Legacy cfg push/plan stay readable (no warning: integration requires a warning-free spec);
  // vibe status/settings report them as `legacy` and migrate moves them.

  // ssot
  const ssotRows = tableRows(stateSections.get('ssot'))
  const ssotIds = new Set(ssotRows.map((row) => row[0]))
  const ssotInfo = new Map()
  for (const row of ssotRows) {
    const [id, revText, taskedText, pending, openText] = row
    if (!DOMAIN_ID.test(id ?? '')) {
      errors.push(`ssot id 형식 오류: ${id} (대문자 2-6자)`)
      continue
    }
    const rev = Number(revText)
    const tasked = Number(taskedText)
    if (!Number.isInteger(rev) || rev < 1) errors.push(`${id}: rev가 올바르지 않습니다: ${revText}`)
    if (!Number.isInteger(tasked) || tasked < 0) errors.push(`${id}: tasked가 올바르지 않습니다: ${taskedText}`)
    if (Number.isInteger(rev) && Number.isInteger(tasked)) {
      if (tasked > rev) errors.push(`${id}: tasked(${tasked}) > rev(${rev}) — 있을 수 없는 상태입니다.`)
      else if (tasked === 0 && pending !== 'all') warnings.push(`${id}: tasked=0이면 pending은 all이어야 합니다 (현재: ${pending || '(빈 칸)'})`)
      else if (tasked === rev && tasked > 0 && pending !== '-') warnings.push(`${id}: tasked=rev인데 pending이 '-'가 아닙니다: ${pending}`)
      else if (tasked > 0 && tasked < rev && (!pending || pending === '-')) warnings.push(`${id}: tasked<rev인데 pending 요약이 없습니다.`)
    }
    if (row.length < 5) warnings.push(`${id}: ssot 행에 [?] 열이 없습니다.`)

    const content = await readIfExists(path.join(specRoot, 'ssot', `${id}.md`))
    if (content === null) {
      errors.push(`ssot/${id}.md 파일이 없습니다.`)
      continue
    }
    if (id === 'ARCH' && /\b(verify|verification|test)\b|검증/i.test(content) && !verificationTiers(content).declared) reviewHints.push('ssot/ARCH.md: verify 명령은 있으나 task / batch·push 전 / CI 검증 단계가 없습니다. gusta-create-architecture 개정 후보입니다.')
    const quote = quoteLine(content)
    const revMatch = quote?.match(/^r(\d+)\b/)
    if (!revMatch) errors.push(`ssot/${id}.md 인용줄이 'rN | 목적' 형식이 아닙니다.`)
    else if (Number.isInteger(rev) && Number(revMatch[1]) !== rev) {
      errors.push(`ssot/${id}.md의 rev(r${revMatch[1]})와 STATE rev(${rev})가 다릅니다.`)
    }

    // skeleton: fixed sections only, in order. 결정은 '결정 블록'(머리줄 + 들여쓴 하위 줄·표)이다.
    const ssotSections = sections(content)
    for (const name of SSOT_REQUIRED) {
      if (!ssotSections.has(name)) errors.push(`ssot/${id}.md에 ## ${name} 섹션이 없습니다.`)
    }
    let lastIndex = -1
    for (const [name, lines] of ssotSections) {
      const index = SSOT_SECTIONS.indexOf(name)
      if (index === -1) {
        errors.push(`ssot/${id}.md에 FORMAT 골격 밖 섹션이 있습니다: ## ${name} — 결정이면 decisions로 흡수하고, 아니면 삭제하세요.`)
        continue
      }
      if (index < lastIndex) warnings.push(`ssot/${id}.md 섹션 순서가 골격과 다릅니다: ## ${name}`)
      lastIndex = index
      let sawTopBullet = false
      for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed === '') continue
        if (TOP_BULLET.test(line)) {
          sawTopBullet = true
          continue
        }
        if (name === 'chg') {
          warnings.push(`ssot/${id}.md chg에 불릿이 아닌 줄이 있습니다: "${trimmed.slice(0, 60)}"`)
          continue
        }
        if (SUB_LINE.test(line) || TABLE_ROW.test(line)) {
          if (!sawTopBullet) {
            errors.push(
              `ssot/${id}.md ${name}: 상위 항목 없이 시작하는 하위 줄이 있습니다: "${trimmed.slice(0, 60)}"`,
            )
          }
          continue
        }
        warnings.push(`ssot/${id}.md ${name}에 불릿이 아닌 산문 줄이 있습니다: "${trimmed.slice(0, 60)}"`)
      }
    }

    // 결정 블록으로 묶기: 들여쓴 하위 줄·표는 바로 위 결정의 일부다(고유 번호를 갖지 않는다).
    const blocks = []
    for (const line of ssotSections.get('decisions') ?? []) {
      if (line.trim() === '') continue
      if (TOP_BULLET.test(line)) {
        blocks.push({ head: line.trimEnd(), subs: [] })
        continue
      }
      if (blocks.length > 0) blocks.at(-1).subs.push(line.trimEnd())
    }

    const decisions = new Set()
    let openCount = 0
    if (blocks.length === 0) warnings.push(`ssot/${id}.md의 decisions 섹션이 비어 있습니다.`)
    for (const block of blocks) {
      const trimmed = block.head.trim()
      const decision = trimmed.match(/^-\s+([A-Z]{2,6})-(\d+)\s+\[(o|x|\?)\]\s+\S/)
      if (!decision) {
        errors.push(`ssot/${id}.md 결정 라인 형식 오류: "${trimmed.slice(0, 60)}"`)
        continue
      }
      if (decision[1] !== id) errors.push(`ssot/${id}.md에 다른 도메인의 결정이 있습니다: ${decision[1]}-${decision[2]}`)
      const number = Number(decision[2])
      if (decisions.has(number)) errors.push(`ssot/${id}.md 결정 번호 중복: ${id}-${number}`)
      decisions.add(number)
      if (decision[3] === '?') openCount += 1

      const label = `ssot/${id}.md ${decision[1]}-${decision[2]}`
      for (const hint of decisionShapeHints(block.head)) reviewHints.push(`${label}: ${hint}`)
      for (const hint of proseHints(block.head)) reviewHints.push(`${label}: ${hint}`)
      for (const sub of block.subs) {
        for (const hint of proseHints(sub)) reviewHints.push(`${label}: ${hint}`)
      }
    }
    for (const name of ['flow', 'constraints']) {
      for (const line of ssotSections.get(name) ?? []) {
        if (line.trim() === '') continue
        for (const hint of proseHints(line)) reviewHints.push(`ssot/${id}.md ${name}: ${hint}`)
      }
    }
    if (row.length >= 5 && openText !== '' && Number(openText) !== openCount) {
      warnings.push(`${id}: STATE [?] 열(${openText})과 실제 미정 결정 수(${openCount})가 다릅니다.`)
    }

    const chgRevs = new Set()
    for (const chgLine of ssotSections.get('chg') ?? []) {
      const trimmed = chgLine.trim()
      if (!trimmed.startsWith('- r')) continue
      const covered = trimmed.match(/^-\s+r(\d+)\b/)
      if (covered) chgRevs.add(Number(covered[1]))
      if (/[A-Z]{2,6}-\d+✎/.test(trimmed) && !trimmed.includes('→')) {
        warnings.push(`ssot/${id}.md chg: ✎ 항목에 이전 값(old→new)이 없습니다: "${trimmed.slice(0, 60)}"`)
      }
      if (trimmed.length > CHG_LINE_MAX) {
        const where = covered ? `chg r${covered[1]}` : 'chg'
        reviewHints.push(
          `ssot/${id}.md ${where}: 요약이 ${trimmed.length}자입니다 — 결정 표기와 old→new만 남깁니다`,
        )
      }
    }
    ssotInfo.set(id, { rev, tasked, chgRevs, decisions, doc: parseSsot(content) })
  }
  for (const file of (await listIfExists(path.join(specRoot, 'ssot'))).filter((f) => f.endsWith('.md'))) {
    const id = file.replace(/\.md$/, '')
    if (!ssotIds.has(id)) errors.push(`ssot/${file}이 STATE ssot 표에 없습니다.`)
  }
  counts.ssot = ssotIds.size
  referenceChecks({ ssotInfo, cfg, format, errors, warnings, reviewHints })

  // tasks
  const taskRows = tableRows(stateSections.get('tasks'))
  const taskIds = new Set(taskRows.map((row) => row[0]))
  if (taskIds.size !== taskRows.length) errors.push('STATE tasks 표에 중복된 task ID가 있습니다.')
  const taskGraph = new Map()
  const taskLanes = new Map()
  const activeBaseByDomain = new Map()
  const fileByTaskId = new Map()
  for (const file of (await listIfExists(path.join(specRoot, 'tasks'))).filter((f) => f.endsWith('.md'))) {
    const named = file.match(/^(T\d{3,})\./)
    if (!named) {
      warnings.push(`tasks/${file}: T###.<slug>.md 형식이 아닙니다.`)
      continue
    }
    if (fileByTaskId.has(named[1])) errors.push(`태스크 파일 중복: ${named[1]} (${fileByTaskId.get(named[1])}, ${file})`)
    fileByTaskId.set(named[1], file)
  }
  // tasks/done/ 아카이브: 표에 없어야 하고, 파일 st는 done@여야 한다
  const doneIds = new Set()
  for (const file of (await listIfExists(path.join(specRoot, 'tasks', 'done'))).filter((f) => f.endsWith('.md'))) {
    const named = file.match(/^(T\d{3,})\./)
    if (!named) {
      warnings.push(`tasks/done/${file}: T###.<slug>.md 형식이 아닙니다.`)
      continue
    }
    if (doneIds.has(named[1])) errors.push(`완료 태스크 파일 중복: ${named[1]}`)
    doneIds.add(named[1])
    if (taskIds.has(named[1])) errors.push(`${named[1]}: tasks/done/ 아카이브와 STATE tasks 표에 동시에 있습니다 — done 행은 삭제하세요.`)
    if (fileByTaskId.has(named[1])) errors.push(`${named[1]}: tasks/와 tasks/done/에 파일이 모두 있습니다.`)
    const content = await readIfExists(path.join(specRoot, 'tasks', 'done', file))
    const archivedSt = quoteFields(quoteLine(content ?? '') ?? '').get('st')
    if (!archivedSt?.startsWith('done@')) {
      errors.push(`tasks/done/${file}: 아카이브된 태스크의 st가 done@가 아닙니다: ${archivedSt ?? '(없음)'}`)
    }
    // 아카이브는 '그때 무엇을 어떻게 검증했나'를 남기는 역사 기록이다 — 비어 있으면 그 기록이 없다.
    const archivedResult = (sections(content ?? '').get('result') ?? []).filter((line) => line.trim() !== '')
    if (archivedResult.length === 0) {
      warnings.push(`tasks/done/${file}: ## result가 비어 있습니다 — outcome·at·verified·limits를 남기세요.`)
    }
  }
  for (const row of taskRows) {
    const [id, , ssotCell, depCell, st] = row
    if (!TASK_ID.test(id ?? '')) {
      errors.push(`task id 형식 오류: ${id}`)
      continue
    }
    if (!TASK_ST.test(st ?? '')) errors.push(`${id}: st 형식 오류: ${st} (todo|doing@날짜.tag|done@날짜|blocked@날짜)`)
    else if (st.startsWith('doing@') && !st.includes('.')) warnings.push(`${id}: doing에 세션 tag가 없습니다 (doing@날짜.tag).`)
    else if (st.startsWith('done@')) warnings.push(`${id}: done 태스크는 표에서 삭제하고 tasks/done/으로 아카이브하세요.`)
    for (const dep of splitRefs(depCell)) {
      if (!taskIds.has(dep) && !doneIds.has(dep)) errors.push(`${id}: dep ${dep}가 tasks 표에도 tasks/done/에도 없습니다.`)
    }
    for (const domain of splitRefs(ssotCell)) {
      if (!ssotIds.has(domain)) errors.push(`${id}: ssot ${domain}이 STATE ssot 표에 없습니다.`)
    }

    const file = fileByTaskId.get(id)
    if (!file) {
      errors.push(`${id}: tasks/에 파일이 없습니다.`)
      continue
    }
    const content = await readIfExists(path.join(specRoot, 'tasks', file))
    const quote = quoteLine(content ?? '')
    if (!quote) {
      errors.push(`tasks/${file}: 인용줄이 없습니다.`)
      continue
    }
    const fields = quoteFields(quote)
    for (const value of touchesErrors(fields.get('touches'))) errors.push(`${file}: touches 경로 형식 오류: ${value}`)
    const deps = splitRefs(fields.get('dep'))
    taskGraph.set(id, deps)
    taskLanes.set(id, laneValue(fields.get('lane')))
    if ([...new Set(deps)].sort().join(' ') !== [...new Set(splitRefs(depCell))].sort().join(' ')) {
      warnings.push(`${id}: 파일 dep과 STATE dep이 다릅니다 — 두 문서의 의존성을 일치시키세요.`)
    }
    for (const key of ['st', 'ssot', 'base', 'dep']) {
      if (!fields.has(key)) errors.push(`tasks/${file}: 인용줄에 ${key}: 필드가 없습니다.`)
    }
    if (fields.has('st') && !TASK_ST.test(fields.get('st') ?? '')) errors.push(`tasks/${file}: st 형식 오류: ${fields.get('st')} (todo|doing@날짜.tag|done@날짜|blocked@날짜)`)
    if (fields.get('st') && fields.get('st') !== st) {
      warnings.push(`${id}: 파일 st(${fields.get('st')})와 STATE st(${st})가 다릅니다 — 진행 상태의 진실은 STATE.`)
    }
    // 탐색형 태스크는 시간 제한과 종료 조건 없이 시작할 수 없다(돌려 보고 정하는 일은 끝이 정해져 있어야 한다).
    const explore = exploreValue(fields.get('explore'))
    if (explore && !EXPLORE.test(explore)) errors.push(`tasks/${file}: explore 형식 오류: ${explore} (<N>m|<N>h|-)`)
    if (explore && !(sections(content).get('acceptance') ?? []).some((line) => EXIT_LINE.test(line))) {
      errors.push(`tasks/${file}: explore 태스크에는 acceptance의 \`- [ ] exit: …\` 줄(시간이 다 됐을 때 무엇을 기록하고 끝내는지)이 필요합니다.`)
    }
    for (const ref of splitRefs(fields.get('ssot'))) {
      const parsed = ref.match(/^([A-Z]{2,6})-(\d+)$/)
      if (!parsed) {
        errors.push(`tasks/${file}: ssot 참조 형식 오류: ${ref}`)
        continue
      }
      const info = ssotInfo.get(parsed[1])
      if (!info) errors.push(`tasks/${file}: 참조 도메인 ${parsed[1]}이 없습니다.`)
      else if (!info.decisions.has(Number(parsed[2]))) errors.push(`tasks/${file}: 존재하지 않는 결정 참조: ${ref}`)
    }
    for (const base of splitRefs(fields.get('base'))) {
      const parsed = base.match(/^([A-Z]{2,6})@(\d+)$/)
      if (!parsed) {
        errors.push(`tasks/${file}: base 형식 오류: ${base}`)
        continue
      }
      const info = ssotInfo.get(parsed[1])
      if (!info) {
        errors.push(`tasks/${file}: base 도메인 ${parsed[1]}이 없습니다.`)
        continue
      }
      const baseRev = Number(parsed[2])
      const lowest = activeBaseByDomain.get(parsed[1])
      if (Number.isInteger(baseRev) && (lowest === undefined || baseRev < lowest)) {
        activeBaseByDomain.set(parsed[1], baseRev)
      }
      if (baseRev > info.rev) errors.push(`tasks/${file}: base ${base}가 현재 rev(r${info.rev})보다 큽니다.`)
      else if (baseRev < info.rev && !(st ?? '').startsWith('done')) {
        warnings.push(`${id}: base ${base} < 현재 r${info.rev} — implement 전 신선도 확인 필요.`)
      }
    }
  }
  for (const [id, file] of fileByTaskId) {
    if (!taskIds.has(id)) errors.push(`tasks/${file}이 STATE tasks 표에 없습니다.`)
  }
  errors.push(...dependencyErrors(taskGraph, doneIds))
  errors.push(...laneErrors(taskLanes, taskGraph))
  // Both legacy STATE and task files may be read by clients during migration.
  // Reject a cycle in either view, without duplicating identical diagnostics.
  const stateGraph = new Map(taskRows.map(([id, , , deps]) => [id, splitRefs(deps)]))
  for (const error of dependencyErrors(stateGraph, doneIds)) {
    if (!errors.includes(error)) errors.push(error)
  }
  counts.tasks = taskIds.size
  counts.done = doneIds.size

  // chg는 미소화 델타(tasked+1..rev)와 활성 태스크의 신선도 확인(base+1..rev)이 읽는다.
  // 그 구간의 줄은 지워지면 안 되므로 빠진 rev를 경고한다.
  for (const [id, info] of ssotInfo) {
    if (!Number.isInteger(info.rev)) continue
    const consumed = Number.isInteger(info.tasked) ? info.tasked : 0
    const floor = Math.min(consumed, activeBaseByDomain.get(id) ?? consumed, info.rev)
    for (let revision = Math.max(1, Math.min(floor + 1, info.rev)); revision <= info.rev; revision += 1) {
      if (!info.chgRevs.has(revision)) {
        warnings.push(
          `ssot/${id}.md chg에 r${revision} 항목이 없습니다 — 미소화 델타와 진행 중 태스크의 신선도 확인에 필요합니다.`,
        )
      }
    }
  }

  // ideation (optional)
  const ideationRows = stateSections.has('ideation') ? tableRows(stateSections.get('ideation')) : []
  const ideationIds = new Set(ideationRows.map((row) => row[0]))
  const ideationFiles = (await listIfExists(path.join(specRoot, 'ideation'))).filter((f) => f.endsWith('.md'))
  const ideationDoneFiles = (await listIfExists(path.join(specRoot, 'ideation', 'done'))).filter((f) => f.endsWith('.md'))
  const ideationState = new Map(ideationRows.map(([id, st]) => [id, st]))
  for (const row of ideationRows) {
    const [id, st] = row
    if (!DOC_ST.test(st ?? '')) errors.push(`ideation ${id}: st 형식 오류: ${st} (open|ready|converted@날짜)`)
    if (!ideationFiles.includes(`${id}.md`)) errors.push(`ideation/${id}.md 파일이 없습니다.`)
  }
  for (const file of ideationFiles) {
    const id = file.replace(/\.md$/, '')
    if (!ideationIds.has(id)) {
      const target = stateSections.has('ideation') ? errors : warnings
      target.push(`ideation/${file}이 STATE ideation 표에 없습니다.`)
    }
    const content = await readFile(path.join(specRoot, 'ideation', file), 'utf8')
    const st = ideationChecks({ content, file: `ideation/${file}`, archived: false, ssotInfo, errors, warnings })
    if (ideationState.has(id) && ideationState.get(id) !== st) warnings.push(`ideation ${id}: 파일 st(${st})와 STATE st(${ideationState.get(id)})가 다릅니다.`)
  }
  for (const file of ideationDoneFiles) {
    const id = file.replace(/\.md$/, '')
    if (ideationIds.has(id)) errors.push(`ideation ${id}: done/ 아카이브와 STATE ideation 표에 동시에 있습니다 — 완료 행은 삭제하세요.`)
    if (ideationFiles.includes(file)) errors.push(`ideation ${id}: ideation/과 ideation/done/에 파일이 모두 있습니다.`)
    const content = await readFile(path.join(specRoot, 'ideation', 'done', file), 'utf8')
    ideationChecks({ content, file: `ideation/done/${file}`, archived: true, ssotInfo, errors, warnings })
  }

  // review (optional)
  const reviewRows = stateSections.has('review') ? tableRows(stateSections.get('review')) : []
  const reviewIds = new Set(reviewRows.map((row) => row[0]))
  const reviewFiles = (await listIfExists(path.join(specRoot, 'review'))).filter((f) => f.endsWith('.md'))
  for (const row of reviewRows) {
    const [id, st] = row
    if (!DOC_ST.test(st ?? '')) errors.push(`review ${id}: st 형식 오류: ${st} (open|ready|converted@날짜)`)
    const content = await readIfExists(path.join(specRoot, 'review', `${id}.md`))
    if (content === null) {
      errors.push(`review/${id}.md 파일이 없습니다.`)
      continue
    }
    const fields = quoteFields(quoteLine(content) ?? '')
    for (const key of ['st', 'scope', 'at', 'base']) {
      if (!fields.has(key)) errors.push(`review/${id}.md: 인용줄에 ${key}: 필드가 없습니다.`)
    }
    if (fields.get('st') && fields.get('st') !== st) {
      warnings.push(`review ${id}: 파일 st(${fields.get('st')})와 STATE st(${st})가 다릅니다 — 진행 상태의 진실은 STATE.`)
    }
    const base = fields.get('base')?.match(/^([A-Z]{2,6})@(\d+)$/)
    if (fields.has('base') && !base) errors.push(`review/${id}.md: base 형식 오류: ${fields.get('base')} (ARCH@rev)`)
    else if (base) {
      const info = ssotInfo.get(base[1])
      if (!info) errors.push(`review/${id}.md: base 도메인 ${base[1]}이 없습니다.`)
      else if (Number(base[2]) < info.rev && !(st ?? '').startsWith('converted@')) {
        warnings.push(`review ${id}: base ${base[0]} < 현재 r${info.rev} — ARCH가 바뀐 뒤의 리뷰가 아닙니다.`)
      }
    }
    const seen = new Set()
    let untasked = 0
    for (const line of (sections(content).get('findings') ?? []).filter((l) => l.trim().startsWith('- '))) {
      const trimmed = line.trim()
      const finding = trimmed.match(FINDING_LINE)
      if (!finding) {
        errors.push(`review/${id}.md finding 형식 오류: "${trimmed.slice(0, 60)}" (- Fn [?|o|x] P1|P2|P3 where: what)`)
        continue
      }
      if (seen.has(finding[1])) errors.push(`review/${id}.md finding 번호 중복: F${finding[1]}`)
      seen.add(finding[1])
      const taskRef = trimmed.match(/→(T\d{3,})\b/)
      if (taskRef && !taskIds.has(taskRef[1]) && !doneIds.has(taskRef[1])) {
        errors.push(`review/${id}.md F${finding[1]}: →${taskRef[1]}가 tasks 표에도 tasks/done/에도 없습니다.`)
      }
      if (finding[2] === 'o' && !taskRef) untasked += 1
    }
    if ((st ?? '').startsWith('converted@') && untasked > 0) {
      errors.push(`review ${id}: converted인데 →T### 없는 [o] finding이 ${untasked}개 있습니다.`)
    }
  }
  for (const file of reviewFiles) {
    const id = file.replace(/\.md$/, '')
    if (!reviewIds.has(id)) {
      const target = stateSections.has('review') ? errors : warnings
      target.push(`review/${file}이 STATE review 표에 없습니다.`)
    }
  }

  // active (이관 전 STATE에만): 실행 중인 세션 한 줄씩, 여섯 칸.
  const activeRows = stateSections.has('active') ? tableRows(stateSections.get('active')) : []
  const activeTags = new Set()
  const stByTask = new Map(taskRows.map((row) => [row[0], row[4]]))
  for (const row of activeRows) {
    const [tag, host, mode, since, at, doing] = row
    if (row.length !== 6) {
      errors.push(`active 행 형식 오류: | ${row.join(' | ')} | (tag|host|mode|since|at|doing)`)
      continue
    }
    if (!SESSION_TAG.test(tag)) errors.push(`active tag 형식 오류: ${tag} (영숫자 2-8자)`)
    if (activeTags.has(tag)) errors.push(`active tag 중복: ${tag}`)
    activeTags.add(tag)
    if (!host || host === '-') errors.push(`active ${tag}: host가 없습니다.`)
    if (!['pair', 'autopilot'].includes(mode)) errors.push(`active ${tag}: mode는 pair|autopilot입니다: ${mode}`)
    for (const [name, value] of [['since', since], ['at', at]]) {
      if (!ISO_UTC.test(value ?? '')) errors.push(`active ${tag}: ${name}는 ISO UTC(2026-10-13T07:44Z)여야 합니다: ${value}`)
    }
    if (doing !== '-') {
      if (!TASK_ID.test(doing ?? '') || !taskIds.has(doing)) errors.push(`active ${tag}: doing ${doing}가 STATE tasks 표에 없습니다.`)
      else if (stByTask.get(doing) !== undefined && !new RegExp(`^doing@\\d{6}\\.${tag}$`).test(stByTask.get(doing))) {
        warnings.push(`active ${tag}: ${doing}의 st(${stByTask.get(doing)})가 doing@날짜.${tag}가 아닙니다.`)
      }
    }
  }

  // 디자인 중 상태는 checkout 로컬(vibe design)이다. 0.8.0의 STATE ## design은 기획 커밋으로 다른 worktree에 퍼진다.
  if (stateSections.has('design')) warnings.push('STATE ## design은 더 쓰지 않습니다 — 디자인 중 상태는 checkout 로컬(vibe design)에 둡니다. 섹션을 지우세요.')

  // inbox (이관 전 STATE에만): 맡김 모드가 내린 잠정 결정·주차한 일. 이 트리에 있는 ID만 가리킨다.
  for (const line of stateSections.get('inbox') ?? []) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const entry = trimmed.match(INBOX_LINE)
    if (!entry) {
      errors.push(`inbox 줄 형식 오류: "${trimmed.slice(0, 60)}" (- YYMMDD decided|parked|suggest <refs>: <text>)`)
      continue
    }
    const refs = splitRefs(entry[3])
    if (refs.length === 0 && entry[3].trim() !== '-') errors.push(`inbox 참조가 비어 있습니다: "${trimmed.slice(0, 60)}"`)
    for (const ref of refs) {
      const decision = ref.match(/^([A-Z]{2,6})-(\d+)$/)
      const doc = ref.match(/^(review|ideation)\/(.+)$/)
      if (decision) {
        if (!ssotInfo.get(decision[1])?.decisions.has(Number(decision[2]))) errors.push(`inbox: 존재하지 않는 결정 참조: ${ref}`)
      } else if (TASK_ID.test(ref)) {
        if (!taskIds.has(ref) && !doneIds.has(ref)) errors.push(`inbox: ${ref}가 tasks 표에도 tasks/done/에도 없습니다.`)
      } else if (doc) {
        const files = doc[1] === 'review' ? reviewFiles : [...ideationFiles, ...ideationDoneFiles, ...ideationDoneFiles.map((file) => `done/${file}`)]
        if (!files.includes(`${doc[2]}.md`)) errors.push(`inbox: ${ref} 문서가 없습니다.`)
      } else errors.push(`inbox: 알 수 없는 참조: ${ref} (<ID>-n|T###|review/<slug>|ideation/<slug>|-)`)
    }
  }

  // reports (optional): 맡김 세션마다 owner가 읽는 보고서. 골격만 검사한다(본문은 cfg.lang 산문).
  for (const file of (await listIfExists(path.join(specRoot, 'reports'))).filter((f) => f.endsWith('.md'))) {
    const named = file.match(REPORT_FILE)
    if (!named) {
      errors.push(`reports/${file}: <YYMMDD>-<tag>.md 형식이 아닙니다.`)
      continue
    }
    const content = (await readIfExists(path.join(specRoot, 'reports', file))) ?? ''
    if (!new RegExp(`^# REPORT ${named[1]}\\s*$`, 'm').test(content)) errors.push(`reports/${file}: 제목이 '# REPORT ${named[1]}'가 아닙니다.`)
    const fields = quoteFields(quoteLine(content) ?? '')
    for (const key of ['mode', 'host', 'from', 'to', 'push']) {
      if (!fields.has(key)) errors.push(`reports/${file}: 인용줄에 ${key}: 필드가 없습니다.`)
    }
    const names = [...sections(content).keys()]
    for (const name of names) {
      if (!REPORT_SECTIONS.includes(name)) errors.push(`reports/${file}: FORMAT 골격 밖 섹션이 있습니다: ## ${name}`)
    }
    for (const name of REPORT_SECTIONS) {
      if (!names.includes(name)) errors.push(`reports/${file}에 ## ${name} 섹션이 없습니다.`)
    }
    const order = names.filter((name) => REPORT_SECTIONS.includes(name))
    if (order.join(' ') !== REPORT_SECTIONS.filter((name) => order.includes(name)).join(' ')) warnings.push(`reports/${file} 섹션 순서가 골격과 다릅니다.`)
  }

  // SETTINGS.md (optional): a missing file or key means the default. An invalid value is an error —
  // prune acts on it, and refuses to guess.
  const settings = await readIfExists(path.join(specRoot, 'SETTINGS.md'))
  if (settings !== null) {
    const parsed = parseSettings(settings)
    for (const problem of parsed.errors) errors.push(`SETTINGS.md: ${problem}`)
    for (const key of parsed.unknown) warnings.push(`SETTINGS.md: 알 수 없는 설정 ${key} — vibe settings로 지원 키를 확인하세요.`)
  }

  // next / log (log는 이관 전 STATE에만)
  const logLines = (stateSections.get('log') ?? []).filter((line) => line.trim().startsWith('- '))
  if (logLines.length > 20) warnings.push(`STATE log가 ${logLines.length}줄입니다 — 20줄 초과분은 삭제 (FORMAT).`)
  const nextLines = (stateSections.get('next') ?? []).filter((line) => line.trim().startsWith('- '))
  if (stateSections.has('next') && nextLines.length === 0) warnings.push('STATE next가 비어 있습니다 — 다음 할 일을 남기세요.')

  return { ok: errors.length === 0, errors, warnings, reviewHints, counts }
}
