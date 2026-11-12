#!/usr/bin/env node
import { readFile, rm } from 'node:fs/promises'
import { vibeLoop } from '../src/vibe-loop.mjs'
const file = process.argv[2]
try {
  const options = JSON.parse(await readFile(file, 'utf8'))
  await rm(file)
  const result = await vibeLoop(options)
  process.stdout.write(`${JSON.stringify(result)}\n`)
  if (!result.ok) process.exitCode = 1
} catch (error) { process.stderr.write(`${error.stack ?? error.message}\n`); process.exitCode = 1 }
