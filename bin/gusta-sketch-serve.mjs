#!/usr/bin/env node
import { sketchServeMain } from '../src/vibe-sketch.mjs'
try { await sketchServeMain(process.argv.slice(2)) }
catch (error) { process.stderr.write(`${error.stack ?? error.message}\n`); process.exit(1) }
