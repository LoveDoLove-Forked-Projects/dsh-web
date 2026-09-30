/**
 * Host half of the GitHub provider extension: the configuration an operator
 * writes in a profile patch, and the lifecycle seam a mount takes.
 */
import { describe, expect, it } from 'vitest'
import { Config, DEFAULT_TOKEN_ENV, PACKAGE_NAME, apply, readConfigField, resolveProviderSettings } from '../src/index.ts'

/**
 * Host context double that records the effects one mount registers and hands
 * back their disposers, the way cordis runs an effect immediately and treats
 * the return value as the fiber disposer.
 */
function context() {
  const labels: string[] = []
  const disposers: Array<() => void> = []
  const ctx = {
    effect: (callback: () => unknown, label?: string) => {
      if (label !== undefined) labels.push(label)
      const dispose = callback()
      if (typeof dispose === 'function') disposers.push(dispose as () => void)
      return dispose
    },
  }
  return { ctx, labels, disposers }
}

describe('task-board GitHub extension configuration', () => {
  it('operator leaving the extension unconfigured gets the documented defaults', () => {
    // Given a profile entry that declares no configuration at all
    // When the schema applies its defaults
    const resolved = Config({})
    // Then the extension is on, silent, and reads the standard token variable
    expect(readConfigField(resolved.enabled, false)).toBe(true)
    expect(readConfigField(resolved.announceToAgent, true)).toBe(false)
    expect(resolved.tokenEnv).toBe(DEFAULT_TOKEN_ENV)
    expect(resolved.repositories).toEqual([])
  })

  it('operator naming a repository gets every repository field defaulted', () => {
    // Given a profile entry that names one repository and nothing else
    // When the schema resolves that repository
    const repository = Config({ repositories: [{ owner: 'deepseek-ai', repository: 'dsh' }] }).repositories![0]!
    // Then every optional field carries its documented default
    expect(repository).toMatchObject({
      inclusionLabel: 'dsh',
      managedLabelPrefix: 'dsh:',
      prPhaseLabel: 'dsh:phase:pr',
      pollingIntervalMs: 300_000,
      prCreationEnabled: false,
      draftPrPolicy: 'draft',
      closeIssueOnMerge: true,
      baseBranch: 'main',
    })
    expect(repository.stateLabels).toEqual({
      backlog: 'dsh:state:backlog',
      todo: 'dsh:state:todo',
      running: 'dsh:state:running',
      done: 'dsh:state:done',
      failed: 'dsh:state:failed',
    })
  })

  it('operator pinning repository values keeps them instead of the defaults', () => {
    // Given a profile entry that pins the fields it cares about
    // When the schema resolves that repository
    const repository = Config({
      repositories: [{ owner: 'octo', repository: 'demo', inclusionLabel: 'board', prCreationEnabled: true, draftPrPolicy: 'ready', baseBranch: 'dev' }],
    }).repositories![0]!
    // Then the pinned values survive and only the rest falls back
    expect(repository).toMatchObject({ inclusionLabel: 'board', prCreationEnabled: true, draftPrPolicy: 'ready', baseBranch: 'dev' })
    expect(repository.pollingIntervalMs).toBe(300_000)
  })

  it('operator toggling the switch after activation is followed without a remount', () => {
    // Given a mounted row whose master switch the Loader commits in place
    let live = true
    const mounted = { ...Config({}), enabled: { get: () => live } }
    // When the switch flips off after the activation captured its config
    live = false
    // Then the effective settings report the live value, not the capture
    expect(resolveProviderSettings(mounted as never).enabled).toBe(false)
  })

  it('operator disabling the extension mounts no provider lifecycle', () => {
    // Given a disabled profile entry
    const disabled = context()
    // When the host mounts it
    apply(disabled.ctx as never, Config({ enabled: false }))
    // Then no lifecycle seam was registered at all
    expect(disabled.labels).toEqual([])
    // And releasing the row frees the package name for the next mount
    for (const dispose of disabled.disposers.splice(0)) dispose()
  })

  it('operator mounting the same package twice keeps one lifecycle, released by its disposer', () => {
    // Given an enabled profile entry mounted once
    const harness = context()
    apply(harness.ctx as never, Config({ enabled: true }))
    // When the same package name mounts a second time (aggregate row plus a standalone link)
    apply(harness.ctx as never, Config({ enabled: true }))
    // Then the refused mount queued instead of registering a second lifecycle
    expect(harness.labels).toEqual(['task-board-github: provider lifecycle placeholder'])
    // And releasing the holder lets the next mount take the seam again
    for (const dispose of harness.disposers.splice(0)) dispose()
    apply(harness.ctx as never, Config({ enabled: true }))
    expect(harness.labels).toEqual([
      'task-board-github: provider lifecycle placeholder',
      'task-board-github: provider lifecycle placeholder',
    ])
  })

  it('operator opening the settings page gets the switch served as live-editable', () => {
    // Given the Config schema the Host serves as this entry's settings page
    const dict = (Config as unknown as { dict?: Record<string, { meta?: { volatile?: boolean } }> }).dict ?? {}
    // When the two card fields' schema nodes are read
    // Then both are volatile, which is what a settings write is fenced on
    expect(dict.enabled?.meta?.volatile).toBe(true)
    expect(dict.announceToAgent?.meta?.volatile).toBe(true)
  })

  it('operator reading the published package identity gets the bundle this patch names', () => {
    // Given the package identity the host guard keys on
    // When the bundle name is compared with the patch row's own name
    // Then the two agree, so an aggregate and a standalone install dedupe
    expect(PACKAGE_NAME).toBe('@linxin666/dsh-client-ui-task-board-github')
  })
})
