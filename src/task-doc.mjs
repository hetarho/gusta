// A task file's lifecycle edits: st in the quote line, one result line, and the move into
// tasks/done/. Shared by the solo `vibe task` commands and work-group integration.
import { access, mkdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { SkillPackageError } from './errors.mjs'

export const withSt = (content, st) => content.replace(/^> st:[^|]+\|/m, `> st:${st} |`)

// Replace `- <key>:` inside ## result, or append it there.
export function withResultLine(content, key, value) {
  const lines = content.split('\n')
  const start = lines.findIndex((line) => /^##\s+result\s*$/.test(line))
  if (start === -1) return `${content.trimEnd()}\n\n## result\n- ${key}: ${value}\n`
  let end = lines.findIndex((line, index) => index > start && line.startsWith('## '))
  if (end === -1) end = lines.length
  const index = lines.findIndex((line, position) => position > start && position < end && line.startsWith(`- ${key}:`))
  if (index !== -1) lines[index] = `- ${key}: ${value}`
  else {
    let last = end
    while (last - 1 > start && lines[last - 1].trim() === '') last--
    lines.splice(last, 0, `- ${key}: ${value}`)
  }
  return lines.join('\n')
}

// Write the final content and move the file (repository-relative) to spec/tasks/done/.
export async function archiveTaskFile(root, file, content) {
  const relative = `spec/tasks/done/${path.basename(file)}`
  const archive = path.join(root, relative)
  const taken = await access(archive).then(() => true, (error) => { if (error.code === 'ENOENT') return false; throw error })
  if (taken) throw new SkillPackageError('완료 아카이브 파일이 이미 있습니다.', [archive])
  const source = path.join(root, file)
  await writeFile(source, content)
  await mkdir(path.dirname(archive), { recursive: true })
  await rename(source, archive)
  return relative
}
