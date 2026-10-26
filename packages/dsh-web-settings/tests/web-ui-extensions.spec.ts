import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { WebUiExtensions } from '../src/client/web-ui-extensions.ts'

describe('WebUiExtensions navigation', () => {
  it('user selects the requested TAB before opening the stable parent section', () => {
    // Given a native settings store and the Web Extensions service
    const ctx = new Context()
    const openSection = vi.fn()
    Object.assign(ctx, {
      locale: { bind: () => (key: string) => key },
      slots: {
        entries: (key: string) => key === 'sidebar.settings'
          ? [{ store: { create: () => ({ actions: { openSection } }) } }]
          : [],
        subscribe: () => () => {},
      },
    })
    const service = new WebUiExtensions(ctx)
    expect(service.label()).toBe('extensions.title')
    // When usage opens through the service
    // Then selection happens before the stable parent opens
    expect(service.open('dsh-usage')).toBe(true)
    expect(service.getSnapshot()).toBe('dsh-usage')
    expect(openSection).toHaveBeenCalledWith('web-ui-plugins')
  })

  it('user keeps the selection when native navigation is unavailable', () => {
    // Given no native settings store
    const ctx = new Context()
    Object.assign(ctx, {
      locale: { bind: () => (key: string) => key },
      slots: { entries: () => [], subscribe: () => () => {} },
    })
    const service = new WebUiExtensions(ctx)
    // When native navigation declines
    // Then the requested TAB remains selected for the DOM fallback
    expect(service.open('pet')).toBe(false)
    expect(service.getSnapshot()).toBe('pet')
  })
})
