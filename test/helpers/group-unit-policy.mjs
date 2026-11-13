import { finishWork as finish } from '../../src/work-groups.mjs'

// These units exercise per-group verification/cache bookkeeping. Actual default shared
// completion and nested-session handoff are covered without this explicit dependency.
export const finishWork = (options, injected = {}) => finish(options, { integration: null, ...injected })
