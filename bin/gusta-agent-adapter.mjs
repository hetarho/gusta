#!/usr/bin/env node
import { executeAgentAdapter } from '../src/agent-adapter.mjs'
import { LIMIT_EXIT, failureLine } from '../src/provider-limits.mjs'

try {
  const args = process.argv.slice(2)
  const options = {}
  while (args.length) {
    const key = args.shift()
    if (!['--provider', '--model', '--effort', '--provider-flag'].includes(key) || !args[0]) throw new Error('adapter: --provider codex|claude [--model name] [--effort level] [--provider-flag flag ...]')
    // The host passes only optional flags it found in the installed CLI's --help.
    if (key === '--provider-flag') (options.flags ??= []).push(args.shift())
    else options[key.slice(2)] = args.shift()
  }
  let input = ''
  for await (const chunk of process.stdin) {
    input += chunk
    if (input.length > 1024 * 1024) throw new Error('adapter input exceeded 1 MiB')
  }
  const result = await executeAgentAdapter({ ...options, job: JSON.parse(input) })
  process.stdout.write(`${JSON.stringify(result)}\n`)
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  // A usage or rate limit, an overload or a sign-in failure: one {"failure":{...}} line and its own exit
  // code, so the host moves the unit to another combination instead of counting a failed attempt.
  if (error.failure) process.stdout.write(`${failureLine(error.failure)}\n`)
  process.exitCode = error.failure ? LIMIT_EXIT : 1
}
