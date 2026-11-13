import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const CACHE_LIMIT = 500
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const alive = (pid) => { try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' } }

async function gitWith(root, args, env) {
  return (await execute('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C', ...env } })).stdout.trim()
}

// The tree a check actually ran on: committed files plus uncommitted and untracked ones
// (ignored files excluded). A copy of the real index keeps Git's stat cache, so only
// changed files are hashed again.
export async function workingTree(root) {
  const temporary = path.join(os.tmpdir(), `gusta-index-${randomUUID()}`)
  try {
    const index = path.resolve(root, await gitWith(root, ['rev-parse', '--git-path', 'index']))
    const env = { GIT_INDEX_FILE: temporary }
    try { await copyFile(index, temporary) } catch (error) {
      if (error.code !== 'ENOENT') throw error
      await gitWith(root, ['read-tree', 'HEAD'], env)
    }
    await gitWith(root, ['add', '-A'], env)
    return await gitWith(root, ['write-tree'], env)
  } finally {
    await rm(temporary, { force: true })
  }
}

export const commitTree = (root, commit) => gitWith(root, ['rev-parse', `${commit}^{tree}`])

// A stored command that reads GUSTA_* selects its work from the scope, so the scope is
// part of what was verified; any other command depends on the tree alone.
export function checkKey(tree, command, scope = {}) {
  return [tree, command, command.includes('GUSTA_') ? JSON.stringify(scope) : ''].join('\u0000')
}

async function readCache(runtime) {
  try {
    const cache = JSON.parse(await readFile(path.join(runtime, 'checks.json'), 'utf8'))
    return cache?.schemaVersion === 1 && cache.entries && typeof cache.entries === 'object' ? cache : { schemaVersion: 1, entries: {} }
  } catch { return { schemaVersion: 1, entries: {} } }
}

export async function cachedPass(runtime, key) {
  return (await readCache(runtime)).entries[key] ?? null
}

// Only passes are cached. The cache is advisory: losing a concurrent write costs a re-run.
export async function recordPass(runtime, key, entry) {
  await mkdir(runtime, { recursive: true })
  const cache = await readCache(runtime)
  cache.entries[key] = { ...entry, at: new Date().toISOString() }
  const keys = Object.keys(cache.entries)
  if (keys.length > CACHE_LIMIT) {
    for (const old of keys.sort((a, b) => cache.entries[a].at.localeCompare(cache.entries[b].at)).slice(0, keys.length - CACHE_LIMIT)) delete cache.entries[old]
  }
  const temporary = path.join(runtime, `checks.${randomUUID()}.tmp`)
  await writeFile(temporary, `${JSON.stringify(cache)}\n`)
  await rename(temporary, path.join(runtime, 'checks.json'))
}

// One heavy check at a time per clone (browser suites, integration and
// group gates), so they never compete for the same CPUs.
export async function withHeavyLock(runtime, label, run, { timeoutMs = 4 * 60 * 60 * 1000, pollMs = 2000, onWait, signal } = {}) {
  const lock = path.join(runtime, 'heavy')
  await mkdir(runtime, { recursive: true })
  const deadline = Date.now() + timeoutMs
  let waited = false
  for (;;) {
    if (signal?.aborted) throw new Error('heavy check stopped')
    try {
      await mkdir(lock)
      await writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, host: os.hostname(), label, at: new Date().toISOString() }))
      break
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      let owner = null
      try { owner = JSON.parse(await readFile(path.join(lock, 'owner.json'), 'utf8')) } catch {}
      // A lock left by a process that is gone on this host is reclaimed; others wait.
      if (owner && owner.host === os.hostname() && !alive(owner.pid)) { await rm(lock, { recursive: true, force: true }); continue }
      if (!owner) {
        // The owner may still be writing its record; a record-less lock older than a minute is abandoned.
        const stale = await stat(lock).then((info) => Date.now() - info.mtimeMs > 60000, () => false)
        if (stale) { await rm(lock, { recursive: true, force: true }); continue }
      }
      if (Date.now() >= deadline) throw new Error(`heavy lock busy: ${owner?.label ?? 'unknown'} (pid ${owner?.pid ?? '?'})`)
      if (!waited) { waited = true; onWait?.(owner) }
      await sleep(pollMs)
    }
  }
  try { return await run() } finally { await rm(lock, { recursive: true, force: true }) }
}

// Measured wall-clock of the closing gate's commands and of loop phases (`unit`, `ci`).
// A timed run sizes its closing reserve from these instead of a fixed share. The last
// few samples are kept and the largest is used, so one quick run does not shrink it.
const TIMING_SAMPLES = 3
// Task checks (`task` kind) are averaged, so each keeps more samples; units pick their own tests,
// so the commands are many and only the most recently run ones are kept.
const TASK_SAMPLES = 10, TASK_KEYS = 100
export const timingKey = (kind, command = '') => `${kind}\u0000${command.trim().replace(/\s+/g, ' ')}`
// A task check is meant to be fast: one that averages over a minute in at least two runs belongs
// to the final gate. Moving it changes the ARCH tiers, so it is only ever suggested to a person.
export const SLOW_TASK_CHECK_MS = 60000, SLOW_TASK_CHECK_RUNS = 2

// rows: [{ command, runs (default 1), ms }]; one row per command after this. Pure.
export function taskCheckRows(rows) {
  const by = new Map()
  for (const row of rows) {
    if (!row?.command || !Number.isFinite(row.ms)) continue
    const command = row.command.trim().replace(/\s+/g, ' '), entry = by.get(command) ?? { command, runs: 0, ms: 0 }
    entry.runs += row.runs ?? 1; entry.ms += row.ms
    by.set(command, entry)
  }
  return [...by.values()]
}

export function taskCheckSummary(rows) {
  const all = taskCheckRows(rows)
  const slow = all.filter((entry) => entry.runs >= SLOW_TASK_CHECK_RUNS && entry.ms / entry.runs > SLOW_TASK_CHECK_MS)
    .sort((a, b) => b.ms - a.ms).map((entry) => ({ command: entry.command, runs: entry.runs, avgMs: Math.round(entry.ms / entry.runs) }))
  return { runs: all.reduce((sum, entry) => sum + entry.runs, 0), ms: all.reduce((sum, entry) => sum + entry.ms, 0), slow }
}

// The task checks timings.json still holds: each command's kept samples.
export const taskTimingRows = (store) => Object.entries(store.entries).filter(([key]) => key.startsWith('task\u0000'))
  .map(([key, entry]) => ({ command: key.slice(5), runs: entry.samples?.length ?? 0, ms: (entry.samples ?? []).reduce((sum, ms) => sum + ms, 0) }))

export async function readTimings(runtime) {
  try {
    const store = JSON.parse(await readFile(path.join(runtime, 'timings.json'), 'utf8'))
    return store?.schemaVersion === 1 && store.entries && typeof store.entries === 'object' ? store : { schemaVersion: 1, entries: {} }
  } catch { return { schemaVersion: 1, entries: {} } }
}

export function measured(store, key) {
  const samples = store.entries[key]?.samples ?? []
  return samples.length ? Math.max(...samples) : null
}

// Advisory like the pass cache: losing a concurrent write costs one sample.
export async function recordTiming(runtime, key, ms) {
  if (!Number.isFinite(ms) || ms < 0) return
  await mkdir(runtime, { recursive: true })
  const store = await readTimings(runtime), task = key.startsWith('task\u0000')
  store.entries[key] = { samples: [...(store.entries[key]?.samples ?? []), Math.round(ms)].slice(-(task ? TASK_SAMPLES : TIMING_SAMPLES)), at: new Date().toISOString() }
  if (task) {
    const keys = Object.keys(store.entries).filter((name) => name.startsWith('task\u0000'))
    for (const old of keys.sort((a, b) => store.entries[a].at.localeCompare(store.entries[b].at)).slice(0, Math.max(0, keys.length - TASK_KEYS))) delete store.entries[old]
  }
  const temporary = path.join(runtime, `timings.${randomUUID()}.tmp`)
  await writeFile(temporary, `${JSON.stringify(store)}\n`)
  await rename(temporary, path.join(runtime, 'timings.json'))
}
