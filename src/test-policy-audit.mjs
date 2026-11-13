import { createHash } from 'node:crypto'
import { open, lstat, realpath } from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { parseSsot } from './spec-format.mjs'

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

const supportKeys = ['product-stage', 'supported-browsers', 'supported-platforms', 'supported-app-versions', 'excluded-support', 'support-review', 'validation-baseline']
const productStages = new Set(['prototype', 'alpha', 'beta', 'production'])
const unresolved = (value) => !value || /^(?:\?|<[^>]+>|unknown|unresolved\b.*)$/i.test(value)
const noSupport = (value) => /^none(?:\b|$)/i.test(value ?? '')

function fencedLines(text) {
  const excluded = new Set()
  let fence = null
  for (const [index, line] of text.split('\n').entries()) {
    const trimmed = line.trim(), marker = [String.fromCharCode(96), '~'].find((char) => trimmed.startsWith(char.repeat(3)))
    if (fence || marker) excluded.add(index + 1)
    if (!marker) continue
    let width = 0
    while (trimmed[width] === marker) width++
    if (!fence) fence = { marker, width }
    else if (fence.marker === marker && width >= fence.width && !trimmed.slice(width).trim()) fence = null
  }
  return excluded
}

function supportRecommendation(stage, fields) {
  if (!stage) return null
  const early = stage === 'prototype' || stage === 'alpha', platforms = fields['supported-platforms'] ?? ''
  const web = /\b(?:web|browser)\b|웹/i.test(platforms)
  const nonWeb = /\b(?:api|cli|server|backend|native|mobile|desktop|android|ios|macos|windows)\b/i.test(platforms)
  const native = /\b(?:native|mobile|desktop|android|ios)\b/i.test(platforms) || (!!fields['supported-app-versions'] && !noSupport(fields['supported-app-versions']))
  const browsers = fields['supported-browsers'], names = [...new Set(browserNames(browsers).map(canonicalBrowser))]
  return { proposalOnly: true, preserveDeclaredSupport: true,
    compatibility: early ? 'no-broad-matrix-by-default' : 'declared-support-in-ci',
    browsers: !unresolved(browsers) ? (noSupport(browsers) ? [] : names.length ? names : null) : early && web ? ['chrome'] : nonWeb && !web ? [] : null,
    platforms: fields['supported-platforms'] ?? null,
    appVersions: fields['supported-app-versions'] ?? (early && native ? 'current-client' : null),
    review: fields['support-review'] ?? (early ? 'before-beta-or-first-external-users' : stage === 'beta' ? 'before-production' : 'agree-support-review') }
}

// Only a current decided ARCH block can supply the new product policy. Nothing here
// promotes a recommendation or an observed legacy line into an approved decision.
function readProductSupport(documents) {
  const declarations = [], issues = []
  for (const { source, doc } of documents) {
    const excluded = fencedLines(source.text)
    if (source.truncated) issues.push('partial-policy-source')
    if (doc.duplicates.length) issues.push('duplicate-arch-decisions')
    for (const block of [...doc.decisions.values(), ...doc.malformed]) {
      const approved = block.domain === 'ARCH' && block.status === 'decided'
      if (excluded.has(block.start) || !approved && block.id !== null) continue
      const fields = {}, references = [], duplicates = []
      for (const [index, line] of block.text.split('\n').entries()) {
        if (excluded.has(block.start + index)) continue
        const match = line.match(/^  - ([a-z-]+):\s*(.*)$/i), key = match?.[1].toLowerCase()
        if (!supportKeys.includes(key)) continue
        let value = match[2].trim()
        if (value.startsWith(String.fromCharCode(96)) && value.endsWith(String.fromCharCode(96))) value = value.slice(1, -1).trim()
        if (Object.hasOwn(fields, key)) duplicates.push('duplicate-field:' + key)
        else fields[key] = value
        references.push({ ...reference(source, block.start + index), decision: block.id, field: key })
      }
      if (Object.keys(fields).length) {
        if (approved) declarations.push({ fields, references, duplicates })
        else issues.push('malformed-support-decision')
      }
    }
  }
  if (declarations.length > 1) issues.push('multiple-approved-support-decisions')
  const chosen = declarations.length === 1 ? declarations[0] : null
  if (chosen) issues.push(...chosen.duplicates)
  const stageValue = chosen?.fields['product-stage']?.toLowerCase() ?? null
  if (chosen && !productStages.has(stageValue)) issues.push('invalid-or-missing-product-stage')
  const declared = !!chosen && !issues.length
  const stage = declared ? stageValue : null
  const fields = declared ? Object.fromEntries(Object.entries(chosen.fields).filter(([key]) => key !== 'product-stage')) : {}
  const missing = declared ? supportKeys.filter((key) => unresolved(chosen.fields[key])) : [...supportKeys]
  return { declared, complete: declared && !missing.length, stage, fields,
    sources: declarations.flatMap((entry) => entry.references), missing, issues: [...new Set(issues)],
    recommendation: supportRecommendation(stage, fields) }
}

function legacyBrowserLines(source, doc) {
  const lines = source.text.split('\n'), firstSection = lines.findIndex((line) => /^##\s+/.test(line))
  const selected = lines.slice(0, firstSection < 0 ? lines.length : firstSection).map((text, index) => ({ text, line: index + 1 }))
  for (const block of doc.decisions.values()) if (block.domain === 'ARCH' && block.status === 'decided') {
    selected.push(...block.text.split('\n').map((text, index) => ({ text, line: block.start + index })))
  }
  const constraints = doc.sections.get('constraints')
  if (constraints) selected.push(...lines.slice(constraints.start, constraints.end).map((text, index) => ({ text, line: constraints.start + index + 1 })))
  const excluded = fencedLines(source.text)
  return selected.filter((line) => !excluded.has(line.line))
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
  const documents = policies.filter((source) => source.path === 'spec/ssot/ARCH.md').map((source) => {
    const excluded = fencedLines(source.text)
    const current = source.text.split('\n').map((line, index) => excluded.has(index + 1) ? '' : line).join('\n')
    return { source, doc: parseSsot(current) }
  })
  const productSupport = readProductSupport(documents), supported = new Set(), supportSources = []
  const browserWindow = productSupport.fields['supported-browsers']
  const canonicalBrowsers = productSupport.declared && !unresolved(browserWindow) && (noSupport(browserWindow) || browserNames(browserWindow).length > 0)
  if (canonicalBrowsers) {
    if (!noSupport(browserWindow)) browserNames(browserWindow).forEach((name) => supported.add(canonicalBrowser(name)))
    supportSources.push(...productSupport.sources.filter((source) => source.field === 'supported-browsers'))
  } else for (const { source, doc } of documents) for (const line of legacyBrowserLines(source, doc)) if (/supported\s+browsers?|지원\s*브라우저/i.test(line.text)) {
    const mentioned = browserNames(line.text)
    if (mentioned.length) { mentioned.forEach((name) => supported.add(canonicalBrowser(name))); supportSources.push(reference(source, line.line)) }
  }
  if (productSupport.recommendation && supported.size) productSupport.recommendation.browsers = [...supported]
  if (!productSupport.declared || productSupport.missing.some((key) => key !== 'validation-baseline')) unknowns.push('Product stage/support is missing, incomplete or ambiguous. Recommend and choose it in one current decided ARCH block before implementation; preserve existing support until that choice.')
  if (productSupport.missing.includes('validation-baseline')) unknowns.push('Resolve actual validation versions before verification and freeze that baseline for the candidate; this is not a new support-policy choice.')
  if (!supported.size && !canonicalBrowsers) unknowns.push('Supported browsers are not machine-readable here. Confirm the selected product targets; API/CLI/native-only products do not gain browser work by default.')
  for (const source of configurations) {
    const mentioned = browserNames(source.text)
    if (mentioned.length > 1) add('browser-matrix', 'move-ci', 'Review browser compatibility only in CI and retain only explicitly supported browsers; names are source observations, not an executed configuration.', [reference(source)], { observedBrowsers: mentioned, outsideDeclaredSupport: canonicalBrowsers || supported.size ? mentioned.filter((name) => !supported.has(canonicalBrowser(name))) : null })
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
    productSupport,
    supportedBrowsers: { declared: canonicalBrowsers || supported.size ? [...supported] : null, recommended: canonicalBrowsers || supported.size ? [...supported] : productSupport.recommendation?.browsers ?? null, sources: supportSources },
    checks: checkRows, candidates, timings: { available: timings.available === true, checksWithSamples: checkRows.filter((row) => row.timing).length }, unknowns }
}
