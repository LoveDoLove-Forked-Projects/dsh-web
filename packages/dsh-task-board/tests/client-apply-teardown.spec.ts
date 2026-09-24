// @vitest-environment jsdom
/**
 * Fiber ownership of the mounted DOM surfaces.
 *
 * The client module system replaces a rebuilt bundle IN PLACE: it disposes the
 * old fiber and re-applies the new code in the same document, without a page
 * reload. Every seat this plugin registered through `ctx.effect` dies with
 * that fiber — including the locale dictionaries the sidebar row renders
 * through — so a row that outlives its fiber keeps showing raw dictionary keys
 * (the reported 2026-09-24 zombie entry: a live "entry.label" row next to a
 * fully translated shell).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../src/client/index.ts'

const ENTRY_SELECTOR = '[data-dsh-taskboard-entry]'

/** The shell subtree the sidebar-entry core injects into. */
function renderSidebarShell(): void {
  document.body.innerHTML = `
    <div data-pane="sidebar">
      <div class="shell_sidebarRoot">
        <div class="shell_logoRow"><button class="shell_newSession">New session</button></div>
      </div>
    </div>`
}

/** An unavailable settings namespace: the composition default (enabled) mounts the UI. */
function unavailableSettingsForm() {
  return {
    getSnapshot: () => ({
      status: 'unavailable',
      value: undefined,
      base: undefined,
      user: undefined,
      revision: undefined,
      writable: false,
      mode: 'host',
    }),
    subscribe: () => () => {},
    mutate: async () => false,
    set: async () => false,
    unset: async () => false,
  }
}

/** Minimal client context: the seats apply() reads, plus the effect collector. */
function applyContext() {
  const disposers: Array<() => void> = []
  const services: Record<string, unknown> = {
    sessions: { list: { getSnapshot: () => ({ byId: {} }), subscribe: () => () => {} } },
    workspaces: {
      list: { getSnapshot: () => ({ items: [] }), subscribe: () => () => {} },
      create: async () => ({ workspaceId: 'w1' }),
    },
    remote: {},
    connection: { api: {} },
  }
  const ctx = {
    effect(callback: () => void | (() => void)) {
      const disposer = callback()
      if (typeof disposer === 'function') disposers.push(disposer)
    },
    get: (name: string) => services[name],
    on: () => () => {},
    locale: {
      register: () => () => {},
      bind: () => (key: string) => key,
      subscribe: () => () => {},
    },
    configForms: {
      get: () => unavailableSettingsForm(),
      // The describe mirror may answer late; a throwing probe is the documented
      // "nothing served yet" path and binds the aggregate entry id.
      describe: () => { throw new Error('no describe mirror') },
    },
    slots: { register: () => () => {} },
  }
  return { ctx: ctx as never, disposers }
}

describe('task-board client apply fiber ownership', () => {
  beforeEach(() => {
    renderSidebarShell()
    // The cross-module apply guard is a globalThis flag; each case starts fresh.
    delete (globalThis as { __dshTaskboardApplied?: boolean }).__dshTaskboardApplied
    // Every host call (telemetry, ledger bootstrap) fails fast: this spec is
    // about DOM lifetime, not transport.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it('operator sees the sidebar row leave the document when the task-board fiber disposes', () => {
    // Given a client context whose fiber the loader can dispose
    const { ctx, disposers } = applyContext()

    // When the plugin applies, then is disposed like a replaced bundle
    apply(ctx)
    expect(document.querySelector(ENTRY_SELECTOR)?.textContent).toBe('entry.label')
    for (const dispose of disposers.splice(0).reverse()) dispose()

    // Then the row is gone rather than left behind showing raw dictionary keys
    expect(document.querySelector(ENTRY_SELECTOR)).toBeNull()
    expect(disposers).toHaveLength(0)
  })

  it('operator sees the sidebar row return when the task board applies again after a fiber teardown', () => {
    // Given a mounted board whose fiber the loader unloaded
    const first = applyContext()
    apply(first.ctx)
    for (const dispose of first.disposers.splice(0).reverse()) dispose()
    expect(document.querySelector(ENTRY_SELECTOR)).toBeNull()

    // When the rebuilt bundle applies into the same document
    const second = applyContext()
    apply(second.ctx)

    // Then one working row is mounted again, not a stale one
    expect(document.querySelector(ENTRY_SELECTOR)?.textContent).toBe('entry.label')
    expect(document.querySelectorAll(ENTRY_SELECTOR)).toHaveLength(1)
  })
})
