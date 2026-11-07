import { readFile, realpath, rename, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Temporary npm-only workaround for npm/cli#10078. Keep signing, log upload
// and verification intact; enable Sigstore's existing 409 recovery path.
// Remove this when the pinned npm CLI enables recovery itself.
export const publishNpmVersion = '11.21.2'
const sigstoreVersion = '4.1.1'
const before = "entryType: options.legacyCompatibility ? 'intoto' : 'dsse',\n            fetchOnConflict: false,\n            retry: options.retry ?? exports.DEFAULT_RETRY,"
const after = before.replace('fetchOnConflict: false', 'fetchOnConflict: true')

export function enableConflictRecovery(source) {
  const occurrences = (text) => source.split(text).length - 1
  const pending = occurrences(before), enabled = occurrences(after)
  if (pending === 0 && enabled === 1) return source
  if (pending !== 1 || enabled !== 0) throw new Error('Unsupported Sigstore configuration; refusing to modify publishing tools')
  return source.replace(before, after)
}

export async function preparePublish(npmDirectory) {
  const root = await realpath(npmDirectory)
  const npmPackage = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  if (npmPackage.name !== 'npm' || npmPackage.version !== publishNpmVersion) {
    throw new Error(`Publishing requires npm ${publishNpmVersion}`)
  }
  const npmRequire = createRequire(path.join(root, 'package.json'))
  const publishRequire = createRequire(npmRequire.resolve('libnpmpublish'))
  const entry = await realpath(publishRequire.resolve('sigstore'))
  const relative = path.relative(path.join(root, 'node_modules'), entry)
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Sigstore must belong to the isolated publishing CLI')
  const sigstorePackage = JSON.parse(await readFile(path.join(path.dirname(entry), '..', 'package.json'), 'utf8'))
  if (sigstorePackage.name !== 'sigstore' || sigstorePackage.version !== sigstoreVersion) {
    throw new Error(`Publishing requires bundled sigstore ${sigstoreVersion}`)
  }
  const configuration = path.join(path.dirname(entry), 'config.js')
  const source = await readFile(configuration, 'utf8')
  const prepared = enableConflictRecovery(source)
  if (prepared !== source) {
    const temporary = `${configuration}.prepared`
    await writeFile(temporary, prepared, { flag: 'wx' })
    await rename(temporary, configuration)
  }
  return { npm: npmPackage.version, sigstore: sigstorePackage.version, conflictRecovery: true }
}

if (process.argv[1] && await realpath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: node scripts/prepare-publish.mjs <isolated npm directory>')
    console.log(JSON.stringify(await preparePublish(process.argv[2])))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
