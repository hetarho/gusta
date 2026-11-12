export const PACKAGE_NAME = '@haeram/gusta'
export const LOCK_FILE = '.gusta-lock.json'

export const AGENT_CONFIG = Object.freeze({
  claude: {
    root: '.claude/skills',
    include(relativePath) {
      return relativePath !== 'agents' && !relativePath.startsWith('agents/')
    },
  },
  codex: {
    root: '.codex/skills',
    include() {
      return true
    },
  },
})

