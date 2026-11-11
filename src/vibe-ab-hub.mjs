import http from 'node:http'
import { readFile, access } from 'node:fs/promises'
import { atomicJSON, processAlive } from './loop-control.mjs'

// The compare hub: one local page with every variant side by side, where the person leaves notes
// and marks a choice. It only records; adopting a variant stays `vibe ab pick` by the session.

// The screen a variant opens at: its port plus the URL path its session named (old runs: root).
export function viewPath(value) {
  const text = String(value ?? '').trim()
  if (/^https?:\/\//i.test(text)) {
    try { const url = new URL(text); return viewPath(`${url.pathname}${url.search}${url.hash}`) } catch { return '' }
  }
  if (!text || text === '/' || /\s/.test(text)) return ''
  return text.startsWith('/') ? text : `/${text}`
}
export const urlOf = (variant) => `http://localhost:${variant.port}${viewPath(variant.runs?.at(-1)?.path)}`

const EMPTY = () => ({ notes: {}, chosen: null })
export async function readFeedback(file) {
  const value = await readFile(file, 'utf8').then(JSON.parse, () => null)
  return value && typeof value === 'object' ? { notes: value.notes ?? {}, chosen: value.chosen ?? null } : EMPTY()
}

class HubError extends Error { constructor(status, message) { super(message); this.status = status } }

// Pure: the next feedback after one note or choice. An empty note removes that variant's note.
export function applyFeedback(feedback, action, body, names, at) {
  if (!body || typeof body !== 'object' || !names.includes(body.variant)) throw new HubError(400, `unknown variant: ${body?.variant}`)
  const next = { notes: { ...feedback.notes }, chosen: feedback.chosen }
  if (action === 'choose') next.chosen = { variant: body.variant, at }
  else if (action === 'note') {
    if (typeof body.note !== 'string') throw new HubError(400, 'note must be a string')
    const note = body.note.trim().slice(0, 2000)
    if (note) next.notes[body.variant] = { note, at }
    else delete next.notes[body.variant]
  } else throw new HubError(404, 'unknown action')
  return next
}

// What the page shows for each variant, from the comparison record.
export function hubModel(record, feedback, alive = processAlive) {
  return { slug: record.slug, feedback, variants: Object.entries(record.variants).map(([name, variant]) => {
    const last = variant.runs?.at(-1)
    return { name, from: variant.from ?? '', url: urlOf(variant), summary: last?.summary ?? '', view: last?.view ?? '', serving: Boolean(variant.server?.pid && alive(variant.server.pid)), exec: variant.exec ?? null }
  }) }
}

const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])

const STYLE = `:root{color-scheme:light dark;--bg:#fff;--fg:#1b1b1b;--muted:#666;--line:#d8d8d8;--accent:#0b63ce;--chosen:#1a7f37;--bad:#cf222e}
@media (prefers-color-scheme:dark){:root{--bg:#161616;--fg:#ececec;--muted:#9a9a9a;--line:#353535;--accent:#5aa2ff;--chosen:#3fb950;--bad:#f85149}}
*{box-sizing:border-box}body{margin:0;font:14px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--bg);color:var(--fg)}
header{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center;padding:8px 16px;border-bottom:1px solid var(--line)}
h1{font-size:16px;margin:0}button{font:inherit;color:inherit;background:transparent;border:1px solid var(--line);border-radius:6px;padding:4px 10px;cursor:pointer}
button[aria-pressed=true]{border-color:var(--accent);color:var(--accent)}a{color:var(--accent)}.muted{color:var(--muted)}#chosen{color:var(--chosen);font-weight:600}
main{display:grid;grid-template-columns:repeat(var(--n),minmax(320px,1fr));gap:12px;padding:12px 16px;overflow-x:auto}
.mobile main{grid-template-columns:repeat(var(--n),390px)}
section{display:flex;flex-direction:column;min-width:0;border:1px solid var(--line);border-radius:8px;overflow:hidden}
section.chosen{border-color:var(--chosen);box-shadow:0 0 0 1px var(--chosen)}
.head,.foot{display:flex;flex-direction:column;gap:4px;padding:8px 10px}.head p{margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.frame{height:72vh;overflow:hidden;background:#fff;border-block:1px solid var(--line)}iframe{display:block;border:0;transform-origin:0 0}
textarea{width:100%;min-height:56px;font:inherit;color:inherit;background:transparent;border:1px solid var(--line);border-radius:6px;padding:6px;resize:vertical}
.row{display:flex;gap:8px;align-items:center}.measure{margin:0;overflow-wrap:anywhere}.measure.bad{color:var(--bad)}`

const SCRIPT = `let width=1280
const fit=()=>document.querySelectorAll('.frame').forEach((box)=>{const frame=box.firstElementChild,scale=Math.min(1,box.clientWidth/width);frame.style.width=width+'px';frame.style.height=box.clientHeight/scale+'px';frame.style.transform='scale('+scale+')'})
document.querySelectorAll('[data-width]').forEach((button)=>button.onclick=()=>{width=Number(button.dataset.width);document.body.classList.toggle('mobile',width<600);document.querySelectorAll('[data-width]').forEach((other)=>other.setAttribute('aria-pressed',String(other===button)));fit()})
addEventListener('resize',fit);fit()
const post=(action,body)=>fetch(action,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}).then((response)=>{if(!response.ok)throw new Error(response.status);return response.json()})
document.querySelectorAll('textarea').forEach((area)=>{let timer;const state=area.closest('.foot').querySelector('.saved');area.oninput=()=>{clearTimeout(timer);state.textContent='…';timer=setTimeout(()=>post('note',{variant:area.dataset.variant,note:area.value}).then(()=>state.textContent='saved',()=>state.textContent='not saved'),500)}})
document.querySelectorAll('.choose').forEach((button)=>button.onclick=()=>post('choose',{variant:button.dataset.variant}).then((feedback)=>{const chosen=feedback.chosen.variant;document.querySelectorAll('section').forEach((section)=>section.classList.toggle('chosen',section.dataset.variant===chosen));document.getElementById('chosen').textContent='chosen: '+chosen+' — tell the session to adopt it'},()=>alert('not saved')))`

// The latest `vibe ab exec` under a frame: median, exit codes and the last output line, led by the
// command when the variants' latest measurements ran different commands (their numbers do not compare).
function measured(exec, mixed) {
  if (!exec) return ''
  const codes = exec.exitCodes ?? [], bad = codes.some((code) => code !== 0)
  return `<p class="measure${bad ? ' bad' : ''}" title="${escape(exec.command)}">${mixed ? `<code>${escape(exec.command)}</code> · ` : ''}median ${escape(exec.medianMs)} ms · exit ${escape(codes.join(','))}${exec.last ? ` · <code>${escape(exec.last)}</code>` : ''}</p>`
}

// Pure: the hub page. Every text a session wrote is escaped; frames load each variant at its view path.
export function renderHub({ slug, variants, feedback = EMPTY() }) {
  const chosen = feedback.chosen?.variant
  const mixed = new Set(variants.filter((variant) => variant.exec).map((variant) => variant.exec.command)).size > 1
  const sections = variants.map((variant) => {
    const summary = variant.summary.split('\n')[0]
    return `<section data-variant="${escape(variant.name)}"${variant.name === chosen ? ' class="chosen"' : ''}>
<div class="head"><div class="row"><strong>${escape(variant.name)}</strong>${variant.from ? `<span class="muted">from ${escape(variant.from)}</span>` : ''}<a href="${escape(variant.url)}" target="_blank" rel="noopener">open in new tab ↗</a>${variant.serving ? '' : '<span class="muted">not serving</span>'}</div>
<p title="${escape(variant.summary)}">${escape(summary) || '<span class="muted">no run yet</span>'}</p>${variant.view ? `<p class="muted" title="${escape(variant.view)}">view: ${escape(variant.view)}</p>` : ''}</div>
<div class="frame"><iframe src="${escape(variant.url)}" title="variant ${escape(variant.name)}"></iframe></div>
<div class="foot">${measured(variant.exec, mixed)}<textarea data-variant="${escape(variant.name)}" placeholder="note for ${escape(variant.name)}">${escape(feedback.notes?.[variant.name]?.note ?? '')}</textarea>
<div class="row"><button class="choose" data-variant="${escape(variant.name)}">choose ${escape(variant.name)}</button><span class="saved muted"></span></div></div>
</section>`
  }).join('\n')
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>A/B ${escape(slug)}</title><style>${STYLE}</style></head>
<body><header><h1>A/B · ${escape(slug)}</h1><div class="row"><button data-width="1280" aria-pressed="true">desktop</button><button data-width="390" aria-pressed="false">mobile 390</button></div>
<span class="muted">A blank frame means the app blocks framing: use “open in new tab”.</span>
<span id="chosen">${chosen ? `chosen: ${escape(chosen)} — tell the session to adopt it` : ''}</span></header>
<main style="--n:${variants.length}">
${sections}
</main><script>${SCRIPT}</script></body></html>
`
}

async function readBody(request, limit) {
  const chunks = []
  let size = 0
  // Read to the end even past the limit, so the 413 reaches a client that is still sending.
  for await (const chunk of request) { size += chunk.length; if (size <= limit) chunks.push(chunk) }
  if (size > limit) throw new HubError(413, 'body too large')
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new HubError(400, 'body must be JSON') }
}

// Every request reads the record again, so reruns and restarts show without restarting the hub.
// POSTs must be JSON: a cross-origin page cannot send that without a preflight this hub never allows.
// Only loopback Host names are served, so a rebound DNS name cannot reach the hub.
function hubHandler({ recordFile, feedbackFile, alive = processAlive, now = () => new Date().toISOString() }) {
  let queue = Promise.resolve()
  return async (request, response) => {
    const send = (status, type, body) => { response.writeHead(status, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' }); response.end(body) }
    try {
      const port = request.socket.localPort
      if (![`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`].includes(String(request.headers.host ?? '').toLowerCase())) return send(403, 'text/plain', 'unexpected host\n')
      const record = await readFile(recordFile, 'utf8').then(JSON.parse, () => null)
      if (!record) return send(410, 'text/plain', 'This comparison has ended.\n')
      const route = new URL(request.url, 'http://hub').pathname
      if (request.method === 'GET' && route === '/') return send(200, 'text/html', renderHub(hubModel(record, await readFeedback(feedbackFile), alive)))
      const action = request.method === 'POST' ? { '/note': 'note', '/choose': 'choose' }[route] : null
      if (!action) return send(404, 'text/plain', 'not found\n')
      if (!String(request.headers['content-type'] ?? '').startsWith('application/json')) return send(415, 'text/plain', 'JSON only\n')
      const body = await readBody(request, 16 * 1024)
      // One write at a time: two quick notes must not drop each other.
      const next = queue.then(async () => {
        const updated = applyFeedback(await readFeedback(feedbackFile), action, body, Object.keys(record.variants), now())
        await atomicJSON(feedbackFile, updated)
        return updated
      })
      queue = next.catch(() => {})
      return send(200, 'application/json', JSON.stringify(await next))
    } catch (error) { send(error.status ?? 500, 'text/plain', `${error.message}\n`) }
  }
}
export const createHub = (options) => http.createServer(hubHandler(options))

const listen = (server, port, host) => new Promise((resolve, reject) => {
  server.once('error', reject).listen(port, host, () => { server.off('error', reject); resolve(server) })
})
// Detached entry (bin/haeram-ab-hub.mjs): listens on a free port and tells the CLI which. `localhost`
// may resolve to ::1 first, so the same port answers on both loopbacks (127.0.0.1 only without IPv6).
// It exits by itself once the comparison record is gone (picked or removed).
export async function hubMain([recordFile, feedbackFile, readyFile], { exit = (code) => process.exit(code), checkMs = 30000 } = {}) {
  const handler = hubHandler({ recordFile, feedbackFile })
  let servers = null
  for (let attempt = 1; !servers; attempt++) {
    const first = await listen(http.createServer(handler), 0, '127.0.0.1')
    const second = await listen(http.createServer(handler), first.address().port, '::1').catch((error) => error)
    if (!(second instanceof Error)) servers = [first, second]
    else if (['EADDRNOTAVAIL', 'EAFNOSUPPORT'].includes(second.code) || attempt >= 5) servers = [first]
    else first.close()
  }
  const port = servers[0].address().port
  await atomicJSON(readyFile, { pid: process.pid, port })
  const timer = setInterval(() => access(recordFile).catch(() => exit(0)), checkMs)
  timer.unref()
  return { port, close: () => { clearInterval(timer); for (const server of servers) server.close() } }
}
