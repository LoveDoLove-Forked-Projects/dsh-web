/**
 * Host half of the GitHub provider extension: the configuration an operator
 * writes in a profile patch, and the lifecycle a mount takes.
 *
 * The repository schema itself is pinned by `github-config.spec.ts`; the cases
 * here own the two volatile switches and the single-instance lifecycle.
 */
import { describe, expect, it } from 'vitest'
import type { TaskBoardExtension, TaskBoardHostFace } from '../src/core/contract.ts'
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
    on: () => () => {},
  }
  return { ctx, labels, disposers }
}

/**
 * Host context double that also serves the board's registration face, so a
 * mount can admit its provider the way the real board does.
 */
function servingContext() {
  const registered: TaskBoardExtension[] = []
  const disposers: Array<() => void> = []
  const face: TaskBoardHostFace = {
    registerExtension(extension) {
      registered.push(extension)
      return () => {
        const index = registered.indexOf(extension)
        if (index !== -1) registered.splice(index, 1)
      }
    },
    isExtensionEnabled: () => registered.length > 0,
  }
  return {
    registered,
    /** Release this mount, so the next case starts from an unmounted process. */
    release: () => { for (const dispose of disposers.splice(0)) dispose() },
    ctx: {
      get: (name: string) => (name === 'taskBoard' ? face : undefined),
      on: () => () => {},
      effect: (callback: () => unknown) => {
        const dispose = callback()
        if (typeof dispose === 'function') disposers.push(dispose as () => void)
        return dispose
      },
    },
  }
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

  it('operator toggling the switch after activation is followed without a remount', () => {
    // Given a mounted row whose master switch the Loader commits in place
    let live = true
    const mounted = { ...Config({}), enabled: { get: () => live } }
    // When the switch flips off after the activation captured its config
    live = false
    // Then the effective settings report the live value, not the capture
    expect(resolveProviderSettings(mounted as never).enabled).toBe(false)
  })

  it('operator disabling the extension admits no provider to the board', () => {
    // Given a disabled profile entry mounted on a board that serves the service
    const harness = servingContext()
    // When the host mounts it
    apply(harness.ctx as never, Config({ enabled: false }))
    // Then nothing was registered, so the board has no provider to start
    expect(harness.registered).toEqual([])
    harness.release()
  })

  it('operator enabling the extension admits exactly one provider for the row', () => {
    // Given an enabled profile entry
    const harness = servingContext()
    // When the host mounts it
    apply(harness.ctx as never, Config({ enabled: true }))
    // Then one provider carrying this extension's identity reached the board
    expect(harness.registered.map(extension => extension.id)).toEqual(['github'])
    expect(harness.registered[0]?.apiVersion).toBe(1)
    harness.release()
  })

  it('operator mounting the same package twice keeps one lifecycle, released by its disposer', () => {
    // Given an enabled profile entry mounted once
    const harness = context()
    apply(harness.ctx as never, Config({ enabled: true }))
    // When the same package name mounts a second time (aggregate row plus a standalone link)
    apply(harness.ctx as never, Config({ enabled: true }))
    // Then the refused mount queued instead of registering a second lifecycle
    expect(harness.labels).toEqual(['task-board-github: provider lifecycle'])
    // And releasing the holder lets the next mount take the seam again
    for (const dispose of harness.disposers.splice(0)) dispose()
    apply(harness.ctx as never, Config({ enabled: true }))
    expect(harness.labels).toEqual([
      'task-board-github: provider lifecycle',
      'task-board-github: provider lifecycle',
    ])
  })

  it('operator opening the settings page gets the switches served as live-editable', () => {
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
