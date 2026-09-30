/**
 * Browser half of the GitHub provider extension: the dictionaries it registers
 * and the settings card it contributes to whichever plugin-card seat the host
 * renders.
 */
import { describe, expect, it } from 'vitest'
import { apply, NS } from '../src/client/index.ts'
import { FAMILY_PLUGIN_CARD_SEAT, OFFICIAL_PLUGIN_CARD_SEAT } from '../src/client/plugin-card-seat.ts'

/**
 * Settings-form double that applies the batched writes the card submits, so
 * the staged form's read-back judgment settles on the same values the Host
 * would hold.
 */
function form(initial: Record<string, unknown>) {
  const user: Record<string, unknown> = { ...initial }
  const ops: Array<{ op: 'set' | 'unset'; path: string[]; value?: unknown }> = []
  const scope = {
    getSnapshot: () => ({
      status: 'ready' as const,
      value: { ...user },
      base: undefined,
      user: { ...user },
      revision: 1,
      writable: true,
      mode: 'host' as const,
    }),
    subscribe: () => () => {},
    set: async () => true,
    unset: async () => true,
    mutate: async (batch: Array<{ op: 'set' | 'unset'; path: string[]; value?: unknown }>) => {
      ops.push(...batch)
      for (const op of batch) {
        if (op.op === 'set') user[op.path[0]!] = op.value
        else delete user[op.path[0]!]
      }
      return true
    },
  }
  return { scope, ops }
}

/**
 * Browser context double over the services the browser half reads: the slot
 * registry, the locale catalog, the shared forms service, and (when the family
 * group is loaded) its settings binder.
 */
function context(options: { group?: boolean } = {}) {
  const registrations: Array<Record<string, unknown>> = []
  const dictionaries: string[] = []
  const { scope } = form({ enabled: true })
  const ctx = {
    get: (name: string) => (options.group === true && name === 'webUiSettings' ? { bind: () => scope } : undefined),
    on: () => () => {},
    effect: (callback: () => unknown) => callback(),
    // This page serves no task board, so the dependency scope never runs: the
    // dictionaries and the settings card must mount anyway (they are what the
    // operator needs to configure the extension without a board). The shape
    // matches cordis's: a fiber with a dispose.
    inject: () => ({ dispose: () => {} }),
    slots: {
      register: (entry: Record<string, unknown>) => {
        registrations.push(entry)
        return () => {}
      },
    },
    locale: {
      register: (namespace: string, catalog: Record<string, unknown>) => {
        dictionaries.push(namespace + ':' + Object.keys(catalog).join(','))
        return () => {}
      },
    },
    configForms: {
      get: () => scope,
      describe: () => ({ getSnapshot: () => ({ view: undefined }), subscribe: () => () => {} }),
    },
  }
  return { ctx, registrations, dictionaries }
}

describe('task-board GitHub extension browser half', () => {
  it('operator with the family settings group loaded sees the card in the family list seat', () => {
    // Given a page whose settings group publishes its family binder
    const harness = context({ group: true })

    // When the browser half applies
    apply(harness.ctx as never)

    // Then one card entry names this package, its row id, its order and its namespace
    expect(harness.registrations).toHaveLength(1)
    expect(harness.registrations[0]).toMatchObject({
      name: FAMILY_PLUGIN_CARD_SEAT,
      id: 'task-board-github',
      order: 130,
      locale: NS,
    })
    // And both dictionaries of that namespace were registered for the page
    expect(harness.dictionaries).toEqual(['task-board-github:zh,en'])
  })

  it('operator without the settings group sees the card in the official bundle seat', () => {
    // Given a page that serves no family group, only the shared forms service
    const harness = context()

    // When the browser half applies
    apply(harness.ctx as never)

    // Then the card is contributed under the official keyed seat, keyed by the bundle name
    expect(harness.registrations).toHaveLength(1)
    expect(harness.registrations[0]).toMatchObject({
      name: OFFICIAL_PLUGIN_CARD_SEAT,
      key: '@linxin666/dsh-client-ui-task-board-github',
      locale: NS,
    })
    expect(harness.registrations[0]?.id).toBeUndefined()
  })
})
