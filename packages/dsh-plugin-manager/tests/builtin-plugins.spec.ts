/**
 * The built-in group's pure logic: the subtraction that decides which Loader
 * entries are built-in, the write state the manager reports per row, and the two
 * answer shapes one remote write resolves with. Rendering and the DOM mount are
 * covered by builtin-plugins.spec.tsx.
 */
import { describe, expect, it } from 'vitest'
import {
  readChangeResult,
  readRemoteAnswer,
  selectBuiltinEntries,
  type BundleFacts,
  type LoaderEntry,
  type PluginFacts,
  type PluginInventory,
} from '../src/core/builtin.ts'

/** The Computer Use pair a profile patch inserts: the rows this group exists for. */
const COMPUTER_USE: LoaderEntry = {
  entryId: 'computer-use',
  moduleName: '@deepseek-ai/dsh-computer-use',
  enabled: true,
  fiberPhase: 'active',
}

const COMPUTER_USE_DRIVER: LoaderEntry = {
  entryId: 'computer-use-cua-driver-native',
  moduleName: '@deepseek-ai/dsh-experimental-computer-use-cua-driver-native',
  enabled: false,
  fiberPhase: null,
}

/** A row one installed bundle contributes. */
const BUNDLE_ROW: LoaderEntry = {
  entryId: 'ui-settings-general',
  moduleName: '@deepseek-ai/dsh-client-ui-settings-general',
  enabled: true,
  fiberPhase: 'active',
}

/** A global row no bundle declares. */
const INVENTORY_ROW: LoaderEntry = {
  entryId: 'plugin-inventory',
  moduleName: '@deepseek-ai/dsh-host-plugin-inventory',
  enabled: true,
  fiberPhase: 'active',
}

function inventory(entries: readonly LoaderEntry[]): PluginInventory {
  return { managementAvailable: true, entries }
}

function bundleOf(...entryIds: string[]): BundleFacts {
  return { rows: entryIds.map(entryId => ({ entryId })) }
}

/** Every row writable, as the manager reports a deployment with no locks. */
function writable(...entryIds: string[]): PluginFacts[] {
  return entryIds.map(entryId => ({ entryId }))
}

const everyEntry = [BUNDLE_ROW, COMPUTER_USE, COMPUTER_USE_DRIVER, INVENTORY_ROW]

describe('built-in entry selection', () => {
  it('user sees the rows no installed bundle contributes, the Computer Use pair among them', () => {
    // Given a Loader carrying one bundle's row beside the globally declared ones
    const plugins = writable(...everyEntry.map(entry => entry.entryId))

    // When the group subtracts what the installed bundle inserts
    const group = selectBuiltinEntries(inventory(everyEntry), [bundleOf('ui-settings-general')], plugins)

    // Then the bundle's own row is gone and every global row stays
    expect(group.rows.map(row => row.entryId))
      .toEqual(['computer-use', 'computer-use-cua-driver-native', 'plugin-inventory'])
    expect(group.bundles).toBe('confirmed')
  })

  it('user keeps a row a bundle names without a live entry', () => {
    // Given a bundle whose patch declares a row no Loader entry carries
    const plugins = writable('computer-use')

    // When the roster subtracts only the entry ids it actually resolved
    const group = selectBuiltinEntries(inventory([COMPUTER_USE]), [{ rows: [{}, { entryId: undefined }] }], plugins)

    // Then the entry stays listed: nothing occupies its id
    expect(group.rows.map(row => row.entryId)).toEqual(['computer-use'])
    expect(group.bundles).toBe('confirmed')
  })

  it('user still gets every entry, marked unconfirmed, when the bundle roster cannot be read', () => {
    // Given the bundle read failed
    const plugins = writable(...everyEntry.map(entry => entry.entryId))

    // When the group is built without a roster
    const group = selectBuiltinEntries(inventory(everyEntry), undefined, plugins)

    // Then nothing is subtracted and the group says the roster is unconfirmed
    expect(group.rows.map(row => row.entryId))
      .toEqual(['ui-settings-general', 'computer-use', 'computer-use-cua-driver-native', 'plugin-inventory'])
    expect(group.bundles).toBe('unconfirmed')
  })

  it('user sees each row locked for the reason the manager gave', () => {
    // Given rows the manager reports as writable, protected, unaddressable, and unread
    const plugins: PluginFacts[] = [
      { entryId: 'computer-use' },
      { entryId: 'computer-use-cua-driver-native', readOnlyReason: 'management-required' },
      { entryId: 'ui-settings-general', readOnlyReason: 'unaddressable' },
    ]

    // When the group is built with that roster
    const group = selectBuiltinEntries(inventory(everyEntry), [bundleOf('ui-settings-general')], plugins)

    // Then each row carries its own state, and one missing from the roster is unknown
    expect(group.rows.map(row => [row.entryId, row.write])).toEqual([
      ['computer-use', 'writable'],
      ['computer-use-cua-driver-native', 'management-required'],
      ['plugin-inventory', 'unknown'],
    ])
  })

  it('user never gets a switch the manager might not take when the plugin roster failed', () => {
    // Given no plugin roster at all
    // When the group is built
    const group = selectBuiltinEntries(inventory([COMPUTER_USE]), [], undefined)

    // Then the row is locked as unknown rather than offered as writable
    expect(group.rows[0]?.write).toBe('unknown')
  })

  it('user keeps a row a bundle only offers while its files are not installed', () => {
    // Given a roster entry for a bundle the profile does not install, declaring a live row
    const availableOnly: BundleFacts = { name: 'dsh-market', installed: false, rows: [{ entryId: 'computer-use' }] }
    const installed: BundleFacts = { name: 'dsh-web-app', installed: true, rows: [{ entryId: 'plugin-inventory' }] }

    // When both are subtracted
    const group = selectBuiltinEntries(
      inventory([COMPUTER_USE, INVENTORY_ROW]),
      [availableOnly, installed],
      writable('computer-use', 'plugin-inventory'),
    )

    // Then only the installed bundle's claim takes a row out of the default scope
    expect(group.rows.map(row => row.entryId)).toEqual(['computer-use'])
    expect(group.owners.get('computer-use')).toBeUndefined()
    expect(group.allRows.map(row => row.ownedBy)).toEqual([undefined, 'dsh-web-app'])
  })

  it('user keeps the row order the Loader reports', () => {
    // Given entries in Loader order
    // When the group is built without bundles
    const group = selectBuiltinEntries(inventory([COMPUTER_USE_DRIVER, COMPUTER_USE]), [], writable('computer-use', 'computer-use-cua-driver-native'))

    // Then the order is preserved, not re-sorted by this package
    expect(group.rows.map(row => row.moduleName)).toEqual([
      '@deepseek-ai/dsh-experimental-computer-use-cua-driver-native',
      '@deepseek-ai/dsh-computer-use',
    ])
  })
})

describe('remote answer shapes', () => {
  it('user gets the value of a gateway envelope', () => {
    // Given the { ok, value } shape the API gateway resolves with
    // When it is read
    // Then the value comes back
    expect(readRemoteAnswer<number>({ ok: true, value: 7 })).toEqual({ ok: true, value: 7 })
  })

  it('user gets the error code of a refused envelope', () => {
    // Given a refused envelope
    // When it is read
    // Then the failure carries the code the host named
    expect(readRemoteAnswer<number>({ ok: false, error: { code: 'management-required' } }))
      .toEqual({ ok: false, code: 'management-required' })
  })

  it('user keeps a bare value a carrier hands back unwrapped', () => {
    // Given a result with no envelope
    // When it is read
    // Then it passes through as the value itself
    expect(readRemoteAnswer<number>(42)).toEqual({ ok: true, value: 42 })
    expect(readRemoteAnswer<number>({ changed: true })).toEqual({ ok: true, value: { changed: true } })
  })
})

describe('change result reading', () => {
  it('user sees an applied write as a success in both carriers', () => {
    // Given the same applied result with and without the envelope
    const enveloped = { ok: true, value: { changed: true, application: 'applied' } }
    const bare = { changed: true, application: 'applied' }

    // When both are read
    // Then both are successes, and neither is mistaken for a failure
    expect(readChangeResult(enveloped)).toEqual({ ok: true, application: 'applied', restartReason: undefined })
    expect(readChangeResult(bare)).toEqual({ ok: true, application: 'applied', restartReason: undefined })
  })

  it('user is told why a write needs a restart', () => {
    // Given a write the running process cannot load
    // When it is read
    // Then the application and the host's reason survive
    expect(readChangeResult({ changed: true, application: 'restart-required', restartReason: 'no-hmr' }))
      .toEqual({ ok: true, application: 'restart-required', restartReason: 'no-hmr' })
  })

  it('user sees a folded refusal as a failure, not a resolved success', () => {
    // Given the manager's own failure fold
    const folded = { changed: false, application: 'failed', error: { code: 'operation-error' } }

    // When it is read
    // Then the code the manager returned is the reason
    expect(readChangeResult(folded)).toEqual({ ok: false, code: 'operation-error' })
  })

  it('user sees an overridden write as a resolved change a higher layer wins over', () => {
    // Given a write the host applied but a higher profile layer overrides
    // When it is read
    // Then it is not a failure, and the application says what happened
    expect(readChangeResult({ changed: true, application: 'overridden' }))
      .toEqual({ ok: true, application: 'overridden', restartReason: undefined })
  })

  it('user sees a cancelled write as a failure', () => {
    // Given a write that was cancelled with no error code
    // When it is read
    // Then the application itself names the outcome
    expect(readChangeResult({ changed: false, application: 'cancelled' })).toEqual({ ok: false, code: 'cancelled' })
  })

  it('user sees a refused envelope as a failure carrying its code', () => {
    // Given a refusal delivered as an envelope
    // When it is read
    // Then the envelope's code is the reason
    expect(readChangeResult({ ok: false, error: { code: 'management-required' } }))
      .toEqual({ ok: false, code: 'management-required' })
  })

  it('user sees an unreadable answer as a failure rather than a silent success', () => {
    // Given an answer carrying no application at all
    // When it is read
    // Then it is reported as an operation error
    expect(readChangeResult({ changed: true })).toEqual({ ok: false, code: 'operation-error' })
  })
})
