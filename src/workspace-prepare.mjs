// What a worktree the CLI creates needs before its checks can run — dependencies a lockfile pins,
// generated code: the ARCH verification decision's `prepare` commands, run once in that worktree.
// A failure is the environment's (or the prepare command's), never the implementation's.
import { spawn } from 'node:child_process'

// A check runs as its own process group, so a stop or timeout ends everything it started
// (`npm test` → node workers), not only the shell: exec signals /bin/sh alone, and a shell that
// forks its command (dash does) leaves that command running. Settles once every output holder
// has exited; only bounded tails stay in memory.
export function runCheckCommand(command, { cwd, env, timeout = 0, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { cwd, env, shell: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
    const out = { stdout: '', stderr: '' }
    const keep = (name) => (chunk) => { out[name] = (out[name] + chunk).slice(-16000) }
    child.stdout.setEncoding('utf8').on('data', keep('stdout'))
    child.stderr.setEncoding('utf8').on('data', keep('stderr'))
    let reason = null, forced = null, settled = false
    const kill = (sig) => { try { process.platform === 'win32' ? child.kill(sig) : process.kill(-child.pid, sig) } catch {} }
    const clean = () => { if (!settled) { kill('SIGTERM'); forced ??= setTimeout(() => kill('SIGKILL'), 2000) } }
    const stop = (why) => { if (reason) return; reason = why; clean() }
    const onAbort = () => stop('aborted')
    const timer = timeout ? setTimeout(() => stop('timed out'), timeout) : null
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
    const settle = (code, error = null) => {
      if (settled) return
      settled = true
      clearTimeout(timer); clearTimeout(forced); signal?.removeEventListener('abort', onAbort)
      kill('SIGKILL')
      if (!error && !reason && code === 0) return resolve(out)
      reject(Object.assign(new Error(error?.message ?? (reason ? `Command ${reason}: ${command}` : `Command failed (exit ${code}): ${command}`)), out,
        { timedOut: reason === 'timed out', cancelled: reason === 'aborted' }))
    }
    child.on('exit', clean)
    child.on('error', (error) => settle(null, error))
    child.on('close', (code) => settle(code))
  })
}

const PREPARE_MS = 20 * 60 * 1000

// commands: the caller's already-read ARCH prepare list; omitted, this worktree's ARCH is read.
// Never throws for a failing command: the result says which one failed and its last lines.
export async function prepareWorkspace(root, commands, { timeoutMs = PREPARE_MS, deadline = Infinity, signal, env = process.env } = {}, injected = {}) {
  const now = injected.now ?? Date.now, end = Math.min(now() + timeoutMs, deadline)
  if (commands === undefined) {
    // Loaded on use: vibe-brief reaches the coordination modules that import this one.
    const { readVerification } = await import('./vibe-brief.mjs')
    try { commands = (await readVerification(root)).prepare ?? [] } catch (error) { return { ok: false, root, steps: [{ command: 'ARCH prepare', ok: false, error: error.message }] } }
  }
  const steps = []
  for (const command of commands) {
    const started = now(), remaining = end - started
    if (signal?.aborted || remaining <= 0) {
      steps.push({ command, ok: false, ms: 0, ...(signal?.aborted ? { cancelled: true, error: 'Workspace preparation cancelled before this command.' }
        : { timedOut: true, error: 'Workspace preparation deadline elapsed before this command.' }) })
      return { ok: false, root, steps }
    }
    try {
      await (injected.run ?? runCheckCommand)(command, { cwd: root, env: { ...env, GUSTA_TIER: 'prepare' }, timeout: remaining, signal })
      steps.push({ command, ok: true, ms: now() - started })
    } catch (error) {
      steps.push({ command, ok: false, ms: now() - started, ...(error.timedOut ? { timedOut: true } : {}), ...(error.cancelled ? { cancelled: true } : {}),
        error: error.message, tail: `${error.stderr ?? ''}\n${error.stdout ?? ''}`.trim().split('\n').slice(-8).join('\n') })
      return { ok: false, root, steps }
    }
  }
  return { ok: true, root, steps }
}

// The failed step of a prepare result, as error details.
export const prepareFailure = (prepared) => prepared.steps.filter((step) => !step.ok).map((step) => [`${step.command}: ${step.error}`, step.tail].filter(Boolean).join('\n'))
