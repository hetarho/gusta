import { vibeLoop as runLoop } from '../../src/vibe-loop.mjs'
import { runVibeCheck as runCheck } from '../../src/vibe-check.mjs'
import { vibePush as push } from '../../src/vibe.mjs'
import { vibeTask as task } from '../../src/vibe-task.mjs'
import { execute } from './vibe-fixture.mjs'

// These existing unit fixtures exercise loop/check/task behavior in their deliberate checkout.
// Policy is an explicit dependency here; real branch/worktree and remote fencing defaults are
// covered by session-workspace and integration-gate tests without these adapters.
export const unitWorkspace = async ({ targetRoot }) => ({ root: targetRoot })
const acceptedIntegration = async () => ({ ok: true })
export const vibeLoop = (options, injected = {}) => runLoop(options, { prepareWorkspace: unitWorkspace, integration: null, check: runVibeCheck, push: vibePush, ...injected })
export const runVibeCheck = (options, command, injected = {}) => runCheck(options, command, { integration: acceptedIntegration, ...injected })
export const vibePush = (options, injected = {}) => push(options, { integration: null, ...injected })
export const vibeTask = (options, injected = {}) => task(options, { assertImplementationWorkspace: async () => ({ ok: true }), ...injected })

// Exercise persistence and clone-wide locks across real processes without pretending these
// command/cache units claim a distributed integration candidate through the public CLI.
export async function checkInFreshProcess(options, command, env = process.env) {
  const source = `import { runVibeCheck } from ${JSON.stringify(import.meta.url)};const {options,command}=JSON.parse(process.argv[1]);process.stdout.write(JSON.stringify(await runVibeCheck(options,command)));`
  const { stdout } = await execute(process.execPath, ['--input-type=module', '--eval', source, JSON.stringify({ options, command })], { env })
  return JSON.parse(stdout)
}
