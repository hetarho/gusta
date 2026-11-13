import { vibeLoop as runLoop } from '../../src/vibe-loop.mjs'
import { runVibeCheck as runCheck } from '../../src/vibe-check.mjs'
import { vibePush as push } from '../../src/vibe.mjs'
import { vibeTask as task } from '../../src/vibe-task.mjs'

// These existing unit fixtures exercise loop/check/task behavior in their deliberate checkout.
// Policy is an explicit dependency here; real branch/worktree and remote fencing defaults are
// covered by session-workspace and integration-gate tests without these adapters.
export const unitWorkspace = async ({ targetRoot }) => ({ root: targetRoot })
const acceptedIntegration = async () => ({ ok: true })
export const vibeLoop = (options, injected = {}) => runLoop(options, { prepareWorkspace: unitWorkspace, integration: null, ...injected })
export const runVibeCheck = (options, command, injected = {}) => runCheck(options, command, { integration: acceptedIntegration, ...injected })
export const vibePush = (options, injected = {}) => push(options, { integration: null, ...injected })
export const vibeTask = (options, injected = {}) => task(options, { assertImplementationWorkspace: async () => ({ ok: true }), ...injected })
