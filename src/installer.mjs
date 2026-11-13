import { createHash } from 'node:crypto'
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  rmdir,
  unlink,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'

import { AGENT_CONFIG, LOCK_FILE, PACKAGE_NAME } from './constants.mjs'
import { SkillPackageError } from './errors.mjs'
import { getPackageInfo } from './package-info.mjs'
import { bundledSkillsRoot, discoverSkills } from './skill-set.mjs'

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function toNativePath(portablePath) {
  return portablePath.split('/').join(path.sep)
}

function normalizeAgents(agents = ['claude', 'codex']) {
  const uniqueAgents = [...new Set(agents)]
  if (uniqueAgents.length === 0) {
    throw new SkillPackageError('설치하거나 검사할 에이전트를 하나 이상 선택해야 합니다.')
  }
  const invalid = uniqueAgents.filter((agent) => !AGENT_CONFIG[agent])
  if (invalid.length > 0) {
    throw new SkillPackageError(`지원하지 않는 에이전트입니다: ${invalid.join(', ')}`)
  }
  return uniqueAgents.sort()
}

function selectedFile(relativePath, agents) {
  return agents.some((agent) => relativePath.startsWith(`${AGENT_CONFIG[agent].root}/`))
}

function isSafeLockPath(relativePath) {
  if (typeof relativePath !== 'string' || relativePath.includes('\\')) return false
  if (path.posix.isAbsolute(relativePath) || path.posix.normalize(relativePath) !== relativePath) {
    return false
  }

  const matchingAgent = Object.values(AGENT_CONFIG).find((config) =>
    relativePath.startsWith(`${config.root}/`),
  )
  if (!matchingAgent) return false

  const remainder = relativePath.slice(matchingAgent.root.length + 1)
  const segments = remainder.split('/')
  return segments.length >= 2 && segments.every((segment) => segment && segment !== '.' && segment !== '..')
}

async function assertSafeTargetRoot(targetRoot) {
  try {
    const stats = await lstat(targetRoot)
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new SkillPackageError(`대상 경로는 실제 디렉터리여야 합니다: ${targetRoot}`)
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

async function assertSafeDestinationParents(targetRoot, relativePath) {
  let current = targetRoot
  const segments = relativePath.split('/')

  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment)
    try {
      const stats = await lstat(current)
      if (stats.isSymbolicLink()) {
        throw new SkillPackageError(`대상 경로에 심볼릭 링크가 포함되어 있습니다: ${relativePath}`)
      }
      if (!stats.isDirectory()) {
        throw new SkillPackageError(`대상 경로의 상위 항목이 디렉터리가 아닙니다: ${relativePath}`)
      }
    } catch (error) {
      if (error?.code === 'ENOENT') return
      throw error
    }
  }
}

async function readLock(targetRoot) {
  const lockPath = path.join(targetRoot, LOCK_FILE)
  try {
    const stats = await lstat(lockPath)
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new SkillPackageError(`${LOCK_FILE}은 실제 일반 파일이어야 합니다.`)
    }
    const lock = JSON.parse(await readFile(lockPath, 'utf8'))
    if (
      lock.schemaVersion !== 1 ||
      lock.packageName !== PACKAGE_NAME ||
      typeof lock.files !== 'object' ||
      lock.files === null ||
      Array.isArray(lock.files)
    ) {
      throw new SkillPackageError(`${LOCK_FILE} 형식이 올바르지 않습니다.`)
    }
    const invalidPaths = Object.keys(lock.files).filter((relativePath) => !isSafeLockPath(relativePath))
    const invalidRecords = Object.entries(lock.files).filter(
      ([, record]) =>
        typeof record !== 'object' ||
        record === null ||
        !/^[a-f0-9]{64}$/.test(record.sha256),
    )
    if (invalidPaths.length > 0 || invalidRecords.length > 0) {
      throw new SkillPackageError(`${LOCK_FILE}에 안전하지 않거나 잘못된 파일 기록이 있습니다.`, [
        ...invalidPaths,
        ...invalidRecords.map(([relativePath]) => relativePath),
      ])
    }
    return lock
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { schemaVersion: 1, packageName: PACKAGE_NAME, files: {} }
    }
    if (error instanceof SyntaxError) {
      throw new SkillPackageError(`${LOCK_FILE}의 JSON 형식이 올바르지 않습니다.`)
    }
    throw error
  }
}

async function readDestinationState(absolutePath) {
  try {
    const stats = await lstat(absolutePath)
    if (!stats.isFile()) return { type: stats.isSymbolicLink() ? 'symlink' : 'other' }
    const contents = await readFile(absolutePath)
    return { type: 'file', hash: sha256(contents) }
  } catch (error) {
    if (error?.code === 'ENOENT') return { type: 'missing' }
    throw error
  }
}

async function createDesiredFiles({ skillsRoot, agents }) {
  const skills = await discoverSkills({ skillsRoot })
  const desired = new Map()

  for (const agent of agents) {
    const config = AGENT_CONFIG[agent]
    for (const skill of skills) {
      for (const file of skill.files) {
        if (!config.include(file.relativePath)) continue
        const contents = await readFile(file.absolutePath)
        const relativePath = `${config.root}/${skill.name}/${file.relativePath}`
        desired.set(relativePath, {
          contents,
          executable: file.executable,
          hash: sha256(contents),
        })
      }
    }
  }

  return { desired, skills }
}

async function pruneEmptyParents(startDirectory, stopDirectory) {
  let current = startDirectory
  while (current.startsWith(`${stopDirectory}${path.sep}`) && current !== stopDirectory) {
    const entries = await readdir(current)
    if (entries.length > 0) return
    await rmdir(current)
    current = path.dirname(current)
  }
}

function sortObject(object) {
  return Object.fromEntries(Object.entries(object).sort(([left], [right]) => left.localeCompare(right)))
}

export async function installSkills({
  targetRoot = process.cwd(),
  skillsRoot = bundledSkillsRoot,
  agents,
  force = false,
  dryRun = false,
  packageVersion,
} = {}) {
  const resolvedTarget = path.resolve(targetRoot)
  const selectedAgents = normalizeAgents(agents)
  await assertSafeTargetRoot(resolvedTarget)
  const lock = await readLock(resolvedTarget)
  const { desired, skills } = await createDesiredFiles({ skillsRoot, agents: selectedAgents })
  const previousSelected = new Map(
    Object.entries(lock.files).filter(([relativePath]) => selectedFile(relativePath, selectedAgents)),
  )
  const actions = []
  const conflicts = []

  for (const [relativePath, source] of desired) {
    await assertSafeDestinationParents(resolvedTarget, relativePath)
    const destination = path.join(resolvedTarget, toNativePath(relativePath))
    const current = await readDestinationState(destination)
    const previous = previousSelected.get(relativePath)

    if (current.type === 'missing') {
      actions.push({ type: 'create', relativePath, destination, source })
    } else if (current.type !== 'file') {
      conflicts.push(`${relativePath}: 대상이 일반 파일이 아닙니다 (${current.type}).`)
    } else if (current.hash === source.hash) {
      actions.push({ type: 'unchanged', relativePath, destination, source })
    } else if (previous?.sha256 === current.hash || force) {
      actions.push({ type: 'update', relativePath, destination, source })
    } else {
      conflicts.push(`${relativePath}: 로컬에서 수정되었거나 다른 스킬이 이미 사용 중입니다.`)
    }
  }

  for (const [relativePath, previous] of previousSelected) {
    if (desired.has(relativePath)) continue

    await assertSafeDestinationParents(resolvedTarget, relativePath)
    const destination = path.join(resolvedTarget, toNativePath(relativePath))
    const current = await readDestinationState(destination)
    if (current.type === 'missing') continue
    if (current.type !== 'file') {
      conflicts.push(`${relativePath}: 제거 대상이 일반 파일이 아닙니다 (${current.type}).`)
    } else if (previous?.sha256 === current.hash || force) {
      actions.push({ type: 'remove', relativePath, destination })
    } else {
      conflicts.push(`${relativePath}: 로컬 수정본이 있어 제거할 수 없습니다.`)
    }
  }

  if (conflicts.length > 0) {
    throw new SkillPackageError(
      force
        ? '파일 종류 충돌로 설치를 계속할 수 없습니다.'
        : '로컬 변경과 충돌했습니다. 내용을 확인하거나 --force로 패키지 버전을 적용하세요.',
      conflicts,
    )
  }

  if (!dryRun) {
    for (const action of actions) {
      if (action.type === 'unchanged') continue
      if (action.type === 'remove') {
        await unlink(action.destination)
        const agentRoot = selectedAgents
          .map((agent) => path.join(resolvedTarget, toNativePath(AGENT_CONFIG[agent].root)))
          .find((root) => action.destination.startsWith(`${root}${path.sep}`))
        if (agentRoot) await pruneEmptyParents(path.dirname(action.destination), agentRoot)
        continue
      }

      await mkdir(path.dirname(action.destination), { recursive: true })
      await writeFile(action.destination, action.source.contents)
      await chmod(action.destination, action.source.executable ? 0o755 : 0o644)
    }

    const retainedFiles = Object.fromEntries(
      Object.entries(lock.files).filter(
        ([relativePath]) => !selectedFile(relativePath, selectedAgents),
      ),
    )
    for (const [relativePath, source] of desired) {
      retainedFiles[relativePath] = { sha256: source.hash }
    }

    const info = packageVersion ? { version: packageVersion } : await getPackageInfo()
    const nextLock = {
      schemaVersion: 1,
      packageName: PACKAGE_NAME,
      packageVersion: info.version,
      installedAt: new Date().toISOString(),
      agents: [...new Set(Object.keys(retainedFiles).map((relativePath) => relativePath.split('/')[0]))]
        .map((root) => (root === '.claude' ? 'claude' : root === '.codex' ? 'codex' : root))
        .sort(),
      files: sortObject(retainedFiles),
    }
    await writeFile(path.join(resolvedTarget, LOCK_FILE), `${JSON.stringify(nextLock, null, 2)}\n`)
  }

  const counts = { create: 0, update: 0, remove: 0, unchanged: 0 }
  for (const action of actions) counts[action.type] += 1

  return {
    targetRoot: resolvedTarget,
    agents: selectedAgents,
    skillNames: skills.map((skill) => skill.name),
    dryRun,
    actions,
    counts,
  }
}

// The agents this project has skills installed for, as the lock file records them.
export async function installedAgents(targetRoot = process.cwd()) {
  const files = Object.keys((await readLock(path.resolve(targetRoot))).files)
  return Object.keys(AGENT_CONFIG).filter((agent) => files.some((file) => file.startsWith(`${AGENT_CONFIG[agent].root}/`)))
}

export async function checkSkills({
  targetRoot = process.cwd(),
  skillsRoot = bundledSkillsRoot,
  agents,
} = {}) {
  const resolvedTarget = path.resolve(targetRoot)
  const selectedAgents = normalizeAgents(agents)
  await assertSafeTargetRoot(resolvedTarget)
  const lock = await readLock(resolvedTarget)
  const { desired, skills } = await createDesiredFiles({ skillsRoot, agents: selectedAgents })
  const mismatches = []

  for (const [relativePath, source] of desired) {
    await assertSafeDestinationParents(resolvedTarget, relativePath)
    const current = await readDestinationState(
      path.join(resolvedTarget, toNativePath(relativePath)),
    )
    if (current.type === 'missing') mismatches.push({ type: 'missing', relativePath })
    else if (current.type !== 'file') mismatches.push({ type: current.type, relativePath })
    else if (current.hash !== source.hash) mismatches.push({ type: 'changed', relativePath })
  }

  for (const relativePath of Object.keys(lock.files)) {
    if (selectedFile(relativePath, selectedAgents) && !desired.has(relativePath)) {
      await assertSafeDestinationParents(resolvedTarget, relativePath)
      const current = await readDestinationState(
        path.join(resolvedTarget, toNativePath(relativePath)),
      )
      if (current.type !== 'missing') mismatches.push({ type: 'stale', relativePath })
    }
  }

  return {
    ok: mismatches.length === 0,
    targetRoot: resolvedTarget,
    agents: selectedAgents,
    skillNames: skills.map((skill) => skill.name),
    mismatches,
  }
}
