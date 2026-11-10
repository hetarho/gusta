#!/usr/bin/env node
import { workRunHost } from '../src/work-runner.mjs'
try {
  const result = await workRunHost(process.argv[2])
  if (result.ok === false) process.exitCode = 1
} catch (error) { process.stderr.write(`${error.stack ?? error.message}\n`); process.exitCode = 1 }
