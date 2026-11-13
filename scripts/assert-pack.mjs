import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { discoverSkills } from '../src/skill-set.mjs'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const result = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
  cwd: projectRoot,
  encoding: 'utf8',
})

if (result.status !== 0) {
  process.stderr.write(result.stderr || result.stdout)
  process.exit(result.status ?? 1)
}

const report = JSON.parse(result.stdout)
const packedFiles = new Set(report[0].files.map((file) => file.path))
const requiredCoreFiles = [
  'bin/gusta.mjs',
  'bin/gusta-agent-adapter.mjs',
  'bin/gusta-vibe-loop.mjs',
  'bin/gusta-vibe-watch.mjs',
  'bin/gusta-work-run.mjs',
  'bin/gusta-ab-hub.mjs',
  'bin/gusta-sketch-serve.mjs',
  'src/vibe-loop.mjs',
  'src/loop-control.mjs',
  'src/loop-metadata.mjs',
  'src/agent-adapter.mjs',
  'src/work-providers.mjs',
  'src/work-progress.mjs',
  'src/vibe.mjs',
  'src/vibe-coord.mjs',
  'src/vibe-session.mjs',
  'src/vibe-inbox.mjs',
  'src/coord-branch.mjs',
  'src/coord-doc.mjs',
  'src/state-doc.mjs',
  'src/index.mjs',
  'package.json',
  'README.md',
  'LICENSE',
]
const missing = requiredCoreFiles.filter((file) => !packedFiles.has(file))

const skills = await discoverSkills({ allowEmpty: true })
for (const skill of skills) {
  for (const file of skill.files) {
    const relativePath = path
      .relative(projectRoot, file.absolutePath)
      .split(path.sep)
      .join('/')
    if (!packedFiles.has(relativePath)) missing.push(relativePath)
  }
}

if (missing.length > 0) {
  process.stderr.write(`npm 패키지에 빠진 파일:\n${missing.map((file) => `  - ${file}`).join('\n')}\n`)
  process.exit(1)
}

const totalBytes = report[0].unpackedSize
process.stdout.write(
  `npm 패키지 검증 완료: ${packedFiles.size}개 파일, ${totalBytes.toLocaleString()} bytes\n`,
)
