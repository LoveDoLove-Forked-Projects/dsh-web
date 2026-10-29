/**
 * Standalone build config for the task-board team provider extension.
 *
 * Uses the repository's shared client-bundle preset: the node-half lib/ plus
 * the browser bundle lib/client.js (the closure-factory artifact the GUI's
 * __ModuleLoader__ executes, with CSS Modules inlined).
 */
import { clientBundle } from '../../shared/tsdown.client.ts'

export default clientBundle('@linxin666/dsh-client-ui-task-board-team', ['src/index.ts'], {
  libExternal: [
    '@deepseek-ai/dsh-client-locale',
    '@deepseek-ai/dsh-client-ui-settings',
    '@deepseek-ai/dsh-client-ui-slots',
    '@deepseek-ai/dsh-tools',
    '@deepseek-ai/dsh-llm',
    '@deepseek-ai/dsh-credentials',
  ],
})
