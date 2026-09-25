// @vitest-environment jsdom
// @vitest-environment-options {"url": "dsh-app://app/"}
/**
 * The desktop shell's page carries no update seat. The jsdom origin here is the
 * real shell scheme, so this spec exercises the branch the running desktop
 * client takes: the same apply() that mounts the seat on a web page must mount
 * nothing on an application-delivered page, because the desktop application
 * owns its own updater and that page's sidebar seat keeps only the phone-remote
 * trigger.
 */
import { describe, expect, it } from 'vitest'
import { apply } from '../src/client/index.ts'

describe('desktop shell page', () => {
  it('operator: the update seat is not mounted on the desktop shell page', () => {
    // Given the desktop shell's own page origin and a client context carrying
    // the slots and locale services
    expect(window.location.protocol).toBe('dsh-app:')
    expect(window.location.hostname).toBe('app')
    const injected: string[] = []
    const registered: unknown[] = []
    const dictionaries: string[] = []
    const ctx = {
      effect: (fn: () => unknown) => fn(),
      locale: {
        register: (ns: string) => {
          dictionaries.push(ns)
          return () => {}
        },
        bind: () => (key: string) => key,
      },
      slots: {
        inject: (key: string, factory?: () => unknown) => {
          injected.push(key)
          factory?.()
          return () => {}
        },
        register: (entry: unknown) => {
          registered.push(entry)
          return () => {}
        },
      },
    }
    // When the plugin applies
    apply(ctx as never)
    // Then the dictionaries still register and the footer seat stays unmounted
    expect(dictionaries).toEqual(['update'])
    expect(injected).toEqual([])
    expect(registered).toEqual([])
  })
})
