import { readFile, readdir } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { inspectWorkspace, git } from './workspace.mjs'
import { SkillPackageError } from './errors.mjs'

const execute = promisify(execFile)
const pause = (ms, signal) => new Promise((resolve) => {
  const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve() }
  const timer = setTimeout(done, ms)
  signal?.addEventListener('abort', done, { once: true })
  if (signal?.aborted) done()
})
const terminal = new Set(['success', 'failure', 'cancelled', 'skipped', 'neutral', 'timed_out', 'action_required', 'stale', 'startup_failure'])
const success = new Set(['success', 'skipped', 'neutral'])
const decode = (text) => text.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()

export function githubRepository(url) {
  const match = (url ?? '').trim().match(/(?:github\.com[:/])([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/)
  return match ? `${match[1]}/${match[2]}` : null
}

// Conservative subset of Actions globbing. Unsupported syntax returns unknown;
// never skip a required gate because of an approximate path match.
function glob(pattern, file) {
  if (/[{}[\]\\+]/.test(pattern)) return null
  let source = ''
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]
    if (char === '*' && pattern[i + 1] === '*') {
      i++
      if (pattern[i + 1] === '/') { source += '(?:.*/)?'; i++ } else source += '.*'
    } else if (char === '*') source += '[^/]*'
    else if (char === '?') source += '[^/]'
    else source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${source}$`).test(file)
}

export function workflowPathsSkipped(yaml, files) {
  if (!files.length) return null
  // Only the push event matters for this command; PR filters must not skip push CI.
  const lines = yaml.split(/\r?\n/)
  const push = lines.findIndex((line) => /^\s+push:\s*(?:#.*)?$/.test(line))
  if (push < 0) return null
  const indent = lines[push].match(/^ */)[0].length
  const body = []
  for (const line of lines.slice(push + 1)) {
    if (line.trim() && line.match(/^ */)[0].length <= indent) break
    body.push(line)
  }
  const filter = body.findIndex((line) => /^\s+paths(?:-ignore)?:/.test(line))
  if (filter < 0) return false
  const ignored = /paths-ignore:/.test(body[filter])
  const inline = body[filter].split(':').slice(1).join(':').trim()
  const patterns = []
  if (inline.startsWith('[') && inline.endsWith(']')) patterns.push(...inline.slice(1, -1).split(',').map((s) => s.trim()))
  else if (inline && !inline.startsWith('#')) return null
  else {
    const level = body[filter].match(/^ */)[0].length
    for (const line of body.slice(filter + 1)) {
      if (!line.trim() || line.trim().startsWith('#')) continue
      if (line.match(/^ */)[0].length <= level) break
      const match = line.match(/^\s+-\s+(.+?)\s*$/)
      if (!match) return null
      patterns.push(match[1])
    }
  }
  if (!patterns.length) return null
  const cleaned = patterns.map((s) => s.replace(/^(['"])(.*)\1$/, '$2'))
  if (cleaned.some((s) => s.startsWith('!') || /[#&]|\$\{/.test(s))) return null
  const matches = files.map((file) => cleaned.map((pattern) => glob(pattern, file)))
  if (matches.flat().includes(null)) return null
  return ignored ? matches.every((row) => row.some(Boolean)) : matches.every((row) => !row.some(Boolean))
}

export function publicJobs(html, repo) {
  const jobs = new Map()
  for (const match of html.matchAll(/href=["']([^"']*\/actions\/runs\/\d+\/job\/\d+[^"']*)["']/g)) {
    const target = new URL(match[1], 'https://github.com')
    if (target.origin !== 'https://github.com' || !target.pathname.startsWith(`/${repo}/actions/runs/`)) continue
    const url = target.href.split('?')[0]
    const label = html.slice(match.index + match[0].length, match.index + match[0].length + 300).replace(/^[^>]*>/, '').split('</a>')[0]
    jobs.set(url, { url, name: decode(label) || url.split('/').at(-1) })
  }
  return [...jobs.values()]
}

export function publicJobResult(html, job) {
  const header = html.match(/<[^>]*data-job-status=["'][^"']+["'][^>]*>/)?.[0] ?? ''
  const attr = (name) => header.match(new RegExp(`data-${name}=["']([^"']+)["']`))?.[1]?.toLowerCase()
  const status = attr('job-status') ?? 'unknown'
  // github.com puts the job result only in the job header text ("succeeded/failed
  // <time> in 4m"), not as an attribute. Step conclusions alone are not evidence
  // (continue-on-error), so an unrecognised header keeps the job pending.
  const summary = decode(html.match(/data-url=["'][^"']*\/runs\/\d+\/header["'][^>]*>([\s\S]*?)<\/span>/)?.[1] ?? '').toLowerCase()
  const word = summary.match(/\b(succeeded|failed|cancell?ed|skipped|timed out)\b/)?.[1]
  const said = { succeeded: 'success', failed: 'failure', cancelled: 'cancelled', canceled: 'cancelled', skipped: 'skipped', 'timed out': 'timed_out' }[word]
  const value = attr('conclusion') ?? attr('job-conclusion') ?? said ?? (terminal.has(status) ? status : null)
  const conclusion = (status === 'completed' || terminal.has(status)) && terminal.has(value) ? value : null
  const failedSteps = []
  for (const match of html.matchAll(/<[^>]+(?:data-conclusion=["']failure["']|aria-label=["'][^"']*(?:failed|failure)[^"']*["'])[^>]*>/gi)) {
    const tag = match[0]
    const name = tag.match(/(?:data-step-name|data-name|aria-label)=["']([^"']+)["']/)?.[1] ?? decode(html.slice(match.index + tag.length, match.index + tag.length + 350).split('</')[0])
    // Page status icons are labelled "failed: " with no step name.
    const step = decode(name ?? '').replace(/^(?:failed|failure):\s*/i, '')
    if (step && !failedSteps.includes(step)) failedSteps.push(step)
  }
  return { ...job, status, conclusion, failedSteps }
}

export async function vibeCIWait(options = {}, injected = {}) {
  const deps = { git, execute, fetch: globalThis.fetch, sleep: pause, now: Date.now, ...injected }
  const workspace = await inspectWorkspace(options)
  const root = workspace.git?.root ?? workspace.targetRoot
  const commit = (await deps.git(root, ['rev-parse', '--verify', `${options.commit ?? 'HEAD'}^{commit}`])).trim()
  const workflowNames = await readdir(path.join(root, '.github/workflows')).catch(() => [])
  if (!workflowNames.some((name) => /\.ya?ml$/.test(name))) return { schemaVersion: 1, ok: true, outcome: 'skipped', reason: 'no-workflows', commit, polls: 0, jobs: [], runs: [], runUrl: null }
  const branch = options.branch ?? workspace.git?.branch
  const url = options.repo ? null : await deps.git(root, ['remote', 'get-url', options.remote ?? 'origin']).catch(() => null)
  const repo = options.repo ?? githubRepository(url)
  // CI nobody can read never holds the work: no GitHub repository means unchecked, reported for later.
  if (!options.repo && !repo) return { schemaVersion: 1, ok: true, outcome: 'unchecked', reason: 'no-github-repo', commit, polls: 0, jobs: [], runs: [], runUrl: null, checkUrl: null }
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) throw new SkillPackageError('GitHub owner/repo를 판정하지 못했습니다. --repo로 지정하세요.')
  const timeout = Number(options.timeoutMs ?? 3600000), grace = Number(options.noRunMs ?? 120000)
  let interval = Number(options.pollMs ?? 15000)
  if (![timeout, grace, interval].every((n) => Number.isFinite(n) && n > 0)) throw new SkillPackageError('CI timeout·no-run·poll 값은 양수입니다.')
  const started = deps.now(), deadline = started + timeout
  const env = options.env ?? process.env
  let transport = 'gh', polls = 0, lastError = null, runs = [], jobs = [], discovered = false, filtered = false, readable = false
  const token = env.GITHUB_TOKEN ?? env.GH_TOKEN ?? env.GITHUB_API_TOKEN
  const request = async (address, auth = false) => {
    const timeoutSignal = AbortSignal.timeout(Math.min(30000, Math.max(1, deadline - deps.now())))
    const response = await deps.fetch(address, { headers: { Accept: auth ? 'application/vnd.github+json' : 'text/html', ...(auth ? { Authorization: `Bearer ${token}` } : {}) }, signal: options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return auth ? response.json() : response.text()
  }
  const api = async (endpoint) => {
    if (transport === 'gh') {
      try { return JSON.parse((await deps.execute('gh', ['api', endpoint], { cwd: root, env, timeout: 30000, maxBuffer: 4 * 1024 * 1024 })).stdout) }
      catch { transport = token ? 'token' : 'public-html' }
    }
    if (transport === 'token') {
      try { return await request(`https://api.github.com/${endpoint}`, true) }
      catch (error) { lastError = error.message; transport = 'public-html' }
    }
    return null
  }
  // unchecked: no transport could read CI (no gh, no token, the public page closed). The work goes
  // on (ok) and the caller reports checkUrl for the owner to look at later; it is never a pass.
  const result = (outcome, reason) => ({ schemaVersion: 1, ok: success.has(outcome) || outcome === 'unchecked', outcome, reason, commit, repo, transport, polls, ms: deps.now() - started,
    runUrl: runs[0]?.url ?? null, checkUrl: `https://github.com/${repo}/commit/${commit}`, runs, jobs, ...(lastError ? { lastError } : {}) })
  try {
    const base = options.diffBase ?? `${commit}^`
    const files = (await deps.git(root, ['diff', '--name-only', base, commit])).trim().split('\n').filter(Boolean)
    const directory = path.join(root, '.github/workflows')
    const names = (await readdir(directory)).filter((name) => /\.ya?ml$/.test(name))
    const skips = await Promise.all(names.map(async (name) => workflowPathsSkipped(await readFile(path.join(directory, name), 'utf8'), files)))
    filtered = skips.length > 0 && skips.every((value) => value === true)
  } catch { /* unknown filters: bounded no-run grace instead */ }
  if (filtered) return result('skipped', 'workflow-paths')
  while (deps.now() < deadline) {
    if (options.signal?.aborted) return result('cancelled', 'stopped')
    polls++
    try {
      const listing = await api(`repos/${repo}/actions/runs?head_sha=${commit}&per_page=100`)
      if (listing) {
        readable = true
        const entries = (listing.workflow_runs ?? []).filter((run) => run.head_sha === commit && (!branch || run.head_branch === branch))
        if ((listing.total_count ?? 0) > 100) throw new Error('more than 100 workflow runs; cannot establish complete gate')
        runs = entries.map((run) => ({ id: run.id, name: run.name, url: run.html_url, status: run.status, conclusion: run.conclusion }))
        jobs = []
        for (const run of runs) {
          let page = 1
          for (; deps.now() < deadline && !options.signal?.aborted;) {
            const data = await api(`repos/${repo}/actions/runs/${run.id}/jobs?per_page=100&page=${page}`)
            if (!data) break
            jobs.push(...(data.jobs ?? []).map((job) => ({ name: job.name, url: job.html_url, status: job.status, conclusion: job.conclusion,
              failedSteps: (job.steps ?? []).filter((step) => step.conclusion === 'failure').map((step) => step.name) })))
            if ((data.jobs?.length ?? 0) < 100) break
            page++
          }
        }
      }
      if (transport === 'public-html') {
        const html = await request(`https://github.com/${repo}/actions?query=${encodeURIComponent(`branch:${branch ?? ''}`)}`)
        readable = true
        const links = [...new Set([...html.matchAll(/href=["']([^"']*\/actions\/runs\/\d+)["']/g)].map((match) => new URL(match[1], 'https://github.com')).filter((url) => url.origin === 'https://github.com' && url.pathname.startsWith(`/${repo}/actions/runs/`)).map((url) => url.href))].slice(0, 12)
        runs = []; jobs = []
        for (const link of links) {
          const page = await request(link)
          // Verify the exact commit on the run page. A branch's old green run is
          // never evidence that the new push passed.
          if (!page.includes(commit)) continue
          const runJobs = publicJobs(page, repo)
          if (!runJobs.length) { runs.push({ url: link, status: 'unknown', conclusion: null }); continue }
          const results = []
          for (const job of runJobs) results.push(publicJobResult(await request(job.url), job))
          jobs.push(...results)
          const finished = results.every((job) => terminal.has(job.conclusion))
          runs.push({ url: link, status: finished ? 'completed' : 'in_progress', conclusion: finished ? results.every((job) => success.has(job.conclusion)) ? 'success' : 'failure' : null })
        }
      }
      if (runs.length) discovered = true
      if (runs.length && runs.every((run) => run.status === 'completed' && terminal.has(run.conclusion))) {
        return result(runs.every((run) => success.has(run.conclusion)) ? 'success' : 'failure', 'completed')
      }
      if (!discovered && deps.now() - started >= grace) return result('skipped', 'no-run-within-grace')
    } catch (error) {
      lastError = error.message
      // Never read within the grace: retrying until the deadline would hold the work for nothing.
      // A CI that was read once keeps being waited for — its outage is not a pass.
      if (!readable && deps.now() - started >= grace) return result('unchecked', 'no-ci-access')
    }
    // HTML has no API rate limit. All transports still back off; never use an
    // unauthenticated API request (60/hour) as a fallback.
    await deps.sleep(Math.min(transport === 'public-html' ? Math.max(interval, 60000) : interval, Math.max(0, deadline - deps.now())), options.signal)
    interval = Math.min(interval * 1.7, 120000)
  }
  if (!readable) return result('unchecked', 'no-ci-access')
  return result('timed_out', lastError ? 'query-error-or-timeout' : 'timeout')
}
