import { describe, expect, it, vi } from 'vitest'
import { BrowserViewService, type BrowserSession, type BrowserViewSink, type OpenSessionOptions } from '../../src/host/service.ts'
import { TabManager } from '../../src/core/tabs.ts'
import type { BrowserViewEvent } from '../../src/core/protocol.ts'
import { FakeTransport } from '../helpers/fake-cdp.ts'

function realTransport(): FakeTransport {
  const transport = new FakeTransport()
  transport.responses.set('Target.attachToTarget', (params: Record<string, unknown>) => ({ sessionId: `session-${String(params.targetId)}` }))
  transport.responses.set('Target.getTargets', {
    targetInfos: [
      { targetId: 'existing-a', type: 'page', url: 'https://a.test/', title: 'A' },
      { targetId: 'existing-b', type: 'page', url: 'https://b.test/', title: 'B' },
      { targetId: 'worker', type: 'service_worker', url: 'https://worker.test/' },
    ],
  })
  transport.responses.set('Page.captureScreenshot', { data: 'JPEG-BYTES' })
  transport.responses.set('Page.getLayoutMetrics', { cssLayoutViewport: { clientWidth: 1440, clientHeight: 900 } })
  return transport
}

function realSession(transport: FakeTransport, options: OpenSessionOptions): BrowserSession {
  const tabs = new TabManager({
    transport,
    discoverTargets: true,
    pinViewport: false,
    onFrame: options.onFrame,
    onTabsChanged: options.onTabsChanged,
  })
  return {
    mode: 'cdp',
    transport,
    tabs,
    async dispose() {
      await tabs.dispose()
      transport.close()
    },
  }
}

function sink(): { sink: BrowserViewSink; events: BrowserViewEvent[] } {
  const events: BrowserViewEvent[] = []
  return {
    events,
    sink: { send: event => { events.push(event) }, close: () => undefined },
  }
}

describe('real-browser target discovery', () => {
  it('operator adopts existing and future pages without pinning their viewport', async () => {
    // Given a real browser with existing pages and discovery enabled
    // When pages are adopted, changed, created, removed, and captured
    // Then membership and origin stay accurate and no viewport override is sent
    const transport = realTransport()
    const tabs = new TabManager({ transport, discoverTargets: true, pinViewport: false })
    await tabs.discoverExistingTabs()

    expect(tabs.list().map(tab => [tab.id, tab.origin])).toEqual([
      ['existing-a', 'adopted'],
      ['existing-b', 'adopted'],
    ])
    expect(tabs.sessionOf('existing-a')).toBe('session-existing-a')
    expect(transport.callsOf('Emulation.setDeviceMetricsOverride')).toHaveLength(0)
    expect(await tabs.refreshFrame('existing-a')).toMatchObject({ width: 1440, height: 900 })

    transport.emit('Target.targetCreated', {
      targetInfo: { targetId: 'future', type: 'page', url: 'https://future.test/', title: 'Future' },
    })
    await vi.waitFor(() => { expect(tabs.has('future')).toBe(true) })
    transport.emit('Target.targetInfoChanged', {
      targetInfo: { targetId: 'future', type: 'page', url: 'https://future.test/2', title: 'Future 2' },
    })
    expect(tabs.tab('future')).toMatchObject({ url: 'https://future.test/2', title: 'Future 2', origin: 'adopted' })
    transport.emit('Target.targetDestroyed', { targetId: 'existing-b' })
    expect(tabs.has('existing-b')).toBe(false)

    transport.responses.set('Target.createTarget', { targetId: 'created' })
    expect(await tabs.createTab({ sessionId: 'session-a' })).toMatchObject({ id: 'created', origin: 'created' })
    expect(transport.callsOf('Emulation.setDeviceMetricsOverride')).toHaveLength(0)
    await tabs.dispose()
    expect(transport.callsOf('Target.closeTarget')).toHaveLength(0)
    expect(transport.callsOf('Browser.close')).toHaveLength(0)
  })

  it('operator keeps a real tab registered when the browser refuses its close command', async () => {
    // Given an adopted page whose browser rejects Target.closeTarget
    // When the close is attempted
    // Then the error is visible and the local tab is not falsely removed
    const transport = realTransport()
    transport.responses.set('Target.closeTarget', () => { throw new Error('close refused') })
    const tabs = new TabManager({ transport, discoverTargets: true, pinViewport: false })
    await tabs.discoverExistingTabs()
    await expect(tabs.closeTab('existing-a')).rejects.toThrow('close refused')
    expect(tabs.has('existing-a')).toBe(true)
  })

  it('operator drops a half-initialized target and detaches it when domain setup fails', async () => {
    // Given a page that attaches but refuses Page.enable
    // When target adoption fails during domain setup
    // Then the partial record is removed and its CDP session is detached
    const transport = realTransport()
    transport.responses.set('Target.getTargets', { targetInfos: [{ targetId: 'broken', type: 'page' }] })
    transport.responses.set('Page.enable', () => { throw new Error('domain refused') })
    const tabs = new TabManager({ transport, discoverTargets: true, pinViewport: false })
    await tabs.discoverExistingTabs()
    expect(tabs.has('broken')).toBe(false)
    expect(transport.callsOf('Target.detachFromTarget')).toHaveLength(1)
  })
})

describe('real-browser service boundaries', () => {
  it('operator discovers on browser_tabs, enforces close rules, and detaches without closing pages', async () => {
    // Given a real-browser service with two existing pages
    // When tabs are listed and closed through panel, explicit agent, and reconfigure paths
    // Then only the explicit agent close reaches the page and reconfigure only detaches
    const transport = realTransport()
    let opens = 0
    const service = new BrowserViewService({
      resolveConfig: () => ({ mode: 'cdp', cdpEndpoint: 'http://127.0.0.1:9222' }),
      openSession: async options => {
        opens += 1
        const session = realSession(transport, options)
        await session.tabs.discoverExistingTabs()
        return session
      },
    })

    const listed = await service.listTabs()
    expect(opens).toBe(1)
    expect(listed.tabs.map(tab => tab.id)).toEqual(['existing-a', 'existing-b'])
    expect(service.state()).toMatchObject({ mode: 'cdp', cdpEndpoint: 'http://127.0.0.1:9222', running: true })

    const panel = sink()
    service.attach(panel.sink)
    await service.handleCommand(panel.sink, { v: 1, kind: 'close-tab', tabId: 'existing-a' })
    expect(panel.events.some(event => event.kind === 'error' && event.code === 'command-failed')).toBe(true)
    expect((await service.listTabs()).tabs).toHaveLength(2)
    expect(await service.closeOwnTabs('session-a', 'existing-a')).toEqual(['existing-a'])
    expect(transport.callsOf('Target.closeTarget')).toHaveLength(1)

    await service.reconfigure()
    expect(transport.closed).toBe(true)
    expect(transport.callsOf('Target.closeTarget')).toHaveLength(1)
    expect(transport.callsOf('Browser.close')).toHaveLength(0)
  })

  it('operator connects for an explicit real-tab close even before the first tab listing', async () => {
    // Given a real-browser service that has not connected yet
    // When an agent names an existing tab id to close
    // Then discovery runs once and exactly that page is closed
    const transport = realTransport()
    let opens = 0
    const service = new BrowserViewService({
      resolveConfig: () => ({ mode: 'cdp', cdpEndpoint: 'http://127.0.0.1:9222' }),
      openSession: async options => {
        opens += 1
        const session = realSession(transport, options)
        await session.tabs.discoverExistingTabs()
        return session
      },
    })
    expect(await service.closeOwnTabs('session-a', 'existing-b')).toEqual(['existing-b'])
    expect(opens).toBe(1)
    expect(transport.callsOf('Target.closeTarget')).toHaveLength(1)
  })

  it('operator restarts an attached panel stream when the browser source changes', async () => {
    // Given a mounted panel with no current browser session
    // When configuration changes from isolated to real-browser mode
    // Then discovery and screencast start without another attach or tool call
    const transport = realTransport()
    let mode: 'isolated' | 'cdp' = 'isolated'
    let opens = 0
    const panel = sink()
    const service = new BrowserViewService({
      resolveConfig: () => ({ mode, cdpEndpoint: 'http://127.0.0.1:9222' }),
      openSession: async options => {
        opens += 1
        const session = realSession(transport, options)
        await session.tabs.discoverExistingTabs()
        return session
      },
    })
    service.attach(panel.sink)
    expect(opens).toBe(0)
    mode = 'cdp'
    await service.reconfigure()
    expect(opens).toBe(1)
    expect(transport.callsOf('Target.getTargets')).toHaveLength(1)
    expect(transport.callsOf('Page.startScreencast')).toHaveLength(1)
    expect(service.state().activeTabId).toBe('existing-b')
  })

  it('operator reports a CDP failure without a second factory attempt or an isolated fallback', async () => {
    // Given a real-browser factory that refuses its first connection
    // When tabs are requested
    // Then one failure is reported with no second attempt or isolated downgrade
    let opens = 0
    const panel = sink()
    const service = new BrowserViewService({
      resolveConfig: () => ({ mode: 'cdp', cdpEndpoint: 'http://127.0.0.1:9222' }),
      openSession: async () => {
        opens += 1
        throw new Error('connection refused')
      },
    })
    service.attach(panel.sink)
    await expect(service.listTabs()).rejects.toThrow('connection refused')
    expect(opens).toBe(1)
    expect(service.state()).toMatchObject({ mode: 'cdp', running: false, message: 'connection refused' })
    expect(panel.events.some(event => event.kind === 'error' && event.code === 'browser-connect-failed')).toBe(true)
  })
})
