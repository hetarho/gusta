#!/usr/bin/env node
import { watchLoop, readJSON, loopEvent } from '../src/loop-control.mjs'
import path from 'node:path'
try { await watchLoop(process.argv[2], process.argv[3]) }
catch (error) {
  process.stderr.write(`${error.stack ?? error.message}\n`)
  const directory = process.argv[2]
  try { const state = await readJSON(path.join(directory, 'loop.json')); if (state?.runId === process.argv[3]) await loopEvent(directory, state, 'supervisor-error', { error: error.message }) } catch {}
  process.exitCode = 1
}
