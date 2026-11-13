import { createHash } from 'node:crypto'
import { open, lstat, realpath } from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'

const digest = (text) => createHash('sha256').update(text).digest('hex')
const normalize = (text) => text.trim().replace(/\s+/g, ' ')
const reference = (source, line = 1) => ({ path: source.path, line })
const browserNames = (text) => [...new Set([...String(text).matchAll(/\b(chromium|chrome|firefox|webkit|safari|msedge|edge)\b/gi)].map((match) => ({ safari: 'webkit', edge: 'msedge' })[match[1].toLowerCase()] ?? match[1].toLowerCase()))]
const canonicalBrowser = (name) => name === 'chromium' ? 'chrome' : name
const invocations = (command) => [...String(command).matchAll(/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?([A-Za-z][\w:.-]*)/g)].map((match) => match[1]).filter((name) => !['ci', 'install', 'publish', 'exec', 'dlx'].includes(name))
const broad = (name, command) => /^(?:test|check|verify|test:all|test:e2e|e2e)$/.test(name) || /\b(?:playwright\s+test|cypress\s+run|go\s+test\s+\.\/\.\.\.|node\s+--test(?:\s*(?:&&|$)))/.test(command)

export function testPolicySourceKind(name) {
  const base = path.posix.basename(name)
  if (base === 'package.json') return 'package'
  if (/^(?:playwright|cypress|vitest|jest|wdio|webdriverio)\.config\./i.test(base) || /^(?:pytest\.ini|tox\.ini|Cargo\.toml|go\.mod)$/.test(base)) return 'test-config'
  if (/^\.github\/workflows\/[^/]+\.ya?ml$/i.test(name) || /^(?:\.gitlab-ci\.yml|azure-pipelines\.ya?ml)$/.test(name)) return 'ci'
  if (name === 'spec/ssot/ARCH.md') return 'policy'
  if (/(?:^|\/)(?:test_[^/]+\.py|[^/]+_test\.(?:go|py)|[^/]+\.(?:test|spec)\.[cm]?[jt]sx?)$/i.test(name)) return 'test'
  if (/\.json$/i.test(base)) return 'json'
  return null
}

// This reads only the known local timing artifact. Symlinked metadata or a large/unreadable
// artifact remains unknown; arbitrary Git metadata is neither inventoried nor returned.
export async function readAuditTimings(workspace, injected = {}) {
  if (!workspace.git) return { available: false, reason: 'no-git-runtime', entries: {} }
  const deps = { open, lstat, realpath, ...injected }, common = workspace.git.commonDir
  const directory = path.join(common, 'gusta', 'v1'), file = path.join(directory, 'timings.json')
  try {
    const guarded = async () => {
      for (const parent of [path.join(common, 'gusta'), directory]) if (await deps.realpath(parent) !== parent || !(await deps.lstat(parent)).isDirectory()) return false
      return true
    }
    if (!await guarded()) return { available: false, reason: 'runtime-boundary', entries: {} }
    const before = await deps.lstat(file)
    if (!before.isFile() || before.size > 256 * 1024) return { available: false, reason: 'timings-not-small-regular-file', entries: {} }
    const handle = await deps.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    try {
      const opened = await handle.stat()
      if (!opened.isFile() || before.dev !== opened.dev || before.ino !== opened.ino) return { available: false, reason: 'timings-changed', entries: {} }
      if (!await guarded()) return { available: false, reason: 'runtime-boundary', entries: {} }
      const text = await handle.readFile('utf8'), after = await handle.stat(), current = await deps.lstat(file)
      if (text.length > 256 * 1024 || before.size !== after.size || before.mtimeMs !== after.mtimeMs || current.ino !== before.ino || current.dev !== before.dev) return { available: false, reason: 'timings-changed', entries: {} }
      const value = JSON.parse(text)
      if (value?.schemaVersion !== 1 || !value.entries || typeof value.entries !== 'object' || Array.isArray(value.entries)) return { available: false, reason: 'invalid-timings', entries: {} }
      return { available: true, entries: value.entries }
    } finally { await handle.close() }
  } catch (error) { return { available: false, reason: error.code === 'ENOENT' ? 'not-recorded' : 'unreadable-timings', entries: {} } }
}

// An audit queue with cited observations, never a semantic verdict or deletion command.
// Source bodies, environment values and shell commands do not leave this boundary.
export function auditTestPolicy(sources, { entries = [], timings = { available: false, reason: 'not-recorded', entries: {} }, limited = false } = {}) {
  const selected = [], scripts = new Map(), plans = [], ci = [], configurations = [], tests = [], policies = []
  const candidates = [], unknowns = []
  const add = (kind, recommendation, reason, references, details = {}) => candidates.push({ id: digest(JSON.stringify([kind, references])).slice(0, 16), kind, classification: 'unknown', recommendation, reason, sources: references, ...details })
  for (const source of sources) {
    let kind = source.kind
    if (kind === 'json') {
      try { const value = JSON.parse(source.text); if (value?.schemaVersion === 1 && Array.isArray(value.checks)) { plans.push({ source, value }); kind = 'plan' } else continue } catch { continue }
    } else if (kind === 'package') {
      try {
        const value = JSON.parse(source.text)
        if (value?.scripts && typeof value.scripts === 'object') for (const [name, command] of Object.entries(value.scripts)) if (typeof command === 'string') {
          const id = `${source.path}#${name}`, line = source.text.slice(0, source.text.indexOf(JSON.stringify(name))).split('\n').length
          scripts.set(id, { id, name, command, source, line })
        }
      } catch { add('unparsed-package', 'unknown', 'The package manifest could not be parsed in the bounded audit source.', [reference(source)]) }
    } else if (kind === 'ci') ci.push(source)
    else if (kind === 'test-config') configurations.push(source)
    else if (kind === 'test') tests.push(source)
    else if (kind === 'policy') policies.push(source)
    selected.push({ path: source.path, kind, sha256: source.sha256, truncated: source.truncated === true })
  }
  const rootScripts = new Map([...scripts.values()].filter((entry) => entry.source.path === 'package.json').map((entry) => [entry.name, entry]))
  const expand = (names, seen = new Set()) => {
    for (const name of names) {
      if (seen.has(name) || !rootScripts.has(name)) continue
      seen.add(name); expand(invocations(rootScripts.get(name).command), seen)
    }
    return seen
  }
  const supported = new Set(), supportSources = []
  for (const source of policies) for (const [index, line] of source.text.split('\n').entries()) if (/supported\s+browsers?|지원\s*브라우저/i.test(line)) {
    const mentioned = browserNames(line)
    if (mentioned.length) { mentioned.forEach((name) => supported.add(canonicalBrowser(name))); supportSources.push(reference(source, index + 1)) }
  }
  if (!supported.size) unknowns.push('Supported browsers are not machine-readable here. Confirm the project policy; recommend Chrome only unless broader support is explicitly required.')
  for (const source of configurations) {
    const mentioned = browserNames(source.text)
    if (mentioned.length > 1) add('browser-matrix', 'move-ci', 'Review browser compatibility only in CI and retain only explicitly supported browsers; names are source observations, not an executed configuration.', [reference(source)], { observedBrowsers: mentioned, outsideDeclaredSupport: supported.size ? mentioned.filter((name) => !supported.has(canonicalBrowser(name))) : null })
  }
  const checkRows = [], localScripts = new Map(), ciScripts = new Map()
  const observedCi = (source, name) => { const refs = ciScripts.get(name) ?? []; refs.push(reference(source)); ciScripts.set(name, refs) }
  for (const source of ci) for (const name of expand(invocations(source.text))) observedCi(source, name)
  for (const { source, value } of plans) for (const check of value.checks) {
    if (!check || typeof check.id !== 'string' || typeof check.command !== 'string') { add('unparsed-plan-check', 'unknown', 'Review the executable plan schema and actual check coverage.', [reference(source)]); continue }
    const command = normalize(check.command), names = [...expand(invocations(command))]
    if (check.tier !== 'ci') for (const name of names) { const refs = localScripts.get(name) ?? []; refs.push(reference(source)); localScripts.set(name, refs) }
    const sample = Object.entries(timings.entries ?? {}).find(([key]) => normalize(key.split('\0').slice(1).join('\0')) === command)?.[1]?.samples
    const milliseconds = Array.isArray(sample) ? sample.filter((ms) => Number.isFinite(ms) && ms >= 0) : []
    checkRows.push({ id: check.id, tier: check.tier ?? 'unknown', source: reference(source), inputDeclaration: Array.isArray(check.inputs) ? 'explicit' : 'whole-tree', commandFingerprint: digest(command), scripts: names, timing: milliseconds.length ? { samples: milliseconds.length, totalMs: milliseconds.reduce((sum, ms) => sum + ms, 0), maxMs: Math.max(...milliseconds) } : null })
    if (check.tier !== 'ci' && /\b(?:playwright|cypress|webdriver|selenium)\b/i.test([command, ...names.map((name) => rootScripts.get(name)?.command ?? '')].join(' '))) add('local-browser-check', 'move-ci', 'Inspect this local browser/E2E check: compatibility belongs in CI; selected interaction scenarios may instead use agent acceptance after removing duplicate automated coverage.', [reference(source)])
  }
  for (const [name, refs] of ciScripts) {
    const script = rootScripts.get(name)
    if (!script || !broad(name, script.command)) continue
    const distinct = [...new Map(refs.map((ref) => [ref.path, ref])).values()]
    if (distinct.length > 1) add('repeated-ci-check', 'narrow', 'Several workflows invoke the same broad script. Review reuse of successful evidence for the same immutable candidate instead of executing it again.', [reference(script.source, script.line), ...distinct], { script: name })
    if (localScripts.has(name)) add('local-ci-overlap', 'narrow', 'The same broad script is selected locally and in CI. Assign one primary owner/stage and preserve any explicitly required independent coverage.', [reference(script.source, script.line), ...localScripts.get(name), ...distinct], { script: name })
  }
  for (const source of tests) if (/\b(?:readFile|readFileSync)\b/.test(source.text) && /(?:assert\.(?:match|equal|deepEqual)|\.(?:toContain|toMatch)\(|\.includes\()/.test(source.text)) add('source-assertion-review', 'unknown', 'This sampled test reads files and asserts text or structure. Inspect whether it protects a real contract or merely mirrors implementation before narrowing it.', [reference(source)])
  if (tests.length) unknowns.push('Representative test snippets only identify review candidates; inspect behavior, contracts and replacement evidence before deleting or rewriting tests.')
  if (!plans.length) unknowns.push('No structured executable check plan was found in captured sources; map actual local and CI commands before claiming complete coverage.')
  unknowns.push('Agent/E2E replacement allocation needs semantic review of acceptance criteria and actual script expansion; absent machine-readable evidence is not proof of no duplication.')
  if (!timings.available) unknowns.push(`Measured check duration is unavailable (${timings.reason ?? 'unknown'}); do not invent test cost or savings.`)
  if (limited || selected.some((source) => source.truncated)) unknowns.push('The bounded source capture is partial; read the cited originals and remaining relevant files.')
  return { schemaVersion: 1, required: true, policyReviewed: false, sourceComplete: !limited && !selected.some((source) => source.truncated),
    sources: selected, counts: { testFiles: entries.filter((entry) => entry.disposition === 'candidate' && testPolicySourceKind(entry.path) === 'test').length, sampledTests: tests.length, scripts: scripts.size, plans: plans.length },
    supportedBrowsers: { declared: supported.size ? [...supported] : null, recommended: ['chrome'], sources: supportSources },
    checks: checkRows, candidates, timings: { available: timings.available === true, checksWithSamples: checkRows.filter((row) => row.timing).length }, unknowns }
}
