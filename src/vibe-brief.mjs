import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { inspectWorkspace, git } from './workspace.mjs'
import { readTaskBoard } from './task-board.mjs'
import { sections, TASK_ID } from './spec-format.mjs'
import { assembleBrief, specSource } from './spec-context.mjs'
import { vibeSession } from './vibe-session.mjs'
import { coordView } from './vibe-coord.mjs'
import { SkillPackageError } from './errors.mjs'

// The owner's inbox for a brief: the coordination branch as the clone at `targetRoot` has it now
// (nothing is fetched, nothing is written), with the commit it was read at. null where there is no
// coordination branch to read (no Git checkout): the brief then has only its source's STATE.
// Only SESSIONS' own lines: a `## inbox` still in STATE is read by the brief from its one source.
export async function briefInbox(targetRoot, injected = {}) {
  const session = await vibeSession({ targetRoot }, { unborn: true }).catch((error) => { if (error instanceof SkillPackageError) return null; throw error })
  if (!session) return null
  const view = await coordView(session, { fetch: false, injected })
  return { branch: view.branch, commit: view.commit, inbox: view.sessions.inbox, ...(view.error ? { error: view.error } : {}) }
}

// Extract only explicitly labelled tiers. Conditional prose remains guidance, never
// a shell command. Conditional browser invocations may still need specific paths.
export function verificationTiers(markdown) {
  const result = { task: [], batch: [], ci: [], guidance: [], declared: false }
  let tier = null, relevant = false
  const labels = new Set()
  for (const line of sections(markdown).get('decisions') ?? []) {
    if (/^- /.test(line)) { tier = null; relevant = /\b(verification|verify|checks|testing|tests|CI\/CD)\b|검증/i.test(line) && /\[o\]/.test(line) }
    if (!relevant) continue
    if (/\[x\]/.test(line)) continue
    const label = line.match(/^\s*-\s*(task|batch|CI|태스크|묶음|push 전)(?=[,:\s])/i)
    if (label) {
      tier = /^(task|태스크)$/i.test(label[1]) ? 'task' : /^(ci)$/i.test(label[1]) ? 'ci' : 'batch'
      labels.add(tier)
      const colon = line.indexOf(':', label[0].length)
      if (colon >= 0 && tier !== 'ci') {
        for (const match of line.slice(colon + 1).matchAll(/`([^`]+)`/g)) result[tier].push(match[1])
      }
      if (tier === 'ci') result.guidance.push(line)
    } else if (tier && /^\s+-\s+`[^`]+`[.,]?\s*$/.test(line)) {
      result[tier].push(line.match(/`([^`]+)`/)[1])
    } else if (line.trim()) {
      result.guidance.push(line)
    }
  }
  result.declared = ['task', 'batch', 'ci'].every((tier) => labels.has(tier))
  result.partial = labels.size > 0 && !result.declared
  for (const name of ['task', 'batch', 'ci']) result[name] = [...new Set(result[name])]
  return result
}

// archText lets a brief read ARCH from the same source (commit or working tree) as its policy.
export async function readVerification(root, archText) {
  const arch = archText ?? await readFile(path.join(root, 'spec/ssot/ARCH.md'), 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return ''
    throw error
  })
  const verify = verificationTiers(arch)
  // Legacy ARCH: infer only familiar fast checks; never default a task to verify.
  if (!verify.declared) {
    let scripts = {}, manager = 'npm run'
    try {
      const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
      scripts = pkg.scripts ?? {}
      if (pkg.packageManager?.startsWith('pnpm')) manager = 'pnpm run'
      if (pkg.packageManager?.startsWith('yarn')) manager = 'yarn'
    } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (!verify.batch.length) verify.batch = scripts.verify ? [`${manager} verify`] : scripts.test ? [`${manager} test`] : []
    if (!verify.task.length) verify.task = ['typecheck', 'lint', 'format:check'].filter((name) => scripts[name]).map((name) => `${manager} ${name}`)
    // Legacy commands belong to the batch gate and are selected explicitly by
    // the caller, rather than treating prose/code examples as executable config.
    verify.guidance.push('No explicit tiers: task = changed/affected unit tests plus fast checks; batch = full suite, integration and e2e once before a target-branch code push or final completion; CI = once per code push. Classify tests by their isolation and dependencies, not their script names. Select legacy ARCH batch commands explicitly with --verify.')
  }
  return verify
}

// The standalone brief: the shared assembler over the working tree (or --ref <commit>), plus the
// session fields a single task needs — the task-start diff base, freshness, verification tiers.
export async function vibeBrief(options = {}) {
  const roots = options.roots ?? (options.task ? [options.task] : [])
  const source = await specSource({ targetRoot: options.targetRoot, ref: options.ref })
  // Rules and tasks come from the one source (the working tree, or --ref's commit). The inbox is
  // the coordination branch's as it is now, with either source — it has no past to read at --ref —
  // and the brief says so (source.inbox, the `## inbox` header).
  // options.coordination: a caller that just read the branch (the loop host) hands its read over.
  const brief = await assembleBrief({ source, roots, deep: Boolean(options.deep), coordination: options.coordination ?? await briefInbox(source.root) })
  const view = options.summary || options.section
  if (!view && (options.offset !== undefined || options.limit !== undefined || options.snapshot !== undefined)) throw new SkillPackageError('--offset·--limit·--snapshot은 --summary 또는 --section과 함께 사용하세요.')
  const single = roots.length === 1 && TASK_ID.test(roots[0]) ? roots[0] : null
  if (!single) return view ? briefView(brief, options) : brief
  const board = await readTaskBoard({ targetRoot: source.root, ...(source.commit ? { ref: source.commit } : {}) })
  const task = board.tasks.find((entry) => entry.id === single) ?? null
  if (!task && !brief.tasks.length) throw new SkillPackageError(`태스크를 찾을 수 없습니다: ${single}`)
  const workspace = await inspectWorkspace({ targetRoot: source.root })
  const current = workspace.git?.head ?? null
  let diffBase = null
  if (source.kind === 'worktree') {
    const startFile = path.join(workspace.git.gitDir, 'gusta-task-start.json')
    const saved = await readFile(startFile, 'utf8').then(JSON.parse).catch(() => null)
    diffBase = options.diffBase ?? process.env.GUSTA_DIFF_BASE ?? (saved?.task === single ? saved.diffBase : current)
    if (diffBase) await git(source.root, ['rev-parse', '--verify', `${diffBase}^{commit}`])
    await writeFile(startFile, JSON.stringify({ task: single, diffBase }))
  }
  const revs = new Map(brief.domains.map((domain) => [domain.id, domain.rev]))
  const base = task?.base ?? []
  const result = { schemaVersion: 1, taskId: single, commit: source.head, diffBase, task,
    decisions: brief.decisions,
    freshness: base.map((entry) => { const [domain, rev] = entry.split('@'); return { domain, base: Number(rev), current: revs.get(domain) ?? null, stale: Number(rev) !== revs.get(domain) } }),
    verify: await readVerification(source.root, (await source.read('spec/ssot/ARCH.md')) ?? ''), touches: task?.touches ?? [],
    reading: 'This brief is the reading scope: whole decision blocks the task cites or needs, global rules, flow·constraints and changes since a stale base. Do not re-read STATE, FORMAT or ARCH in full. Open an original only for what issues, unfollowed or related name and the task needs.',
    ...brief }
  return view ? briefView(result, options) : result
}

// Discovery and paging are explicit views of the same assembled closure. Pages contain
// whole blocks; their end marker never pretends that a partial reading is complete.
function briefView(brief, options) {
  const collections = { tasks: brief.tasks, decisions: brief.decisions, sections: brief.sections, history: brief.history,
    refs: Object.entries(brief.refs).flatMap(([kind, entries]) => entries.map((entry) => ({ kind, ...entry }))),
    referrers: brief.referrers, inbox: brief.inbox, issues: brief.issues, guidance: brief.verify?.guidance ?? [] }
  const section = options.section ?? 'decisions'
  if (!Object.hasOwn(collections, section)) throw new SkillPackageError(`brief --section: ${Object.keys(collections).join('|')}`)
  const offset = Number(options.offset ?? 0), limit = Number(options.limit ?? 20)
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new SkillPackageError('--offset은 0 이상 정수, --limit은 1-100 정수입니다.')
  const snapshot = createHash('sha256').update(JSON.stringify(brief)).digest('hex')
  if (options.snapshot && options.snapshot !== snapshot) throw new SkillPackageError('brief 원본이 변경됐습니다. --summary로 새 snapshot과 읽기 범위를 확인하세요.')
  const entries = collections[section].slice(offset, offset + limit)
  const describe = (entry) => typeof entry === 'string' ? { chars: entry.length } : {
    ...Object.fromEntries(['id', 'domain', 'name', 'file', 'path', 'sha256', 'kind', 'level', 'code'].filter((key) => entry[key] !== undefined).map((key) => [key, entry[key]])),
    chars: (entry.text ?? entry.content ?? entry.message ?? entry.lines?.join('\n') ?? '').length }
  return { schemaVersion: 1, view: options.summary ? 'summary' : 'page', roots: brief.roots, source: brief.source, snapshot,
    ...(brief.taskId ? { taskId: brief.taskId, commit: brief.commit, diffBase: brief.diffBase, freshness: brief.freshness, touches: brief.touches,
      verify: { task: brief.verify.task, batch: brief.verify.batch, ci: brief.verify.ci, declared: brief.verify.declared, partial: brief.verify.partial, guidanceCount: brief.verify.guidance.length, guidanceSection: 'guidance' } } : {}),
    complete: false, readingComplete: false, sourceComplete: brief.complete, scope: brief.scope, size: brief.size,
    counts: Object.fromEntries(Object.entries(collections).map(([name, list]) => [name, list.length])),
    page: { section, offset, limit, total: collections[section].length, returned: entries.length,
      remaining: Math.max(0, collections[section].length - offset - entries.length), nextOffset: offset + entries.length < collections[section].length ? offset + entries.length : null },
    entries: options.summary ? entries.map(describe) : entries,
    reading: 'Discovery or partial page only. Read all required whole blocks and supporting sections (including global rules, flow, constraints, history, issues and verification guidance) from this snapshot before implementation. No context was removed from the full brief.',
    next: `vibe brief ${brief.roots.join(' ')} --section <section> --offset <n> --limit ${limit} --snapshot ${snapshot}${brief.source.commit ? ` --ref ${brief.source.commit}` : ''}; omit view flags for the complete brief.` }
}

export function renderBriefView(view) {
  return `# BRIEF ${view.roots.join(' ')}\n> view:${view.view} | readingComplete:no | sourceComplete:${view.sourceComplete ? 'yes' : 'no'}\n\n\`\`\`json\n${JSON.stringify(view, null, 2)}\n\`\`\`\n\nend ${view.roots.join(' ')} view:${view.view} readingComplete:no snapshot:${view.snapshot}\n`
}

export async function vibeFormat(options = {}) {
  const markdown = await readFile(new URL('../skills/gusta-create-architecture/assets/FORMAT.md', import.meta.url), 'utf8')
  const names = { task: ['Notation', 'Skeletons (section order fixed; only (opt) may be omitted; no sections beyond the skeleton)', 'State rules'], state: ['State rules', 'Sessions'], ssot: ['Principles', 'Notation'], report: ['Sessions'], ideation: ['Notation', 'Skeletons (section order fixed; only (opt) may be omitted; no sections beyond the skeleton)', 'Reading', 'State rules'], reading: ['Reading'], settings: ['Settings'] }
  const requested = names[options.section] ?? [options.section]
  const map = sections(markdown)
  if (!requested.every((name) => map.has(name))) throw new SkillPackageError(`알 수 없는 FORMAT section: ${options.section}`)
  const entries = requested.map((name) => {
    let lines = map.get(name)
    if (['task', 'state', 'report', 'ssot', 'ideation'].includes(options.section)) {
      const topic = { task: /task|acceptance|result|touches|base:|st:|dep:|\[v\]/i, state: /STATE|active|inbox|log|push|report/i, report: /report|autopilot|loop/i, ssot: /decision|SSOT|\[o\]|\[x\]|\[\?\]|rev|chg/i, ideation: /ideation|IDEATION|flow/i }[options.section]
      const selected = []
      let keep = false
      for (const line of lines) {
        if (/^\S/.test(line)) keep = topic.test(line)
        if (keep) selected.push(line)
      }
      lines = selected
    }
    return { name, text: lines.join('\n').trim() }
  })
  return { schemaVersion: 1, section: options.section, sections: entries }
}
