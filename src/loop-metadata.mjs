import { readFile, writeFile, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { git } from './workspace.mjs'
import { atomicJSON, readJSON } from './loop-control.mjs'
import { vibeBeat } from './vibe.mjs'

const contents = async (file) => readFile(file, 'utf8').catch((error) => { if (error.code === 'ENOENT') return null; throw error })
const headText = async (root, file) => git(root, ['show', `HEAD:${file}`], [128])

// The host owns one file in the tree: its report, by exact content, never by a directory or glob
// exemption. The journal is written before each mutation and survives a failed write/commit.
// The session's presence is not in the tree at all: its row lives on the coordination branch
// (`beat`, vibe beat), so nothing the host does about it can dirty the checkout.
export class LoopMetadata {
  constructor(root, directory, report, tag, runId, { fault = async () => {}, beat = vibeBeat } = {}) {
    Object.assign(this, { root, directory, report, tag, runId, fault, beatSession: beat })
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
    // A host from before the coordination branch journaled its STATE active row here. That row is
    // nobody's to write now: the pending write is dropped, STATE stays as it is (gusta migrate moves it).
    if (op.path === 'spec/STATE.md') {
      this.journal.operation = null
      await atomicJSON(this.file, this.journal)
      return
    }
    if (op.path !== this.report) throw new Error('metadata journal path is not owned')
    const file = path.join(this.root, op.path), current = await contents(file)
    if (current !== op.before && current !== op.after) throw new Error(`metadata recovery conflict: ${op.path}`)
    if (current !== op.after) {
      const temporary = `${file}.${randomUUID()}.tmp`
      try { await writeFile(temporary, op.after); await rename(temporary, file) } finally { await rm(temporary, { force: true }) }
    }
    this.journal.expectedReport = op.after
    this.journal.operation = null
    await atomicJSON(this.file, this.journal)
  }
  // This session's row on the coordination branch: registered (autopilot) or, at the end, released.
  // One compare-and-swap there — no journal, no file, no commit here. A repeat is harmless.
  async beat(end = false) {
    await this.fault('session-beat')
    return this.beatSession({ targetRoot: this.root, tag: this.tag, ...(end ? { end: true } : { mode: 'autopilot' }) })
  }
  async commit(message) {
    if (await contents(path.join(this.root, this.report)) !== this.journal.expectedReport) throw new Error('host report ownership lost; preserving it')
    if (!(await git(this.root, ['status', '--porcelain', '--', this.report])).trim()) return
    const staged = await git(this.root, ['show', `:${this.report}`], [128])
    if (staged !== await headText(this.root, this.report) && staged !== this.journal.expectedReport) throw new Error(`unknown staged metadata preserved: ${this.report}`)
    await this.fault('metadata-commit')
    await git(this.root, ['add', '--', this.report])
    await git(this.root, ['commit', '--quiet', '--only', '-m', message, '--', this.report])
    this.journal.lastCommit = (await git(this.root, ['rev-parse', 'HEAD'])).trim()
    await atomicJSON(this.file, this.journal)
  }
  async assertClean() {
    const dirty = (await git(this.root, ['status', '--porcelain', '--untracked-files=all'])).trim()
    if (dirty) throw new Error(`uncommitted changes preserved; no implementation recovery or publication: ${dirty}`)
  }
}

export async function recoverLoopMetadata(root, directory, state, { beat } = {}) {
  const journal = await readJSON(path.join(directory, 'metadata.json'))
  if (!journal || journal.root !== root || journal.runId !== state.runId || journal.tag !== state.tag || journal.report !== state.report || !/^spec\/reports\/[\w-]+\.md$/.test(journal.report)) throw new Error('metadata journal ownership mismatch')
  const metadata = new LoopMetadata(root, directory, state.report, state.tag, state.runId, { beat })
  metadata.journal = journal
  await metadata.applyOperation()
  // Do not start units, publish code, alter task rows, or clear STOP. Just release our session row.
  await metadata.beat(true)
  let text = await contents(path.join(root, state.report))
  if (text !== metadata.journal.expectedReport) throw new Error('report recovery conflict')
  text ??= `# REPORT ${path.basename(state.report, '.md')}\n> mode:autopilot | host:loop-host | from:${state.startedAt} | to:- | push:-\n\n## done\n\n## decided\n\n## parked\n\n## checks\n\n## next\n`
  text = text.replace(/\bto:-/, `to:${new Date().toISOString()}`).replace(/## next[\s\S]*$/, `## next\n- loop stopped: ${state.reason ?? 'host-lost'}\n`)
  await metadata.writeReport(text)
  await metadata.commit(`vibe ${state.tag}: recover host metadata`)
  return { ok: true, recovered: true, runId: state.runId, implementationRestarted: false }
}
