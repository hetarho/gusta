import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { git, inspectWorkspace } from './workspace.mjs'
import { parseSsot, references, refId, quoteLine, quoteFields, sections, splitRefs, INBOX_LINE, TASK_ID } from './spec-format.mjs'
import { SkillPackageError } from './errors.mjs'

const sha256 = (text) => createHash('sha256').update(text).digest('hex')
const DECISION_ID = /^([A-Z]{2,6})-(\d+)$/
const DOMAIN_ID = /^[A-Z]{2,6}$/
const SINCE_ID = /^([A-Z]{2,6})@(\d+)$/
const CHG_LINE = /^-\s+r(\d+)\b/
// Scope of a cited decision's domain. domain (default, and what pre-0.7 tasks were written for):
// the current rules of every cited domain, whole. cited: only the cited blocks and what they
// reference — precise, and safe only when tasks cite every decision they must obey.
const SCOPES = ['domain', 'cited']

// Why a decision is in the brief, strongest first. Unclassified references are followed one hop
// from a block the task itself depends on (cited, named, changed, or required by one of those).
// A block that is in only through such a hop, or only because it is global, lists its own
// unclassified references instead of pulling them in. Typed references always pull.
const PRECEDENCE = ['cited', 'root', 'changed', 'always', 'canonical', 'requires', 'domain', 'referrer', 'mention', 'unclassified']
const NO_HOP = new Set(['always', 'domain', 'referrer', 'mention', 'unclassified'])
const KEEPS_REJECTED = new Set(['cited', 'root', 'changed', 'always', 'canonical', 'requires'])
const TYPED = new Set(['requires', 'canonical'])

function fail(message, details = []) { throw new SkillPackageError(message, details) }

async function optionalRead(file) {
  try { return await readFile(file, 'utf8') } catch (error) {
    if (['ENOENT', 'EISDIR'].includes(error.code)) return null
    throw error
  }
}

// One source per brief — a fixed commit, or the working tree as it is now. Never both: a task
// from one and a policy from the other would describe a state that never existed.
export function commitSource(root, commit) {
  return {
    kind: 'commit', root, commit, head: commit, dirty: [],
    read: (relative) => git(root, ['show', `${commit}:${relative}`], [128]),
    list: async (directory) => (await git(root, ['ls-tree', '--name-only', '-z', `${commit}:${directory}`], [128]))?.split('\0').filter(Boolean) ?? [],
  }
}

async function worktreeSource(root, workspace) {
  const dirty = []
  if (workspace.git?.head) {
    const entries = (await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', 'spec'])).split('\0')
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]
      if (entry.length < 4) continue
      dirty.push(entry.slice(3))
      if (/^[RC]/.test(entry)) index += 1
    }
  }
  return {
    kind: workspace.git ? 'worktree' : 'files', root, commit: null, head: workspace.git?.head ?? null, dirty: dirty.sort(),
    read: (relative) => optionalRead(path.join(root, relative)),
    list: async (directory) => {
      try { return (await readdir(path.join(root, directory))).sort() } catch (error) {
        if (['ENOENT', 'ENOTDIR'].includes(error.code)) return []
        throw error
      }
    },
  }
}

export async function specSource({ targetRoot, ref } = {}) {
  const workspace = await inspectWorkspace({ targetRoot })
  const root = workspace.git?.root ?? workspace.targetRoot
  if (!ref) return worktreeSource(root, workspace)
  if (!workspace.git?.head) fail('--ref에는 커밋이 있는 Git checkout이 필요합니다.')
  const commit = await git(root, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`], [1])
  if (!commit) fail(`커밋을 찾을 수 없습니다: ${ref}`)
  return commitSource(root, commit.trim())
}

function cfgOf(state) {
  const map = new Map()
  for (const line of sections(state ?? '').get('cfg') ?? []) {
    const match = line.match(/^-\s+([\w-]+):\s*([^#]*)/)
    if (match) map.set(match[1], match[2].trim())
  }
  return map
}

function parseRoots(roots) {
  const parsed = { tasks: [], decisions: [], domains: [], since: [] }
  for (const root of roots) {
    if (TASK_ID.test(root)) parsed.tasks.push(root)
    else if (DECISION_ID.test(root)) parsed.decisions.push(root)
    else if (SINCE_ID.test(root)) parsed.since.push(root)
    else if (DOMAIN_ID.test(root)) parsed.domains.push(root)
    else fail(`brief 대상 형식 오류: ${root} (T### | <ID>-n | <ID> | <ID>@rev)`)
  }
  if (roots.length === 0) fail('brief 대상이 필요합니다: T### | <ID>-n | <ID> | <ID>@rev')
  return parsed
}

const byId = (left, right) => {
  const [a, b] = [left.match(DECISION_ID), right.match(DECISION_ID)]
  return a[1] === b[1] ? Number(a[2]) - Number(b[2]) : a[1] < b[1] ? -1 : 1
}

// The context one task (or a unit, a decision, a domain, a rev range) needs, as whole blocks
// copied from one source: cited decisions, what they require or delegate to, unclassified
// references one hop away, the project's global rules, the flow·constraints of every domain it
// draws from, and the chg lines since a stale base. Nothing is cut to fit a size: what could
// not be found or followed is reported, never dropped quietly.
// `always` replaces cfg always for one call (measurement, tests); callers normally omit it.
// `coordination` is the owner's inbox on the coordination branch as the caller read it:
// { branch, commit, inbox: lines, error? }. It is the one part of a brief that does not come from
// `source` — the inbox is not in any code commit — so the brief names its own origin for it
// (source.inbox). Without it only the `## inbox` the source's STATE still carries is read.
export async function assembleBrief({ source, roots, deep = false, always: alwaysOverride, scope: scopeOverride, referrers: withReferrers = true, coordination = null }) {
  const parsed = parseRoots(roots)
  const issues = []
  const issue = (level, code, message) => {
    if (!issues.some((entry) => entry.code === code && entry.message === message)) issues.push({ level, code, message })
  }
  const known = new Set((await source.list('spec/ssot')).filter((name) => name.endsWith('.md')).map((name) => name.slice(0, -3)).filter((id) => DOMAIN_ID.test(id)))
  const docs = new Map()
  const doc = async (id) => {
    if (!docs.has(id)) {
      const file = `spec/ssot/${id}.md`
      const text = known.has(id) ? await source.read(file) : null
      const entry = text === null ? null : { id, path: file, sha256: sha256(text), ...parseSsot(text) }
      if (entry && !entry.sections.has('chg')) issue('error', 'unbounded-doc', `${file}에 ## chg가 없습니다 — 잘린 문서이거나 골격 위반이라 마지막 블록의 끝을 확인할 수 없습니다.`)
      if (entry) for (const block of entry.duplicates) issue('error', 'duplicate-decision', `${file}:${block.start} ${block.id}가 두 번 있습니다 — 첫 블록만 실었습니다.`)
      docs.set(id, entry)
    }
    return docs.get(id)
  }
  const state = await source.read('spec/STATE.md')
  const cfg = cfgOf(state)
  const scope = scopeOverride ? { value: scopeOverride, source: 'override' } : { value: cfg.get('brief') || 'domain', source: cfg.has('brief') ? 'cfg' : 'default' }
  if (!SCOPES.includes(scope.value)) {
    issue('error', 'bad-scope', `STATE cfg brief 값이 잘못됐습니다: ${scope.value} (domain|cited) — domain으로 실었습니다.`)
    scope.value = 'domain'
  }

  // tasks
  const tasks = []
  const activeFiles = (await source.list('spec/tasks')).filter((name) => name.endsWith('.md'))
  const doneFiles = parsed.tasks.length ? (await source.list('spec/tasks/done')).filter((name) => name.endsWith('.md')) : []
  for (const id of parsed.tasks) {
    const active = activeFiles.find((name) => name.startsWith(`${id}.`))
    const archived = active ? null : doneFiles.find((name) => name.startsWith(`${id}.`))
    if (!active && !archived) { issue('error', 'missing-task', `${id}: spec/tasks/에 태스크 파일이 없습니다.`); continue }
    const file = active ? `spec/tasks/${active}` : `spec/tasks/done/${archived}`
    const content = (await source.read(file)) ?? ''
    const fields = quoteFields(quoteLine(content) ?? '')
    if (archived) issue('warn', 'archived-task', `${id}는 tasks/done/의 완료 기록입니다 — 그때의 기준이지 현재 규칙이 아닙니다.`)
    if (!sections(content).has('result')) issue('error', 'unbounded-task', `${file}에 ## result가 없습니다 — 잘린 태스크이거나 골격 위반입니다.`)
    const body = content.split(/\r?\n/).filter((line) => !line.startsWith('> ') && !/^# /.test(line)).join('\n')
    tasks.push({ id, file, content, sha256: sha256(content), archived: Boolean(archived), ssot: splitRefs(fields.get('ssot')), base: splitRefs(fields.get('base')), body })
  }

  // inclusion
  const included = new Map()
  const queue = []
  const rejected = new Map()
  const add = async (id, kind, from) => {
    const domain = id.split('-')[0]
    const block = (await doc(domain))?.decisions.get(id)
    if (!block) return false
    let entry = included.get(id)
    if (!entry) {
      if (block.status === 'rejected' && !KEEPS_REJECTED.has(kind)) {
        if (!rejected.has(id)) rejected.set(id, new Set())
        rejected.get(id).add(from)
        return true
      }
      entry = { id, domain, block, via: [], strong: false, expanded: null }
      included.set(id, entry)
    }
    if (!entry.via.some((via) => via.kind === kind && via.from === from)) entry.via.push({ kind, from })
    if (!NO_HOP.has(kind) && !entry.strong) entry.strong = true
    if (entry.expanded !== 'strong') queue.push(entry)
    return true
  }
  const addDomain = async (domain, kind, from) => {
    const target = await doc(domain)
    if (!target) return false
    for (const id of target.decisions.keys()) {
      if (target.decisions.get(id).status === 'rejected') { if (!rejected.has(id)) rejected.set(id, new Set()); rejected.get(id).add(from) }
      else await add(id, kind, from)
    }
    return true
  }
  const refsIn = (text, self) => references(text).filter((ref) => known.has(ref.domain) && refId(ref) !== self)
  const absent = new Set()
  const missing = (ref, from, followed) => {
    absent.add(refId(ref))
    const what = `${ref.kind === 'unclassified' ? '' : ref.kind + ' '}${ref.raw}`
    if (ref.kind !== 'unclassified') issue('error', 'missing-decision', `${from}: ${what} 대상 ${refId(ref)}가 없습니다.`)
    else if (followed) issue('error', 'missing-ref', `${from}: 참조 ${ref.raw}의 대상 ${refId(ref)}가 없습니다.`)
  }
  const follow = async (ref, kind, from) => {
    const found = ref.number === null ? await addDomain(ref.domain, kind, from) : await add(refId(ref), kind, from)
    if (!found) missing(ref, from, true)
  }
  const drain = async () => {
    while (queue.length) {
      const entry = queue.shift()
      const followWeak = deep || entry.strong
      if (entry.expanded === 'strong' || (entry.expanded === 'weak' && !followWeak)) continue
      entry.expanded = followWeak ? 'strong' : 'weak'
      for (const ref of refsIn(entry.block.text, entry.id)) {
        if (TYPED.has(ref.kind)) await follow(ref, ref.kind, entry.id)
        else if (ref.kind === 'unclassified' && followWeak && (ref.number !== null || deep)) await follow(ref, 'unclassified', entry.id)
      }
    }
  }

  // cited decisions keep the order the old brief used: domain of first citation, then citation order
  const citedIds = [...new Set(tasks.flatMap((task) => task.ssot))]
  const cited = []
  for (const domain of [...new Set(citedIds.map((ref) => ref.split('-')[0]))]) cited.push(...citedIds.filter((ref) => ref.startsWith(`${domain}-`)))
  for (const task of tasks) {
    for (const ref of task.ssot) {
      if (!DECISION_ID.test(ref)) issue('error', 'bad-citation', `${task.id}: ssot 참조 형식 오류: ${ref}`)
      else if (!(await add(ref, 'cited', task.id))) issue('error', 'missing-decision', `${task.id}: 인용한 ${ref}가 없습니다.`)
    }
    // A decision named in the task body is in too (one hop, like an unclassified reference).
    for (const ref of refsIn(task.body, null)) {
      if (ref.number === null || ref.kind === 'related' || task.ssot.includes(refId(ref))) continue
      if (!(await add(refId(ref), TYPED.has(ref.kind) ? ref.kind : 'mention', task.id))) missing(ref, task.id, true)
    }
  }
  // scope domain: the current rules of every cited domain, whole (no chg)
  if (scope.value === 'domain') for (const domain of [...new Set(cited.map((ref) => ref.split('-')[0]))]) await addDomain(domain, 'domain', tasks.find((task) => task.ssot.some((ref) => ref.startsWith(`${domain}-`))).id)
  // referrers: decisions that point at a cited decision apply it elsewhere, so they constrain the change
  if (withReferrers && cited.length) {
    const wanted = new Set(cited)
    for (const domain of [...known].sort()) {
      const target = await doc(domain)
      if (!target) continue
      for (const block of target.decisions.values()) {
        if (block.status === 'rejected' || wanted.has(block.id)) continue
        for (const ref of refsIn(block.text, block.id)) if (ref.kind !== 'related' && wanted.has(refId(ref))) await add(block.id, 'referrer', refId(ref))
      }
    }
  }
  for (const id of parsed.decisions) if (!(await add(id, 'root', 'arg'))) issue('error', 'missing-decision', `${id}가 없습니다.`)
  for (const domain of parsed.domains) if (!(await addDomain(domain, 'root', 'arg'))) issue('error', 'missing-domain', `spec/ssot/${domain}.md가 없습니다.`)

  // global rules: the project's cfg always, or every ARCH decision when a project never chose
  const always = alwaysOverride ? { source: 'override', ids: alwaysOverride }
    : { source: cfg.has('always') ? 'cfg' : 'default', ids: cfg.has('always') ? splitRefs(cfg.get('always')) : known.has('ARCH') ? ['ARCH'] : [] }
  if (parsed.tasks.length) {
    for (const id of always.ids) {
      const found = DOMAIN_ID.test(id) ? await addDomain(id, 'always', 'cfg') : DECISION_ID.test(id) ? await add(id, 'always', 'cfg') : false
      if (!found) issue('error', 'always-unknown', `STATE cfg always의 ${id}가 없습니다.`)
    }
  }

  // history: chg lines after a stale task base, or after an explicit <ID>@rev
  const history = []
  const changed = new Map()
  const ranges = new Map()
  for (const task of tasks) {
    for (const base of task.base) {
      const match = base.match(SINCE_ID)
      if (!match) { issue('error', 'bad-base', `${task.id}: base 형식 오류: ${base}`); continue }
      const target = await doc(match[1])
      if (!target) { issue('error', 'missing-domain', `${task.id}: base 도메인 ${match[1]}이 없습니다.`); continue }
      const rev = Number(match[2])
      if (target.rev !== null && rev > target.rev) issue('error', 'base-ahead', `${task.id}: base ${base}가 현재 r${target.rev}보다 큽니다 — 다른 기준의 정책입니다.`)
      else if (target.rev !== null && rev < target.rev) {
        issue('warn', 'stale-base', `${task.id}: base ${base} < 현재 r${target.rev} — history의 변경이 이 태스크에 영향을 주는지 확인하세요.`)
        ranges.set(match[1], Math.min(rev, ranges.get(match[1]) ?? rev))
      }
    }
  }
  for (const since of parsed.since) {
    const [, domain, rev] = since.match(SINCE_ID)
    if (!(await doc(domain))) { issue('error', 'missing-domain', `spec/ssot/${domain}.md가 없습니다.`); continue }
    ranges.set(domain, Math.min(Number(rev), ranges.get(domain) ?? Number(rev)))
  }
  for (const [domain, from] of [...ranges].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const target = await doc(domain)
    const lines = (target.sections.get('chg')?.text ?? '').split('\n').filter((line) => CHG_LINE.test(line.trim())).map((line) => line.trim())
    const inRange = lines.filter((line) => Number(line.match(CHG_LINE)[1]) > from)
    const seen = new Set(inRange.map((line) => Number(line.match(CHG_LINE)[1])))
    const gaps = []
    for (let rev = from + 1; rev <= (target.rev ?? from); rev += 1) if (!seen.has(rev)) gaps.push(rev)
    if (gaps.length) issue('error', 'history-gap', `${target.path} chg에 r${gaps.join(', r')} 줄이 없습니다 — r${from} 이후 변경을 다 확인할 수 없습니다.`)
    history.push({ domain, from, to: target.rev, lines: inRange, missing: gaps })
    for (const line of inRange) for (const ref of refsIn(line, null)) if (ref.number !== null) {
      if (!changed.has(refId(ref))) changed.set(refId(ref), new Set())
      changed.get(refId(ref)).add(`${domain}@${from}`)
    }
  }
  for (const since of parsed.since) {
    const [, domain] = since.match(SINCE_ID)
    for (const [id, from] of changed) if (from.has(`${domain}@${ranges.get(domain)}`)) await add(id, 'changed', since)
  }
  await drain()

  // flow·constraints carry rules too: whole sections of every domain the brief draws from
  const sectionList = []
  const sectionDone = new Set()
  for (;;) {
    const domains = [...new Set([...[...included.values()].map((entry) => entry.domain), ...tasks.flatMap((task) => task.base.map((base) => base.split('@')[0])), ...parsed.domains])]
      .filter((domain) => !sectionDone.has(domain) && known.has(domain)).sort()
    if (!domains.length) break
    for (const domain of domains) {
      sectionDone.add(domain)
      const target = await doc(domain)
      if (!target) continue
      for (const name of ['flow', 'constraints']) {
        const section = target.sections.get(name)
        if (!section || !section.text) continue
        const entry = { domain, name, text: section.text, path: target.path, lines: [section.start + 1, section.end], sha256: sha256(section.text) }
        sectionList.push(entry)
        for (const ref of refsIn(section.text, null)) {
          if (TYPED.has(ref.kind)) await follow(ref, ref.kind, `${domain} ${name}`)
          else if (ref.kind === 'unclassified' && deep) await follow(ref, 'unclassified', `${domain} ${name}`)
        }
      }
    }
    await drain()
  }

  // what is in, in a fixed order: cited and named roots first, then by domain and number
  const first = [...cited, ...parsed.decisions].filter((id, index, list) => included.has(id) && list.indexOf(id) === index)
  const ordered = [...first, ...[...included.keys()].filter((id) => !first.includes(id)).sort(byId)]
  const decisions = []
  for (const id of ordered) {
    const { block, domain, via } = included.get(id)
    const target = docs.get(domain)
    let text = block.text
    // A top-level bullet that is not a decision line ends the block in the file; keep what it
    // carries with the decision before it rather than lose a condition, and say so.
    for (const stray of target.malformed.filter((entry) => entry.after === id)) {
      text += `\n${stray.text}`
      issue('error', 'malformed-line', `${target.path}:${stray.start} 결정 줄 형식이 아닌 최상위 항목을 ${id}에 붙여 실었습니다 — 하위 항목이면 2칸 들여쓰세요.`)
    }
    const sorted = [...via].sort((a, b) => PRECEDENCE.indexOf(a.kind) - PRECEDENCE.indexOf(b.kind) || (a.from < b.from ? -1 : a.from > b.from ? 1 : 0))
    if (block.status === 'rejected') issue('warn', 'rejected-decision', `${id}는 [x](더 이상 유효하지 않음)입니다 — ${sorted[0].kind} ${sorted[0].from}. 현재 규칙으로 적용하지 마세요.`)
    else if (block.status === 'open' && sorted.some((entry) => ['cited', 'requires', 'canonical', 'root'].includes(entry.kind))) {
      issue('warn', 'open-decision', `${id}는 [?](미정)입니다 — 규칙이 아니라 열린 질문입니다. 구현이 이것에 기대면 기획 결정이 먼저입니다.`)
    }
    decisions.push({ id, text, domain, status: block.status, via: sorted, path: target.path, lines: [block.start, block.end], sha256: sha256(text) })
  }
  for (const target of docs.values()) {
    if (!target || !decisions.some((entry) => entry.domain === target.id)) continue
    if (target.orphans.length) issue('warn', 'orphan-lines', `${target.path}:${target.orphans[0]} decisions에 결정 줄 밖의 줄이 있습니다 — 어느 결정에도 실리지 않았습니다.`)
  }

  // references left out, by reason — listed with where they came from, never dropped silently
  const related = new Map()
  const unfollowed = new Map()
  const note = (map, id, from) => { if (!map.has(id)) map.set(id, new Set()); map.get(id).add(from) }
  const leftOut = async (text, self, from) => {
    for (const ref of refsIn(text, self)) {
      const id = refId(ref)
      if (included.has(id) || rejected.has(id) || absent.has(id) || !['related', 'unclassified'].includes(ref.kind)) continue
      const target = await doc(ref.domain)
      if (ref.number === null && target && [...target.decisions.values()].every((block) => block.status === 'rejected' || included.has(block.id))) continue
      if (ref.number !== null && !target?.decisions.has(id)) { issue('warn', 'dangling-ref', `${from}: 참조 ${ref.raw}의 대상 ${id}가 없습니다.`); continue }
      if (ref.number !== null && target.decisions.get(id).status === 'rejected') { note(rejected, id, from); continue }
      note(ref.kind === 'related' ? related : unfollowed, id, from)
    }
  }
  for (const entry of included.values()) await leftOut(entry.block.text, entry.id, entry.id)
  for (const section of sectionList) await leftOut(section.text, null, `${section.domain} ${section.name}`)
  for (const task of tasks) await leftOut(task.body, null, task.id)
  const listed = (map) => [...map].sort(([a], [b]) => (a < b ? -1 : 1)).map(([id, from]) => ({ id, from: [...from].sort() }))

  // referrers: who points at a named decision (planning: the blast radius of a change)
  const referrers = []
  if (parsed.decisions.length) {
    const wanted = new Set(parsed.decisions)
    const found = new Map(parsed.decisions.map((id) => [id, { id, decisions: [], tasks: [] }]))
    for (const domain of [...known].sort()) {
      const target = await doc(domain)
      if (!target) continue
      for (const block of target.decisions.values()) {
        for (const ref of refsIn(block.text, block.id)) {
          const id = refId(ref)
          if (wanted.has(id) && !found.get(id).decisions.some((entry) => entry.id === block.id && entry.kind === ref.kind)) found.get(id).decisions.push({ id: block.id, kind: ref.kind })
        }
      }
      for (const [name, section] of target.sections) {
        if (!['flow', 'constraints'].includes(name)) continue
        for (const ref of refsIn(section.text ?? '', null)) if (wanted.has(refId(ref))) found.get(refId(ref)).decisions.push({ id: `${domain} ${name}`, kind: ref.kind })
      }
    }
    for (const file of activeFiles) {
      const fields = quoteFields(quoteLine((await source.read(`spec/tasks/${file}`)) ?? '') ?? '')
      for (const ref of splitRefs(fields.get('ssot'))) if (wanted.has(ref)) found.get(ref).tasks.push({ id: file.split('.')[0], st: fields.get('st') ?? null })
    }
    referrers.push(...found.values())
  }

  // inbox lines about these tasks or the decisions they depend on — not the whole inbox, and not
  // lines about a global rule or a one-hop neighbour that happen to be in the brief
  const ids = new Set([...tasks.map((task) => task.id), ...[...included.values()].filter((entry) => entry.strong).map((entry) => entry.id)])
  const about = (line) => { const entry = line.match(INBOX_LINE); return entry && entry[3].split(/\s+/).some((ref) => ids.has(ref)) }
  // The coordination branch's lines first, then those only the source's STATE holds (a project
  // that has not moved its inbox yet). The rules above stay on the one source; only these lines
  // have another origin, and it is named.
  const shared = (coordination?.inbox ?? []).map((line) => line.trim()).filter(about)
  const legacy = (sections(state ?? '').get('inbox') ?? []).map((line) => line.trim()).filter((line) => about(line) && !shared.includes(line))
  const inbox = [...shared, ...legacy]
  if (coordination?.error) issue('warn', 'inbox-unavailable', `조정 브랜치를 읽지 못해 inbox가 빠졌을 수 있습니다: ${coordination.error}`)
  const inboxSource = coordination && !coordination.error ? { branch: coordination.branch, commit: coordination.commit ?? null, ...(legacy.length ? { state: legacy.length } : {}) } : null

  const domains = [...docs.values()].filter((target) => target && (decisions.some((entry) => entry.domain === target.id) || sectionList.some((entry) => entry.domain === target.id) || history.some((entry) => entry.domain === target.id)))
    .map((target) => ({ id: target.id, path: target.path, rev: target.rev, sha256: target.sha256 })).sort((a, b) => (a.id < b.id ? -1 : 1))
  const chars = [...tasks.map((task) => task.content), ...decisions.map((entry) => entry.text), ...sectionList.map((entry) => entry.text), ...history.flatMap((entry) => entry.lines)]
    .reduce((sum, text) => sum + text.length, 0)
  return {
    schemaVersion: 1, roots: [...roots], deep, complete: !issues.some((entry) => entry.level === 'error'),
    source: { kind: source.kind, commit: source.commit, head: source.head, dirty: source.dirty, ...(inboxSource ? { inbox: inboxSource } : {}) }, scope: parsed.tasks.length ? scope : null,
    cfg: { level: cfg.get('level') ?? null, lang: cfg.get('lang') ?? null },
    always: parsed.tasks.length ? always : null,
    tasks: tasks.map(({ id, file, content, sha256: digest, archived }) => ({ id, file, content, sha256: digest, ...(archived ? { archived } : {}) })),
    decisions, sections: sectionList, domains, history,
    refs: { related: listed(related), unfollowed: listed(unfollowed), rejected: listed(rejected), changed: listed(new Map([...changed].filter(([id]) => !included.has(id)))) },
    referrers, inbox, issues, size: { decisions: decisions.length, chars },
  }
}

export async function specBrief(options = {}) {
  const source = await specSource(options)
  return assembleBrief({ source, roots: options.roots ?? [], deep: Boolean(options.deep) })
}

const short = (value) => value ? value.slice(0, 12) : '-'

function whyLines(brief) {
  const groups = new Map()
  for (const entry of brief.decisions) {
    const top = entry.via[0]
    const from = entry.via.filter((via) => via.kind === top.kind).map((via) => via.from)
    if (!groups.has(top.kind)) groups.set(top.kind, [])
    groups.get(top.kind).push(['cited', 'root', 'always'].includes(top.kind) ? entry.id : `${entry.id}←${from.join(',')}`)
  }
  return PRECEDENCE.filter((kind) => groups.has(kind)).map((kind) => `- ${kind}: ${['always', 'domain'].includes(kind) ? ranges(groups.get(kind).map((entry) => entry.split('←')[0])) : groups.get(kind).join(' ')}`)
}

// ARCH-1 ARCH-2 ARCH-3 ARCH-7 → ARCH-1–3 ARCH-7
function ranges(ids) {
  const out = []
  for (const id of [...ids].sort(byId)) {
    const [, domain, number] = id.match(DECISION_ID)
    const last = out.at(-1)
    if (last && last.domain === domain && last.to === Number(number) - 1) last.to = Number(number)
    else out.push({ domain, from: Number(number), to: Number(number) })
  }
  return out.map((entry) => `${entry.domain}-${entry.from}${entry.to > entry.from ? `–${entry.to}` : ''}`).join(' ')
}

// Markdown for a model to read: verbatim blocks grouped by domain, provenance on each header,
// issues first, and an end line whose absence means the output was cut.
export function renderBrief(brief) {
  const out = []
  const label = brief.roots.join(' ')
  const source = brief.source.kind === 'commit'
    ? `commit:${short(brief.source.commit)}`
    : `${brief.source.kind}${brief.source.head ? ` head:${short(brief.source.head)}` : ''}${brief.source.dirty.length ? ` dirty:${brief.source.dirty.join(',')}` : ''}`
  out.push(`# BRIEF ${label}`)
  out.push(`> source:${source} | complete:${brief.complete ? 'yes' : 'no'} | decisions:${brief.decisions.length} | unfollowed:${brief.refs.unfollowed.length}${brief.scope ? ` | scope:${brief.scope.value} (${brief.scope.source})` : ''}${brief.always ? ` | always:${brief.always.ids.join(' ') || '-'} (${brief.always.source})` : ''}`)
  if (brief.issues.length) {
    out.push('', '## issues')
    for (const entry of brief.issues) out.push(`- ${entry.level} ${entry.code}: ${entry.message}`)
  }
  for (const task of brief.tasks) {
    out.push('', `## ${task.id} · ${task.file} · sha256:${short(task.sha256)}`, '````md', task.content.replace(/\s+$/, ''), '````')
  }
  const domainOrder = [...new Set([...brief.decisions.map((entry) => entry.domain), ...brief.sections.map((entry) => entry.domain)])]
  for (const domain of domainOrder) {
    const info = brief.domains.find((entry) => entry.id === domain)
    out.push('', `## ${domain} r${info?.rev ?? '?'} · ${info?.path ?? '-'} · sha256:${short(info?.sha256)}`)
    for (const entry of brief.decisions.filter((item) => item.domain === domain)) out.push(entry.text)
    for (const section of brief.sections.filter((item) => item.domain === domain)) out.push(`### ${domain} ${section.name}`, section.text)
  }
  if (brief.decisions.length) out.push('', '## why', ...whyLines(brief))
  for (const entry of brief.history) {
    out.push('', `## history ${entry.domain} r${entry.from}→r${entry.to ?? '?'}`, ...(entry.lines.length ? entry.lines : ['- (none)']))
    if (entry.missing.length) out.push(`- missing: r${entry.missing.join(' r')}`)
  }
  const left = [['related', brief.refs.related], ['unfollowed', brief.refs.unfollowed], ['rejected', brief.refs.rejected], ['changed', brief.refs.changed]].filter(([, list]) => list.length)
  if (left.length) {
    out.push('', '## not included')
    for (const [kind, list] of left) out.push(`- ${kind}: ${list.map((entry) => `${entry.id}←${entry.from.join(',')}`).join(' ')}`)
  }
  for (const entry of brief.referrers) {
    out.push('', `## referrers ${entry.id}`)
    const kinds = [...new Set(entry.decisions.map((item) => item.kind))]
    for (const kind of kinds) out.push(`- ${kind}: ${entry.decisions.filter((item) => item.kind === kind).map((item) => item.id).join(' ')}`)
    out.push(`- tasks: ${entry.tasks.map((task) => `${task.id}(${task.st})`).join(' ') || '-'}`)
  }
  // The inbox is the coordination branch's as it is now, never part of the source commit: its
  // header names where it was read (and how many lines came from the source's own STATE).
  const from = brief.source.inbox
  if (brief.inbox.length) out.push('', `## inbox${from ? ` · ${from.branch}@${short(from.commit)}${from.state ? ` + STATE ${from.state}` : ''}${brief.source.kind === 'commit' ? ' (current, not as of the source commit)' : ''}` : ''}`, ...brief.inbox)
  // Session fields of a single-task vibe brief or a work brief: what to run and from where.
  if (brief.verify || brief.diffBase) {
    out.push('', '## verify')
    if (brief.diffBase) out.push(`- diff-base: ${brief.diffBase}`)
    const shown = brief.decisions.map((entry) => entry.text).join('\n')
    for (const [tier, value] of Object.entries(brief.verify ?? {})) {
      if (!Array.isArray(value) || !value.length) continue
      if (tier === 'guidance') for (const line of value.filter((item) => !shown.includes(item.trim()))) out.push(`- guidance: ${line.trim().replace(/^- /, '')}`)
      else out.push(`- ${tier}: ${value.map((command) => `\`${command}\``).join(' ')}`)
    }
  }
  const body = out.join('\n')
  return `${body}\n\nend ${label} sha256:${short(sha256(body))} chars:${body.length}\n`
}
