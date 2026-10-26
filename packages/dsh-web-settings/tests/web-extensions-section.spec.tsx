/** @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import { WebExtensionsSection } from '../src/client/WebExtensionsSection.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const t = (key: string): string => (en as Record<string, string>)[key] ?? key

function entry(key: string): StoredEntry {
  return { options: { key }, component: () => null } as StoredEntry
}

function makeExtensions(keys: string[]) {
  let selected = 'web-ui-plugins'
  const listeners = new Set<() => void>()
  const entries = keys.map(entry)
  return {
    sectionId: 'web-ui-plugins' as const,
    label: () => 'Web Extensions',
    open: () => true,
    getSnapshot: () => selected,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    subscribeEntries: () => () => {},
    getEntries: () => entries,
    select: (id: string) => { selected = id; for (const listener of listeners) listener() },
  }
}

function renderSection(keys: string[] = ['web-ui-plugins', 'skin-center', 'dsh-usage']) {
  const extensions = makeExtensions(keys)
  const renderSlot = vi.fn(() => null)
  const props = {
    t,
    close: vi.fn(),
    renderSlot,
    extensions,
  } as unknown as ComponentProps<typeof WebExtensionsSection>
  const result = render(<WebExtensionsSection {...props} />)
  return { ...result, extensions, renderSlot }
}

describe('WebExtensionsSection', () => {
  it('user sees installed pages in fixed order and only the active keyed entry', () => {
    // Given three keyed pages registered out of display order
    const { renderSlot } = renderSection(['dsh-usage', 'web-ui-plugins', 'skin-center'])
    expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual(['Web Plugins', 'Skins', 'Usage'])
    expect(screen.getByRole('tab', { name: 'Web Plugins' }).getAttribute('aria-selected')).toBe('true')
    expect(renderSlot).toHaveBeenLastCalledWith('web-ui.extension', { close: expect.any(Function) }, expect.objectContaining({ entryKey: 'web-ui-plugins' }))

    // When the user selects Usage
    fireEvent.click(screen.getByRole('tab', { name: 'Usage' }))
    // Then only that keyed page is dispatched
    expect(screen.getByRole('tab', { name: 'Usage' }).getAttribute('aria-selected')).toBe('true')
    expect(renderSlot).toHaveBeenLastCalledWith('web-ui.extension', { close: expect.any(Function) }, expect.objectContaining({ entryKey: 'dsh-usage' }))
  })

  it('user navigates TABs with arrow, Home and End keys', () => {
    // Given the Web Plugins TAB is focused
    renderSection()
    const first = screen.getByRole('tab', { name: 'Web Plugins' })
    first.focus()
    // When the user presses arrow, End and Home keys
    fireEvent.keyDown(first, { key: 'ArrowDown' })
    // Then focus and selection move together to the expected TAB
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Skins' }))
    expect(screen.getByRole('tab', { name: 'Skins' }).getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Skins' }), { key: 'End' })
    expect(screen.getByRole('tab', { name: 'Usage' }).getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Usage' }), { key: 'Home' })
    expect(first.getAttribute('aria-selected')).toBe('true')
  })

  it('user sees an accessible empty state when no keyed page is installed', () => {
    // Given no installed keyed pages
    const { renderSlot } = renderSection([])
    // When the parent renders
    // Then it exposes no TAB and explains the empty panel without dispatching
    expect(screen.queryAllByRole('tab')).toHaveLength(0)
    expect(screen.getByText(en['extensions.unavailable']).textContent).toBe(en['extensions.unavailable'])
    expect(renderSlot).not.toHaveBeenCalled()
  })
})
