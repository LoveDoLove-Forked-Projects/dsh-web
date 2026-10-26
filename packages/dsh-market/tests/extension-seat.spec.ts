import { describe, expect, it } from 'vitest'
import { installWorkshopSection } from '../src/client/extension-seat.ts'

describe('Workshop extension seat', () => {
  it('user keeps one section while the parent service changes', () => {
    // Given a standalone Workshop registration and an observable slot registry
    let service: object | undefined
    let changed: (() => void) | undefined
    const registered: Array<Record<string, unknown>> = []
    const ctx = {
      get: () => service,
      on: (_event: string, listener: () => void) => { changed = listener },
      slots: {
        register: (options: Record<string, unknown>) => {
          const entry = { options }
          registered.push(entry)
          changed?.()
          return () => {
            const index = registered.indexOf(entry)
            if (index >= 0) registered.splice(index, 1)
            changed?.()
          }
        },
      },
    }
    const registration = { locale: 'dsh-web-ui-market', label: () => 'Workshop', inject: () => ({}), component: () => null }
    const dispose = installWorkshopSection(ctx, registration)
    expect(registered[0]?.options).toMatchObject({ name: 'settings.section', id: 'dsh-workshop' })

    // When the parent appears and later disappears
    service = { sectionId: 'web-ui-plugins' }
    changed?.()
    // Then the same single entry moves seats and returns without duplication
    expect(registered).toHaveLength(1)
    expect(registered[0]?.options).toMatchObject({ name: 'web-ui.extension', key: 'dsh-workshop' })
    expect(registered[0]?.options).not.toHaveProperty('id')

    service = undefined
    changed?.()
    expect(registered).toHaveLength(1)
    expect(registered[0]?.options).toMatchObject({ name: 'settings.section', id: 'dsh-workshop' })
    dispose()
    expect(registered).toHaveLength(0)
  })

  it('user gets registered only after the target declaration is ready', () => {
    // Given a parent service whose child seat is not declared yet
    let declared = false
    let changed: (() => void) | undefined
    const registered: Array<Record<string, unknown>> = []
    const ctx = {
      get: () => ({ sectionId: 'web-ui-plugins' }),
      on: (_event: string, listener: () => void) => { changed = listener },
      slots: {
        spec: () => declared ? { kind: 'keyed', scope: 'root' } : undefined,
        register: (options: Record<string, unknown>) => { registered.push(options); return () => {} },
      },
    }
    installWorkshopSection(ctx, { locale: 'dsh-web-ui-market', label: () => 'Workshop', inject: () => ({}), component: () => null })
    expect(registered).toHaveLength(0)
    // When the declaration arrives
    declared = true
    changed?.()
    // Then registration happens once without a refused retry
    expect(registered).toHaveLength(1)
    expect(registered[0]).toMatchObject({ name: 'web-ui.extension', key: 'dsh-workshop' })
  })
})
