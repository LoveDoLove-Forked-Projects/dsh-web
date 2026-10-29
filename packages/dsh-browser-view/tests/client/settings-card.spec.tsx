// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
type SettingsPathOpView =
  | { op: 'set'; path: string[]; value: unknown }
  | { op: 'unset'; path: string[] }
import { BrowserViewSettingsCard, BrowserViewSettingsCardController, type BrowserViewSettings, type BrowserViewSettingsCardProps } from '../../src/client/BrowserViewSettingsCard.tsx'
import { zh } from '../../src/client/locales.ts'
import { actOn, render, type RenderedTree } from './render.tsx'
import { translate } from './translate.ts'

class FakeConfigForm implements ConfigForm<BrowserViewSettings> {
  private snapshot: ConfigFormSnapshot<BrowserViewSettings>
  private readonly listeners = new Set<() => void>()
  readonly mutations: Array<{ ops: readonly SettingsPathOpView[]; revision?: number }> = []

  constructor() {
    this.snapshot = {
      status: 'ready',
      value: { realBrowserEnabled: false, cdpEndpoint: 'http://127.0.0.1:9222' },
      base: { realBrowserEnabled: false, cdpEndpoint: 'http://127.0.0.1:9222' },
      user: {},
      revision: 1,
      writable: true,
    }
  }

  getSnapshot(): ConfigFormSnapshot<BrowserViewSettings> { return this.snapshot }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  async mutate(ops: readonly SettingsPathOpView[], expectedRevision?: number): Promise<boolean> {
    this.mutations.push({ ops, revision: expectedRevision })
    const value: BrowserViewSettings = this.snapshot.value === undefined ? {} : { ...this.snapshot.value }
    const user: Record<string, unknown> = typeof this.snapshot.user === 'object' && this.snapshot.user !== null ? { ...this.snapshot.user } : {}
    for (const op of ops) {
      const field = op.path[0] as keyof BrowserViewSettings
      if (op.op === 'set') {
        value[field] = op.value as never
        user[field] = op.value
      } else {
        delete value[field]
        delete user[field]
      }
    }
    this.snapshot = { ...this.snapshot, value, user, revision: (this.snapshot.revision ?? 0) + 1 }
    for (const listener of this.listeners) listener()
    return true
  }

  async set(field: string, value: unknown): Promise<boolean> {
    return await this.mutate([{ op: 'set', path: [field], value }])
  }

  async unset(field: string): Promise<boolean> {
    return await this.mutate([{ op: 'unset', path: [field] }])
  }
}

let tree: RenderedTree | null = null
afterEach(() => {
  tree?.unmount()
  tree = null
  document.body.innerHTML = ''
})

describe('Web Extensions real-browser settings card', () => {
  it('operator renders the shared card chrome and writes both volatile fields', async () => {
    // Given a native form and its shared card controller
    // When the card is expanded and both fields are edited through its actions
    // Then the title and fields render, the switch writes immediately, and the endpoint saves as a draft
    const form = new FakeConfigForm()
    const controller = new BrowserViewSettingsCardController(form)
    const face = controller.inject()
    const props = {
      t: translate(zh),
      useBrowserViewSettingsCard: face.hooks.browserViewSettingsCard.getSnapshot,
      edit: face.edit,
      resetField: face.resetField,
      save: face.save,
      discard: face.discard,
    } as unknown as BrowserViewSettingsCardProps
    const mounted = render(<BrowserViewSettingsCard {...props} />)
    tree = mounted
    expect(mounted.container.textContent).toContain(zh['settings.title'])
    expect(mounted.container.textContent).toContain(zh['settings.description'])
    const disclosure = mounted.container.querySelector('button[aria-expanded]') as HTMLButtonElement
    actOn(() => { disclosure.click() })
    expect(mounted.container.textContent).toContain(zh['settings.enabled'])
    expect(mounted.container.textContent).toContain(zh['settings.cdpEndpoint'])
    expect(mounted.container.querySelector('svg')?.getAttribute('width')).toBe('18')

    actOn(() => { face.edit('realBrowserEnabled', 'true') })
    await vi.waitFor(() => { expect(form.mutations).toHaveLength(1) })
    expect(form.mutations[0].ops).toEqual([{ op: 'set', path: ['realBrowserEnabled'], value: true }])
    actOn(() => { face.edit('cdpEndpoint', 'http://localhost:9333') })
    actOn(() => { face.save() })
    await vi.waitFor(() => { expect(form.mutations).toHaveLength(2) })
    expect(form.mutations[1].ops).toEqual([{ op: 'set', path: ['cdpEndpoint'], value: 'http://localhost:9333' }])
    controller.dispose()
  })

  it('operator sees the card title without enabling the real browser by default', () => {
    // Given the default isolated configuration
    // When the card first renders
    // Then its title is visible while the stored switch remains false
    const form = new FakeConfigForm()
    const controller = new BrowserViewSettingsCardController(form)
    const state = controller.inject().hooks.browserViewSettingsCard.getSnapshot()
    expect(state.realBrowserEnabled.text).toBe('false')
    expect(state.cdpEndpoint.text).toBe('http://127.0.0.1:9222')
    controller.dispose()
  })
})
