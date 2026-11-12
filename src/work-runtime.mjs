import { mkdir, readFile, writeFile, rename, rm, realpath, access } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { SkillPackageError } from './errors.mjs'
import { recordProgress } from './work-progress.mjs'

export const runtimeRoot = (workspace) => path.join(workspace.git.commonDir, 'gusta', 'v1')
const empty = () => ({ schemaVersion: 1, groups: {}, attempts: {}, history: [] })

export async function readRuntime(root) {
  let text
  try { text = await readFile(path.join(root, 'state.json'), 'utf8') } catch (error) {
    if (error.code === 'ENOENT') return empty()
    throw error
  }
  let state
  try { state = JSON.parse(text) } catch {
    throw new SkillPackageError('작업 기록 JSON이 손상됐습니다. state.json을 보존하고 복구하세요.', [root])
  }
  if (state?.schemaVersion !== 1 || !state.groups || !state.attempts || typeof state.groups !== 'object' || typeof state.attempts !== 'object' || Array.isArray(state.groups) || Array.isArray(state.attempts)) {
    throw new SkillPackageError('지원하지 않는 작업 기록 형식입니다.', [root])
  }
  if (state.history !== undefined && !Array.isArray(state.history)) throw new SkillPackageError('작업 이력 형식이 올바르지 않습니다.', [root])
  return state
}

export async function readLock(root) {
  try { return JSON.parse(await readFile(path.join(root, 'lock', 'owner.json'), 'utf8')) } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

async function recovering(root) {
  try { await access(path.join(root, 'recovery')); return true } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

// Only short registry transactions hold this lock; Git and verification run outside it.
export async function transaction(root, update) {
  await mkdir(root, { recursive: true })
  const lock = path.join(root, 'lock')
  const owner = { id: randomUUID(), pid: process.pid, host: os.hostname(), at: new Date().toISOString() }
  let acquired = false
  for (let retry = 0; retry < 40; retry += 1) {
    if (await recovering(root)) { await new Promise((resolve) => setTimeout(resolve, 25)); continue }
    try {
      await mkdir(lock)
      if (await recovering(root)) { await rm(lock, { recursive: true }); continue }
      acquired = true
      break
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
  if (!acquired) throw new SkillPackageError('작업 기록을 다른 명령이 갱신 중입니다. work status로 lock을 확인하세요.', [JSON.stringify(await readLock(root))])
  let temporary
  try {
    await writeFile(path.join(lock, 'owner.json'), JSON.stringify(owner), { flag: 'wx' })
    const state = await readRuntime(root)
    const previous = structuredClone(state)
    const result = await update(state)
    recordProgress(previous, state)
    temporary = path.join(root, `state.${owner.id}.tmp`)
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx' })
    await rename(temporary, path.join(root, 'state.json'))
    return result
  } finally {
    if (temporary) await rm(temporary, { force: true })
    // We never expire or steal a live lock automatically.
    await rm(lock, { recursive: true, force: true })
  }
}

export async function unlockRuntime(root, id) {
  const recovery = path.join(root, 'recovery')
  await mkdir(recovery)
  try {
    const owner = await readLock(root)
    if (!owner || owner.id !== id) throw new SkillPackageError('lock ID가 일치하지 않습니다. work status로 확인하세요.')
    if (owner.host !== os.hostname()) throw new SkillPackageError('다른 호스트의 lock은 자동 회수하지 않습니다.')
    try {
      process.kill(owner.pid, 0)
      throw new SkillPackageError('lock 소유 프로세스가 아직 실행 중입니다.')
    } catch (error) {
      if (error.code !== 'ESRCH') throw error
    }
    await rm(path.join(root, 'lock'), { recursive: true })
    return { unlocked: id }
  } finally {
    await rm(recovery, { recursive: true })
  }
}

export async function canonicalDestination(destination) {
  // Do not create the destination itself: git worktree add must own its creation.
  await mkdir(path.dirname(destination), { recursive: true })
  return path.join(await realpath(path.dirname(destination)), path.basename(destination))
}
