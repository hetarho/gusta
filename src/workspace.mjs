import { execFile } from 'node:child_process'
import { access, realpath } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const gitEnv = () => ({ ...process.env, LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' })
const SHOW_LIMIT = 4 * 1024 * 1024

export async function git(cwd, args, allowedCodes = []) {
  try {
    const { stdout } = await execute('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: SHOW_LIMIT, env: gitEnv() })
    return stdout
  } catch (error) {
    if (allowedCodes.includes(error.code)) return null
    throw error
  }
}

// Git with `input` on stdin; stdout as bytes, since object sizes are byte counts.
export function gitInput(cwd, args, input) {
  return new Promise((resolve, reject) => {
    const child = execFile('git', ['-C', cwd, ...args], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, env: gitEnv() },
      (error, stdout) => error ? reject(error) : resolve(stdout))
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })
}

// `git cat-file --batch` output for `count` requests, in order: { type, size, content } for an
// object, null for "<name> missing", undefined for any other answer (ambiguous, unparsable).
export function parseBatch(output, count) {
  const entries = []
  let offset = 0
  for (let index = 0; index < count; index += 1) {
    const end = output.indexOf(10, offset)
    if (end < 0) { entries.push(undefined); continue }
    const header = output.toString('utf8', offset, end)
    offset = end + 1
    const found = header.match(/^[0-9a-f]{40,64} (\S+) (\d+)$/)
    if (!found) { entries.push(header.endsWith(' missing') ? null : undefined); continue }
    const size = Number(found[2])
    entries.push({ type: found[1], size, content: output.toString('utf8', offset, offset + size) })
    offset += size + 1
  }
  return entries
}

// What `git show <spec>` (exit 128 → null) prints, for many specs in one `git cat-file --batch`.
// Only answers show would give byte for byte are taken: a blob within show's output limit, or a
// missing object. Everything else (a tree, a spec that does not fit on one line, a failed batch)
// stays undefined, for the caller to show on its own exactly as before.
export async function batchShow(cwd, specs, batch = gitInput) {
  const answers = new Array(specs.length).fill(undefined)
  const queued = specs.flatMap((spec, index) => /[\r\n]/.test(spec) ? [] : [index])
  if (!queued.length) return answers
  const output = await batch(cwd, ['cat-file', '--batch'], queued.map((index) => `${specs[index]}\n`).join('')).catch(() => null)
  if (!output) return answers
  for (const [position, entry] of parseBatch(output, queued.length).entries()) {
    if (entry === null) answers[queued[position]] = null
    else if (entry?.type === 'blob' && entry.size <= SHOW_LIMIT) answers[queued[position]] = entry.content
  }
  return answers
}

const PSEUDO_REFS = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']
const REBASE_DIRS = ['rebase-merge', 'rebase-apply']

async function exists(file) {
  try { await access(file); return true } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

// The Git operation in progress in root's worktree, checked in this order: MERGE_HEAD,
// CHERRY_PICK_HEAD, REVERT_HEAD (a ref that resolves) or rebase-merge, rebase-apply (a directory
// that exists); null when none. Two processes, not five: cat-file --batch-check resolves the refs
// as rev-parse --verify does, and one rev-parse prints every --git-path. cat-file also calls a ref
// to a lost object missing, so a missing ref whose file exists is verified on its own as before;
// any other answer takes the one-call-per-marker path.
export async function gitOperation(root, { run = git, batch = gitInput, present = exists } = {}) {
  const one = async () => {
    for (const name of PSEUDO_REFS) if (await run(root, ['rev-parse', '--verify', '--quiet', name], [1])) return name
    for (const name of REBASE_DIRS) if (await present(path.resolve(root, (await run(root, ['rev-parse', '--git-path', name])).replace(/\r?\n$/, '')))) return name
    return null
  }
  let listed, checked
  try {
    [listed, checked] = await Promise.all([
      run(root, ['rev-parse', ...[...PSEUDO_REFS, ...REBASE_DIRS].flatMap((name) => ['--git-path', name])]),
      batch(root, ['cat-file', '--batch-check'], PSEUDO_REFS.map((name) => `${name}\n`).join('')),
    ])
  } catch { return one() }
  const paths = listed.split('\n').map((line) => line.replace(/\r$/, ''))
  const refs = checked.toString('utf8').split('\n')
  if (paths.length !== 6 || paths[5] !== '' || refs.length !== 4 || refs[3] !== '') return one()
  for (const [index, name] of PSEUDO_REFS.entries()) {
    if (/^[0-9a-f]{40,64} /.test(refs[index])) return name
    if (refs[index] !== `${name} missing`) return one()
    const file = await present(path.resolve(root, paths[index])).catch(() => true)
    if (file && await run(root, ['rev-parse', '--verify', '--quiet', name], [1])) return name
  }
  for (const [offset, name] of REBASE_DIRS.entries()) if (await present(path.resolve(root, paths[PSEUDO_REFS.length + offset]))) return name
  return null
}

export async function showMany(cwd, specs, { batch = gitInput, show = (spec) => git(cwd, ['show', spec], [128]) } = {}) {
  const answers = await batchShow(cwd, specs, batch)
  return Promise.all(answers.map((answer, index) => answer === undefined ? show(specs[index]) : answer))
}

function parseWorktrees(output) {
  return output.split('\0\0').filter(Boolean).map((record) => {
    const fields = new Map(record.split('\0').filter(Boolean).map((field) => {
      const split = field.indexOf(' ')
      return split < 0 ? [field, true] : [field.slice(0, split), field.slice(split + 1)]
    }))
    const head = fields.get('HEAD')
    return {
      path: fields.get('worktree'),
      head: head && !/^0+$/.test(head) ? head : null,
      branch: fields.get('branch')?.replace(/^refs\/heads\//, '') ?? null,
      detached: fields.has('detached'),
      bare: fields.has('bare'),
      locked: fields.get('locked') ?? false,
      prunable: fields.get('prunable') ?? false,
    }
  })
}

// Discovery only: neither branch names nor environment-specific hints grant ownership.
export async function inspectWorkspace({ targetRoot } = {}) {
  const target = await realpath(path.resolve(targetRoot ?? process.cwd()))
  let inside
  try {
    inside = await git(target, ['rev-parse', '--is-inside-work-tree'])
  } catch (error) {
    if (error.code === 'ENOENT' || /not a git repository/.test(error.stderr ?? '')) {
      return {
        schemaVersion: 1, targetRoot: target, git: null,
        warnings: [error.code === 'ENOENT' ? 'Git을 찾을 수 없습니다.' : 'Git 저장소가 아닙니다.'],
      }
    }
    throw error
  }
  if (inside.trim() !== 'true') {
    return { schemaVersion: 1, targetRoot: target, git: null, warnings: ['작업 checkout이 아닙니다 (bare 저장소 또는 Git 메타데이터 경로).'] }
  }
  const [root, gitDir, commonDir, branch, head, worktrees] = await Promise.all([
    git(target, ['rev-parse', '--show-toplevel']),
    git(target, ['rev-parse', '--absolute-git-dir']),
    git(target, ['rev-parse', '--git-common-dir']),
    git(target, ['symbolic-ref', '--quiet', '--short', 'HEAD'], [1]),
    git(target, ['rev-parse', '--verify', '--quiet', 'HEAD'], [1]),
    git(target, ['worktree', 'list', '--porcelain', '-z']),
  ])
  // Remove the output delimiter only; whitespace may be part of a valid path.
  const line = (value) => value?.replace(/\r?\n$/, '') ?? null
  const common = await realpath(path.resolve(target, line(commonDir)))
  const directory = await realpath(line(gitDir))
  return {
    schemaVersion: 1,
    targetRoot: target,
    git: {
      root: await realpath(line(root)), gitDir: directory, commonDir: common,
      isLinkedWorktree: directory !== common,
      branch: line(branch), head: line(head), detached: branch === null,
      worktrees: parseWorktrees(worktrees),
    },
    warnings: [],
  }
}
