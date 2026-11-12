import { readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

// Interactive state: what a person is doing with an agent on this checkout right now (an open
// gusta-design-mode design). It lives in the checkout's own Git directory — never committed, never
// merged, invisible to other worktrees and clones. STATE cannot hold it: STATE rides along with
// every planning commit (plan-push) to the planning branch and from there into every worktree.
const FILE = 'gusta-interactive.json'

const location = (workspace) => workspace.git?.gitDir ? path.join(workspace.git.gitDir, FILE) : null

export async function readInteractive(workspace) {
  const file = location(workspace)
  if (!file) return {}
  try { return JSON.parse(await readFile(file, 'utf8')) } catch (error) {
    if (error.code === 'ENOENT') return {}
    throw error
  }
}

export async function writeInteractive(workspace, state) {
  const file = location(workspace)
  const temporary = `${file}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify({ ...state, schemaVersion: 1 }, null, 2)}\n`)
  await rename(temporary, file)
}

// The open design of this checkout, or null.
export const designOf = async (workspace) => (await readInteractive(workspace)).design ?? null
