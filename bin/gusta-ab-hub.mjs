#!/usr/bin/env node
import { hubMain } from '../src/vibe-ab-hub.mjs'
try { await hubMain(process.argv.slice(2)) }
catch (error) { process.stderr.write(`${error.stack ?? error.message}\n`); process.exit(1) }
