// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import type { ConfigPageForm } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { BrowserViewConfig } from '../../src/client/config.tsx'
import { zh } from '../../src/client/locales.ts'
import { actOn, render, type RenderedTree } from './render.tsx'
import { translate } from './translate.ts'

let tree: RenderedTree | null = null
afterEach(() => {
  tree?.unmount()
  tree = null
  document.body.innerHTML = ''
})

function formFixture(): ConfigPageForm & { mutate: ReturnType<typeof vi.fn> } {
  return {
    state: {
      status: 'ready',
      value: { realBrowserEnabled: false, cdpEndpoint: 'http://127.0.0.1:9222' },
      base: undefined,
      user: undefined,
      revision: 7,
      writable: true,
    },
    mutate: vi.fn(async () => true),
  }
}

describe('browser-view row configuration', () => {
  it('operator enables the real browser and commits the CDP endpoint through the host form', async () => {
    // Given a ready volatile form with revision 7
    // When the switch is enabled and a new endpoint is committed
    // Then both field writes use their own paths and the read revision
    const form = formFixture()
    const mounted = render(<BrowserViewConfig t={translate(zh)} view="page" form={form} />)
    tree = mounted
    const toggle = mounted.container.querySelector('input[role="switch"]') as HTMLInputElement
    await act(async () => { toggle.click(); await Promise.resolve() })
    expect(form.mutate).toHaveBeenNthCalledWith(1, [{ op: 'set', path: ['realBrowserEnabled'], value: true }], 7)
    await vi.waitFor(() => { expect(toggle.disabled).toBe(false) })

    const input = mounted.container.querySelector('input[type="text"]') as HTMLInputElement
    actOn(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(input, 'http://localhost:9333')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => { input.focus(); input.blur(); await Promise.resolve() })
    await vi.waitFor(() => {
      expect(form.mutate).toHaveBeenNthCalledWith(2, [{ op: 'set', path: ['cdpEndpoint'], value: 'http://localhost:9333' }], 7)
    })
  })

  it('operator sees a summary without mounting a configuration form', () => {
    // Given the Plugins page asks for the row summary
    // When the configuration component renders
    // Then only the localized summary is shown
    const mounted = render(<BrowserViewConfig t={translate(zh)} view="summary" />)
    tree = mounted
    expect(mounted.container.textContent).toBe(zh['config.summary'])
    expect(mounted.container.querySelector('input')).toBeNull()
  })
})
