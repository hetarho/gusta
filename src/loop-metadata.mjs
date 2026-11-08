import { readFile, writeFile, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { git } from './workspace.mjs'
import { ACTIVE_HEADER } from './state-doc.mjs'
import { atomicJSON, readJSON } from './loop-control.mjs'

const contents = async (file) => readFile(file, 'utf8').catch((error) => { if (error.code === 'ENOENT') return null; throw error })
const headText = async (root, file) => git(root, ['show', `HEAD:${file}`], [128])
// Preserve every byte outside this row/its generated empty section.
function presence(text, tag, row = null) {
  const section = text.match(/^## active[^\n]*\n[\s\S]*?(?=^## |(?![\s\S]))/m)
  if (!section) {
    if (!row) return text
    const block = `## active\n${ACTIVE_HEADER.join('\n')}\n${row}\n\n`
    const index = text.search(/^## (?!cfg\b)/m)
    return index < 0 ? `${text}\n${block}` : text.slice(0, index) + block + text.slice(index)
  }
  let body = section[0].replace(new RegExp(`^\\|\\s*${tag}\\s*\\|[^\\n]*(?:\\n|$)`, 'm'), '')
  if (row) body = body.replace(`${ACTIVE_HEADER[1]}\n`, `${ACTIVE_HEADER[1]}\n${row}\n`)
  else if (body.split('\n').every((line) => !line.trim() || line === '## active' || ACTIVE_HEADER.includes(line))) body = ''
  return text.slice(0, section.index) + body + text.slice(section.index + section[0].length)
}
const withoutSelf = (text, tag) => presence(text, tag)

// Ownership is exact content plus one active row, never a directory/glob exemption.
// The journal is written before each mutation and survives a failed write/commit.
export class LoopMetadata {
  constructor(root, directory, report, tag, runId, { fault = async () => {} } = {}) {
    Object.assign(this, { root, directory, report, tag, runId, fault })
    this.file = path.join(directory, 'metadata.json')
    this.journal = { schemaVersion: 1, root, report, tag, runId, expectedReport: null, operation: null }
  }
  async initialize() {
    const previous = await readJSON(this.file)
    const current = await contents(path.join(this.root, this.report))
    if (current !== null) {
      if (!(previous?.root === this.root && previous.tag === this.tag && previous.report === this.report && previous.expectedReport === current && !previous.operation)) throw new Error('report exists without exact journaled host ownership; use a new tag')
    }
    this.journal.expectedReport = current
    await atomicJSON(this.file, this.journal)
  }
  async writeReport(text) {
    const file = path.join(this.root, this.report), before = await contents(file)
    if (before !== this.journal.expectedReport) throw new Error('host report changed outside the loop; preserving it')
    this.journal.operation = { path: this.report, before, after: text }
    await atomicJSON(this.file, this.journal)
    await this.fault('report-write')
    await this.applyOperation()
  }
  async applyOperation() {
    const op = this.journal.operation
    if (!op) return
    if (op.path !== this.report && op.path !== 'spec/STATE.md') throw new Error('metadata journal path is not owned')
    if (op.path === 'spec/STATE.md' && withoutSelf(op.before, this.tag) !== withoutSelf(op.after, this.tag)) throw new Error('metadata journal contains changes outside the owned active row')
    const file = path.join(this.root, op.path), current = await contents(file)
    if (current !== op.before && current !== op.after) throw new Error(`metadata recovery conflict: ${op.path}`)
    if (current !== op.after) {
      const temporary = `${file}.${randomUUID()}.tmp`
      try { await writeFile(temporary, op.after); await rename(temporary, file) } finally { await rm(temporary, { force: true }) }
    }
    if (op.path === this.report) this.journal.expectedReport = op.after
    this.journal.operation = null
    await atomicJSON(this.file, this.journal)
  }
  async beat(end = false) {
    const file = path.join(this.root, 'spec/STATE.md'), before = await readFile(file, 'utf8')
    const now = `${new Date().toISOString().slice(0, 16)}Z`
    const host = os.hostname().replace(/\.local$/, '').replace(/[|\s]/g, '-') || 'host'
    const after = presence(before, this.tag, end ? null : `| ${this.tag} | ${host} | autopilot | ${now} | ${now} | - |`)
    this.journal.operation = { path: 'spec/STATE.md', before, after }
    await atomicJSON(this.file, this.journal)
    await this.fault('state-write')
    await this.applyOperation()
  }
  async commit(message) {
    if (await contents(path.join(this.root, this.report)) !== this.journal.expectedReport) throw new Error('host report ownership lost; preserving it')
    const files = []
    const reportChanged = (await git(this.root, ['status', '--porcelain', '--', this.report])).trim()
    if (reportChanged) files.push(this.report)
    const state = await readFile(path.join(this.root, 'spec/STATE.md'), 'utf8'), committed = await headText(this.root, 'spec/STATE.md')
    // A task can commit STATE. Only a difference confined to our active row is ours.
    if (state !== committed && withoutSelf(state, this.tag) === withoutSelf(committed, this.tag)) files.push('spec/STATE.md')
    if (!files.length) return
    for (const file of files) {
      const staged = await git(this.root, ['show', `:${file}`], [128])
      const committed = await headText(this.root, file)
      const current = await contents(path.join(this.root, file))
      if (staged !== committed && staged !== current) throw new Error(`unknown staged metadata preserved: ${file}`)
    }
    await this.fault('metadata-commit')
    await git(this.root, ['add', '--', ...files])
    await git(this.root, ['commit', '--quiet', '--only', '-m', message, '--', ...files])
    this.journal.lastCommit = (await git(this.root, ['rev-parse', 'HEAD'])).trim()
    await atomicJSON(this.file, this.journal)
  }
  async assertClean() {
    const dirty = (await git(this.root, ['status', '--porcelain', '--untracked-files=all'])).trim()
    if (dirty) throw new Error(`uncommitted changes preserved; no implementation recovery or publication: ${dirty}`)
  }
}

export async function recoverLoopMetadata(root, directory, state) {
  const journal = await readJSON(path.join(directory, 'metadata.json'))
  if (!journal || journal.root !== root || journal.runId !== state.runId || journal.tag !== state.tag || journal.report !== state.report || !/^spec\/reports\/[\w-]+\.md$/.test(journal.report)) throw new Error('metadata journal ownership mismatch')
  const metadata = new LoopMetadata(root, directory, state.report, state.tag, state.runId)
  metadata.journal = journal
  await metadata.applyOperation()
  // Do not start units, publish, alter task rows, or clear STOP. Just remove our presence.
  await metadata.beat(true)
  let text = await contents(path.join(root, state.report))
  if (text !== metadata.journal.expectedReport) throw new Error('report recovery conflict')
  text ??= `# REPORT ${path.basename(state.report, '.md')}\n> mode:autopilot | host:loop-host | from:${state.startedAt} | to:- | push:-\n\n## done\n\n## decided\n\n## parked\n\n## checks\n\n## next\n`
  text = text.replace(/\bto:-/, `to:${new Date().toISOString()}`).replace(/## next[\s\S]*$/, `## next\n- loop stopped: ${state.reason ?? 'host-lost'}\n`)
  await metadata.writeReport(text)
  await metadata.commit(`vibe ${state.tag}: recover host metadata`)
  return { ok: true, recovered: true, runId: state.runId, implementationRestarted: false }
}
