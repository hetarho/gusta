import { lstat, readFile, readlink, realpath, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { committedBlob, committedInputs, ignoredInput, workingInputs } from './check-cache.mjs'
import { SkillPackageError } from './errors.mjs'

const digest = (value) => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : stable(value)).digest('hex')
const stable = (value) => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).filter(([, entry]) => entry !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item)
const fail = (message) => { throw new SkillPackageError(`invalid verification plan: ${message}`) }
const object = (value) => value && typeof value === 'object' && !Array.isArray(value)
const allowedKeys = (value, keys, label) => {
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail(`${label} has unknown field ${key}`)
}
const outside = (root, filename) => {
  const relative = path.relative(root, filename)
  return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
}
const controlPath = (filename) => filename.split(/[\\/]/).some((part) => part.toLowerCase() === '.git')

function inputPath(value, label) {
  if (typeof value !== 'string' || !value.trim() || /[\u0000\r\n\\]/.test(value)
    || path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || value.startsWith(':')
    || value.split('/').includes('..') || controlPath(value)) fail(`${label} must be a root-relative Git pathspec without exclusions or parent traversal`)
  return value
}

// Deliberately explicit: shell wrappers are never split or inferred into child checks.
export function parseVerificationPlan(value, { source = null } = {}) {
  let raw = value
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw) } catch (error) { fail(`cannot parse JSON (${error.message})`) }
  }
  if (!object(raw)) fail('expected an object')
  allowedKeys(raw, ['schemaVersion', 'checks'], 'plan')
  if (raw.schemaVersion !== 1) fail('schemaVersion must be 1')
  if (!Array.isArray(raw.checks) || !raw.checks.length) fail('checks must be a nonempty array')
  const ids = new Set()
  const checks = raw.checks.map((check, index) => {
    const label = `checks[${index}]`
    if (!object(check)) fail(`${label} must be an object`)
    allowedKeys(check, ['id', 'tier', 'command', 'inputs'], label)
    if (typeof check.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(check.id)) fail(`${label}.id must be a stable identifier`)
    if (ids.has(check.id)) fail(`duplicate check id ${check.id}`)
    ids.add(check.id)
    if (!['task', 'batch', 'ci'].includes(check.tier)) fail(`${label}.tier must be task, batch or ci`)
    if (typeof check.command !== 'string' || !check.command.trim() || check.command.includes('\u0000')) fail(`${label}.command must be a nonempty shell command`)
    const inputs = check.inputs === undefined ? ['.'] : check.inputs
    if (!Array.isArray(inputs) || !inputs.length) fail(`${label}.inputs must be a nonempty array`)
    return { id: check.id, tier: check.tier, command: check.command.trim(), inputs: [...new Set(inputs.map((input) => inputPath(input, `${label}.inputs`)))].sort() }
  })
  return { schemaVersion: 1, source, checks }
}

export async function readVerificationPlan(root, file, deps = {}) {
  if (typeof file !== 'string' || !file.trim() || file.includes('\u0000')) fail('plan path is required')
  try {
    const resolve = deps.realpath ?? realpath, read = deps.readFile ?? readFile
    const base = await resolve(root), original = path.resolve(root)
    let requested = path.resolve(base, file)
    if (path.isAbsolute(file) && !outside(original, file)) requested = path.resolve(base, path.relative(original, file))
    if (outside(base, requested) || controlPath(path.relative(base, requested))) fail('plan path must stay inside the project and outside Git control directories')
    if (deps.readSource) {
      const source = path.relative(base, requested).split(path.sep).join('/'), contents = await deps.readSource(source)
      if (contents === null || contents === undefined) fail(`plan source ${source} is missing from the selected revision`)
      return parseVerificationPlan(contents, { source })
    }
    const filename = await resolve(requested)
    if (outside(base, filename) || controlPath(path.relative(base, filename))) fail('plan path must stay inside the project and outside Git control directories')
    return parseVerificationPlan(await read(filename, 'utf8'), { source: path.relative(base, filename).split(path.sep).join('/') })
  } catch (error) {
    if (error instanceof SkillPackageError) throw error
    fail(`cannot read plan ${file} (${error.code ?? 'read failed'})`)
  }
}

// Git stores the symlink text. Include an internal file's referent too: a check may
// follow the link even when its target is outside the declared pathspec. Unsupported
// external/directory links fail instead of returning an unsound reusable pass.
async function linkInputs(root, files, deps) {
  const links = [], resolve = deps.realpath ?? realpath, inspect = deps.stat ?? stat, read = deps.readFile ?? readFile
  for (const file of files) {
    if (file.mode === '160000') fail(`submodule input ${file.path} cannot be fingerprinted as a file`)
    if (file.mode !== '120000') continue
    let target
    try { target = await resolve(path.join(root, file.path)) } catch (error) {
      if (error.code !== 'ENOENT') throw error
      links.push({ path: file.path, missing: true })
      continue
    }
    if (outside(root, target) || controlPath(path.relative(root, target))) fail(`symlink input ${file.path} escapes the project input boundary`)
    const info = await inspect(target)
    if (!info.isFile()) fail(`directory symlink input ${file.path} is unsupported; declare concrete project inputs`)
    links.push({ path: file.path, target: path.relative(root, target), mode: info.mode & 0o777, hash: digest(await read(target)) })
  }
  return links
}

async function literalInputs(root, inputs, deps) {
  const literals = [], resolve = deps.realpath ?? realpath, inspect = deps.stat ?? stat,
    inspectLink = deps.lstat ?? lstat, read = deps.readFile ?? readFile, link = deps.readlink ?? readlink
  for (const input of inputs) {
    const wildcard = input.search(/[*?\[]/), literal = wildcard < 0
    if (path.posix.normalize(input) === '.') continue
    // Git does not follow directory symlinks in pathspecs. Reject a symbolic
    // prefix instead of silently treating a real input as an empty file set.
    const prefix = literal ? input : input.slice(0, wildcard).replace(/[^/]*$/, '')
    if (!prefix) continue
    const filename = path.resolve(root, prefix.replace(/\/$/, ''))
    let target
    try { target = await resolve(filename) } catch (error) {
      if (error.code !== 'ENOENT') throw error
      if (literal) {
        const info = await inspectLink(filename).catch((failure) => failure.code === 'ENOENT' ? null : Promise.reject(failure))
        literals.push({ path: input, missing: true, ...(info?.isSymbolicLink() ? { link: await link(filename) } : {}) })
      }
      continue
    }
    if (outside(root, target) || controlPath(path.relative(root, target))) fail(`input ${input} escapes the project input boundary`)
    const info = await inspect(target)
    if (info.isDirectory()) {
      if (filename !== target) fail(`directory symlink input ${input} is unsupported; declare concrete project inputs`)
      if (literal) {
        if (await (deps.ignoredInput ?? ignoredInput)(root, input)) fail(`ignored directory input ${input} is unsupported; declare concrete input files`)
        literals.push({ path: input, directory: true, mode: info.mode & 0o777 })
      }
    } else if (literal) {
      if (!info.isFile()) fail(`input ${input} must be a regular file or project directory`)
      literals.push({ path: input, target: path.relative(root, target), mode: info.mode & 0o777, hash: digest(await read(target)) })
    }
  }
  return literals
}

async function revisionInputs(root, ref, inputs, deps) {
  const snapshot = await (deps.committedInputs ?? committedInputs)(root, ref, inputs)
  const files = new Map(snapshot.all.map((entry) => [entry.path, entry])), directories = new Set(['']), blobs = new Map()
  for (const file of snapshot.all) {
    let directory = path.posix.dirname(file.path)
    while (directory !== '.') { directories.add(directory); directory = path.posix.dirname(directory) }
  }
  const missing = () => Object.assign(new Error('missing committed verification input'), { code: 'ENOENT' })
  const relative = (filename) => {
    if (outside(root, filename) || controlPath(path.relative(root, filename))) fail('committed input escapes the project input boundary')
    return path.relative(root, filename).split(path.sep).join('/')
  }
  const blob = async (entry) => {
    if (!blobs.has(entry.hash)) blobs.set(entry.hash, (deps.committedBlob ?? committedBlob)(root, entry.hash))
    return blobs.get(entry.hash)
  }
  const resolve = async (filename, depth = 0) => {
    if (depth > 40) fail('committed input has a symbolic-link cycle')
    const parts = relative(filename).split('/').filter(Boolean)
    for (let index = 0; index < parts.length; index++) {
      const name = parts.slice(0, index + 1).join('/'), entry = files.get(name)
      if (entry?.mode === '120000') {
        const target = (await blob(entry)).toString('utf8')
        return resolve(path.resolve(root, path.posix.dirname(name), target, ...parts.slice(index + 1)), depth + 1)
      }
      if (!entry && !directories.has(name)) throw missing()
      if (entry && index !== parts.length - 1) throw Object.assign(new Error('committed input is not a directory'), { code: 'ENOTDIR' })
    }
    return path.join(root, ...parts)
  }
  const inspect = async (filename) => {
    const name = relative(filename), entry = files.get(name), directory = directories.has(name)
    if (!entry && !directory) throw missing()
    return { isFile: () => !!entry && entry.mode.startsWith('100'), isDirectory: () => directory,
      isSymbolicLink: () => entry?.mode === '120000', mode: directory || entry?.mode === '100755' ? 0o755 : 0o644 }
  }
  const historical = { realpath: resolve, stat: inspect, lstat: inspect,
    readFile: async (filename) => {
      const entry = files.get(relative(filename))
      if (!entry) throw missing()
      return blob(entry)
    },
    readlink: async (filename) => (await blob(files.get(relative(filename)))).toString('utf8'),
    ignoredInput: async () => false,
  }
  // A commit cannot establish the past bytes or absence of an explicitly named
  // non-Git input. Refuse proof carry instead of consulting today's ignored files.
  const required = [...snapshot.files.filter((file) => file.mode === '120000').map((file) => file.path),
    ...inputs.filter((input) => !/[*?\[]/.test(input) && path.posix.normalize(input) !== '.')]
  for (const input of required) {
    try { await resolve(path.resolve(root, input)) } catch (error) {
      if (error.code !== 'ENOENT') throw error
      return { files: snapshot.files, verifiable: false }
    }
  }
  return { files: snapshot.files, verifiable: true, deps: historical }
}

export async function fingerprintVerificationCheck(root, plan, check, { scope = {}, env = process.env,
  runtime = { node: process.version, executable: process.execPath, platform: process.platform, arch: process.arch }, ref = null, deps = {} } = {}) {
  const base = await (deps.realpath ?? realpath)(root)
  const inputs = check.inputs ?? ['.']
  const snapshot = ref === null ? { files: await (deps.workingInputs ?? workingInputs)(base, inputs), verifiable: true, deps }
    : await revisionInputs(base, ref, inputs, deps)
  const inputFingerprint = snapshot.verifiable ? digest({ files: snapshot.files,
    links: await linkInputs(base, snapshot.files, snapshot.deps), literals: await literalInputs(base, inputs, snapshot.deps) }) : null
  const definitionFingerprint = digest({ schemaVersion: plan.schemaVersion, source: plan.source ?? null,
    id: check.id, tier: check.tier, command: check.command, inputs })
  // The inherited environment can affect any shell command. Only its digest is
  // persisted or returned, including when values contain credentials.
  const executionFingerprint = digest({ cwd: base, scope, runtime, environment: digest(env) })
  return { key: snapshot.verifiable ? `plan-check-v1:${digest({ definitionFingerprint, inputFingerprint, executionFingerprint })}` : null,
    inputs, inputFingerprint, definitionFingerprint, executionFingerprint, verifiable: snapshot.verifiable }
}
