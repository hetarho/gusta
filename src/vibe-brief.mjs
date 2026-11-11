import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { inspectWorkspace, git } from './workspace.mjs'
import { readTaskBoard } from './task-board.mjs'
import { sections, TASK_ID } from './spec-format.mjs'
import { assembleBrief, specSource } from './spec-context.mjs'
import { SkillPackageError } from './errors.mjs'

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
  const brief = await assembleBrief({ source, roots, deep: Boolean(options.deep) })
  const single = roots.length === 1 && TASK_ID.test(roots[0]) ? roots[0] : null
  if (!single) return brief
  const board = await readTaskBoard({ targetRoot: source.root, ...(source.commit ? { ref: source.commit } : {}) })
  const task = board.tasks.find((entry) => entry.id === single) ?? null
  if (!task && !brief.tasks.length) throw new SkillPackageError(`태스크를 찾을 수 없습니다: ${single}`)
  const workspace = await inspectWorkspace({ targetRoot: source.root })
  const current = workspace.git?.head ?? null
  let diffBase = null
  if (source.kind === 'worktree') {
    const startFile = path.join(workspace.git.gitDir, 'haeram-task-start.json')
    const saved = await readFile(startFile, 'utf8').then(JSON.parse).catch(() => null)
    diffBase = options.diffBase ?? process.env.HAERAM_DIFF_BASE ?? (saved?.task === single ? saved.diffBase : current)
    if (diffBase) await git(source.root, ['rev-parse', '--verify', `${diffBase}^{commit}`])
    await writeFile(startFile, JSON.stringify({ task: single, diffBase }))
  }
  const revs = new Map(brief.domains.map((domain) => [domain.id, domain.rev]))
  const base = task?.base ?? []
  return { schemaVersion: 1, taskId: single, commit: source.head, diffBase, task,
    decisions: brief.decisions,
    freshness: base.map((entry) => { const [domain, rev] = entry.split('@'); return { domain, base: Number(rev), current: revs.get(domain) ?? null, stale: Number(rev) !== revs.get(domain) } }),
    verify: await readVerification(source.root, (await source.read('spec/ssot/ARCH.md')) ?? ''), touches: task?.touches ?? [],
    reading: 'This brief is the reading scope: whole decision blocks the task cites or needs, global rules, flow·constraints and changes since a stale base. Do not re-read STATE, FORMAT or ARCH in full. Open an original only for what issues, unfollowed or related name and the task needs.',
    ...brief }
}

export async function vibeFormat(options = {}) {
  const markdown = await readFile(new URL('../skills/create-architecture/assets/FORMAT.md', import.meta.url), 'utf8')
  const names = { task: ['Notation', 'Skeletons (section order fixed; only (opt) may be omitted; no sections beyond the skeleton)', 'State rules'], state: ['State rules', 'Sessions'], ssot: ['Principles', 'Notation'], report: ['Sessions'], reading: ['Reading'], settings: ['Settings'] }
  const requested = names[options.section] ?? [options.section]
  const map = sections(markdown)
  if (!requested.every((name) => map.has(name))) throw new SkillPackageError(`알 수 없는 FORMAT section: ${options.section}`)
  const entries = requested.map((name) => {
    let lines = map.get(name)
    if (['task', 'state', 'report', 'ssot'].includes(options.section)) {
      const topic = { task: /task|acceptance|result|touches|base:|st:|dep:|\[v\]/i, state: /STATE|active|inbox|log|push|report/i, report: /report|autopilot|loop/i, ssot: /decision|SSOT|\[o\]|\[x\]|\[\?\]|rev|chg/i }[options.section]
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
