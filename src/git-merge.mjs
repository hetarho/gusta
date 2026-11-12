import { mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { git } from './workspace.mjs'

const cli = fileURLToPath(new URL('../bin/gusta.mjs', import.meta.url))

// `git -c ...` arguments that merge spec/STATE.md by section (vibe merge-state) for one
// invocation only. Nothing is written to the user's Git config; their global attributes
// file is carried over.
export async function stateMergeArgs(root, runtime) {
  await mkdir(runtime, { recursive: true })
  const file = path.join(runtime, 'state.gitattributes')
  const configured = (await git(root, ['config', '--get', 'core.attributesFile'], [1]))?.trim()
  const global = configured ? configured.replace(/^~(?=\/)/, os.homedir()) : path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'git', 'attributes')
  const inherited = await readFile(global, 'utf8').catch(() => '')
  await writeFile(file, `${inherited.trimEnd()}\nspec/STATE.md merge=gusta-state\n`.trimStart())
  return ['-c', `core.attributesFile=${file}`, '-c', 'merge.gusta-state.name=gusta STATE sections',
    '-c', `merge.gusta-state.driver="${process.execPath}" "${cli}" vibe merge-state %O %A %B`]
}
