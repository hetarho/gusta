#!/usr/bin/env node
// Repository-controlled input sizes, not a provider's hidden system prompt or billing.
import { readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { vibeStatus } from '../src/vibe.mjs'
import { vibeFormat } from '../src/vibe-brief.mjs'
const execute = promisify(execFile)
const args = process.argv.slice(2)
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback
const repository = fileURLToPath(new URL('../', import.meta.url))
const target = path.resolve(option('--target', process.cwd()))
const ref = option('--baseline-ref', 'HEAD')
const baselineRef = (await execute('git', ['rev-parse', ref], { cwd: repository })).stdout.trim()
const names = ['gusta-start', 'gusta-implement-task', 'gusta-manage-work']
const entries = {}
for (const name of names) {
  const file = `skills/${name}/SKILL.md`
  entries[name] = { before: (await execute('git', ['show', `${ref}:${file}`], { cwd: repository })).stdout, after: await readFile(path.join(repository, file), 'utf8') }
}
const state = await readFile(path.join(target, 'spec/STATE.md'), 'utf8')
const format = await readFile(path.join(target, 'spec/FORMAT.md'), 'utf8')
const status = JSON.stringify(await vibeStatus({ targetRoot: target, tag: 'measure', fetch: false }))
const excerpt = JSON.stringify(await vibeFormat({ section: 'task' }))
entries.state = { before: state, after: status }
entries.format = { before: format, after: excerpt }
entries.taskSession = {
  before: entries['gusta-start'].before + entries['gusta-implement-task'].before + state + format,
  after: entries['gusta-start'].after + entries['gusta-implement-task'].after + status + excerpt,
}
const measured = {}
for (const [name, versions] of Object.entries(entries)) {
  measured[name] = {}
  for (const [version, text] of Object.entries(versions)) measured[name][version] = { chars: [...text].length, bytes: Buffer.byteLength(text) }
}
if (args.includes('--tokens')) {
  // Optional measurement dependency only: production CLI has no tokenizer dependency.
  const { spawn } = await import('node:child_process')
  const tokens = await new Promise((resolve, reject) => {
    const child = spawn(option('--python', 'python3'), ['-c', 'import json,sys,tiktoken; v=json.load(sys.stdin); print(json.dumps({n:{s:{e:len(tiktoken.get_encoding(e).encode(t)) for e in ["o200k_base","cl100k_base"]} for s,t in x.items()} for n,x in v.items()}))'], { stdio: ['pipe', 'pipe', 'inherit'] })
    let output = ''; child.stdout.on('data', (chunk) => { output += chunk }); child.on('error', reject)
    child.on('close', (code) => code === 0 ? resolve(JSON.parse(output)) : reject(new Error('optional tokenizer failed: install tiktoken in a temporary Python path')))
    child.stdin.end(JSON.stringify(entries))
  })
  for (const [name, versions] of Object.entries(tokens)) for (const [version, counts] of Object.entries(versions)) Object.assign(measured[name][version], counts)
}
process.stdout.write(`${JSON.stringify({ schemaVersion: 1, baselineRef, target, systemPrompt: 'not observable; excluded on both sides', recipe: 'task session = gusta-start + gusta-implement-task + STATE/full FORMAT before; status/task FORMAT excerpt after. Task-specific brief and provider wrapper excluded. Token counts are tokenizer proxies, not Claude billing or observed maximum context.', measured }, null, 2)}\n`)
