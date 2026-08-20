import { defineConfig } from 'vitest/config'

/**
 * Unit tests only, and only for logic that runs without Electron: the agent
 * state machine, the loop guard, the approval policy, context budgeting, and
 * the pure helpers behind the file tools. Anything that needs a real SSH
 * session or a browser DOM is out of scope here on purpose.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts']
  }
})
