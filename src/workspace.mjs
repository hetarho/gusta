import { execFile } from 'node:child_process'
import { access, readFile, realpath } from 'node:fs/promises'
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

async function readText(file) {
  try { return await readFile(file, 'utf8') } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

// The refs a pseudo-ref name abbreviates besides itself, in rev-parse's lookup order.
const abbreviated = (name) => [`refs/${name}`, `refs/tags/${name}`, `refs/heads/${name}`, `refs/remotes/${name}`, `refs/remotes/${name}/HEAD`]

// Whether packed-refs text has a "<oid> <ref>" line for ref: " <ref>" ending its line (LF, CRLF
// or the end of the file). Refnames hold no spaces, so the space marks where the name starts.
function packedRef(text, ref) {
  const needle = ` ${ref}`
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) {
    const end = at + needle.length
    if (end === text.length || text[end] === '\n' || (text[end] === '\r' && (end + 1 === text.length || text[end + 1] === '\n'))) return true
  }
  return false
}

// cat-file calls a name missing both when nothing resolves it and when a ref resolves it to a lost
// object, where rev-parse --verify still succeeds. Only an absent ref settles it without asking:
// no pseudo-ref file, no loose or packed ref the name abbreviates, and the files backend (no
// reftable). Anything that cannot be ruled out, or read, is undecided. One checker serves one
// gitOperation call: reftable is looked up and packed-refs read at most once, and only when a
// missing marker gets that far.
function refChecker(common, { present, read }) {
  const maybe = (target) => present(target).catch(() => true)
  let reftable, packed
  return async (name, file) => {
    if (await maybe(file) || await (reftable ??= maybe(path.join(common, 'reftable')))) return true
    for (const ref of abbreviated(name)) if (await maybe(path.join(common, ref))) return true
    const text = await (packed ??= read(path.join(common, 'packed-refs')).then((value) => value ?? '', () => null))
    return text === null || abbreviated(name).some((ref) => packedRef(text, ref))
  }
}

// The Git operation in progress in root's worktree, checked in this order: MERGE_HEAD,
// CHERRY_PICK_HEAD, REVERT_HEAD (a ref that resolves) or rebase-merge, rebase-apply (a directory
// that exists); null when none. Usually two processes, not five: cat-file --batch-check resolves
// the refs as rev-parse --verify does, and one rev-parse prints the common dir and every
// --git-path. A missing ref that a lost object could explain is verified on its own as before
// (undecided above); any other answer takes the one-call-per-marker path.
export async function gitOperation(root, { run = git, batch = gitInput, present = exists, read = readText } = {}) {
  const one = async () => {
    for (const name of PSEUDO_REFS) if (await run(root, ['rev-parse', '--verify', '--quiet', name], [1])) return name
    for (const name of REBASE_DIRS) if (await present(path.resolve(root, (await run(root, ['rev-parse', '--git-path', name])).replace(/\r?\n$/, '')))) return name
    return null
  }
  let listed, checked
  try {
    [listed, checked] = await Promise.all([
      run(root, ['rev-parse', '--git-common-dir', ...[...PSEUDO_REFS, ...REBASE_DIRS].flatMap((name) => ['--git-path', name])]),
      batch(root, ['cat-file', '--batch-check'], PSEUDO_REFS.map((name) => `${name}\n`).join('')),
    ])
  } catch { return one() }
  const [common, ...paths] = listed.split('\n').map((line) => path.resolve(root, line.replace(/\r$/, '')))
  const refs = checked.toString('utf8').split('\n')
  if (paths.length !== 6 || !listed.endsWith('\n') || refs.length !== 4 || refs[3] !== '') return one()
  const undecided = refChecker(common, { present, read })
  for (const [index, name] of PSEUDO_REFS.entries()) {
    if (/^[0-9a-f]{40,64} /.test(refs[index])) return name
    if (refs[index] !== `${name} missing`) return one()
    if (await undecided(name, paths[index]) && await run(root, ['rev-parse', '--verify', '--quiet', name], [1])) return name
  }
  for (const [offset, name] of REBASE_DIRS.entries()) if (await present(paths[PSEUDO_REFS.length + offset])) return name
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

// rev-parse's answers for a work tree with a commit, one per line, from a single call. Anything
// else (no commit yet, not a work tree, a path with a line break) is null and asked one by one.
function parseAnswers(output) {
  const lines = output.split('\n').map((value) => value.replace(/\r$/, ''))
  if (lines.length !== 6 || lines[5] !== '' || lines[0] !== 'true' || !/^[0-9a-f]{40,64}$/.test(lines[4])) return null
  const [, root, gitDir, commonDir, head] = lines
  return { root, gitDir, commonDir, head }
}

// Discovery only: neither branch names nor environment-specific hints grant ownership.
// Three git calls in one round for a work tree with a commit; any other checkout is inspected
// one question at a time, as before.
export async function inspectWorkspace({ targetRoot } = {}, run = git) {
  const target = await realpath(path.resolve(targetRoot ?? process.cwd()))
  const settled = (promise) => { promise.catch(() => {}); return promise }
  const answers = run(target, ['rev-parse', '--is-inside-work-tree', '--show-toplevel', '--absolute-git-dir', '--git-common-dir', 'HEAD']).then(parseAnswers, () => null)
  const branch = settled(run(target, ['symbolic-ref', '--quiet', '--short', 'HEAD'], [1]))
  const worktrees = settled(run(target, ['worktree', 'list', '--porcelain', '-z']))
  const known = await answers
  if (!known) return inspectEach(target, run)
  return describe(target, { ...known, branch: await branch, worktrees: await worktrees })
}

async function inspectEach(target, run) {
  let inside
  try {
    inside = await run(target, ['rev-parse', '--is-inside-work-tree'])
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
    run(target, ['rev-parse', '--show-toplevel']),
    run(target, ['rev-parse', '--absolute-git-dir']),
    run(target, ['rev-parse', '--git-common-dir']),
    run(target, ['symbolic-ref', '--quiet', '--short', 'HEAD'], [1]),
    run(target, ['rev-parse', '--verify', '--quiet', 'HEAD'], [1]),
    run(target, ['worktree', 'list', '--porcelain', '-z']),
  ])
  return describe(target, { root, gitDir, commonDir, branch, head, worktrees })
}

async function describe(target, { root, gitDir, commonDir, branch, head, worktrees }) {
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
