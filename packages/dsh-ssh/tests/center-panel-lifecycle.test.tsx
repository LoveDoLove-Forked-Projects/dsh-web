// @vitest-environment jsdom
import { act, useEffect, useState } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mountCenterPanel } from '../src/client/panel-mount-core.ts'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const disposers: Array<() => void> = []
let frames: Map<number, FrameRequestCallback>
let mounted: number
let unmounted: number

function Draft() {
  const [count, setCount] = useState(0)
  useEffect(() => {
    mounted += 1
    return () => { unmounted += 1 }
  }, [])
  return <button onClick={() => { setCount(count + 1) }}>{count}</button>
}

function mount(name: 'ssh' | 'taskboard' | 'skill-explorer' = 'ssh', initiallyOpen = false) {
  let open = initiallyOpen
  const listeners = new Set<() => void>()
  const locales = new Set<() => void>()
  const setOpen = (next: boolean) => {
    if (open === next) return
    open = next
    for (const listener of [...listeners]) listener()
  }
  const render = vi.fn((root: Root) => { root.render(<Draft />) })
  disposers.push(mountCenterPanel({
    render,
    // dataset keys cannot carry dashes, so the family's hyphenated panel names
    // map to the camelCase keys the real wrappers use.
    viewDatasetKey: name.replace(/-/g, '') + 'View', pluginName: name, viewClassName: '',
    // The real family rows: occupancy eviction rides PANEL_FAMILY, so the
    // attribute names under test are the shipped ones.
    activeAttribute: 'data-dsh-' + name + '-active',
    panelName: name,
    isOpen: () => open, close: () => { setOpen(false) },
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    locale: { subscribe: listener => { locales.add(listener); return () => { locales.delete(listener) } } },
  }))
  return { setOpen, render, isOpen: () => open, refreshLocale: () => { for (const listener of locales) listener() } }
}

async function flushMutations() {
  await act(async () => {
    await Promise.resolve()
    const callbacks = [...frames.values()]
    frames.clear()
    for (const callback of callbacks) callback(0)
  })
}

beforeEach(() => {
  document.body.innerHTML = '<main data-pane="conversation"></main>'
  mounted = 0
  unmounted = 0
  frames = new Map()
  let id = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++id, callback); return id })
  vi.stubGlobal('cancelAnimationFrame', (frame: number) => { frames.delete(frame) })
})

afterEach(() => {
  act(() => { for (const dispose of disposers.splice(0)) dispose() })
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

describe('center panel activity', () => {
  it('keeps unused plugin panels empty through mutations and locale changes', async () => {
    const ssh = mount()
    const board = mount('taskboard')
    ssh.refreshLocale()
    board.refreshLocale()
    document.body.appendChild(document.createElement('article'))
    await flushMutations()
    expect(document.querySelectorAll('[data-dsh-plugin]')).toHaveLength(2)
    expect(document.querySelector('button')).toBeNull()
    expect(mounted).toBe(0)
  })

  it('mounts on first open and preserves the visited tree and draft on close/reopen', async () => {
    const panel = mount()
    await act(async () => { panel.setOpen(true) })
    const button = document.querySelector('button')!
    await act(async () => { button.click() })
    expect(button.textContent).toBe('1')
    await act(async () => { panel.setOpen(false) })
    await act(async () => { panel.setOpen(true) })
    expect(document.querySelector('button')).toBe(button)
    expect(button.textContent).toBe('1')
    expect(panel.render).toHaveBeenCalledOnce()
    expect(unmounted).toBe(0)
  })

  it('preserves single-panel occupancy across the three family panels', async () => {
    const ssh = mount('ssh')
    const board = mount('taskboard')
    const skills = mount('skill-explorer')
    await act(async () => { ssh.setOpen(true) })
    await act(async () => { board.setOpen(true) })
    expect(ssh.isOpen()).toBe(false)
    expect(board.isOpen()).toBe(true)
    expect(document.documentElement.hasAttribute('data-dsh-ssh-active')).toBe(false)
    expect(document.documentElement.hasAttribute('data-dsh-taskboard-active')).toBe(true)
    // The third panel evicts whichever panel holds the column, not just its
    // former pairwise sibling.
    await act(async () => { skills.setOpen(true) })
    expect(board.isOpen()).toBe(false)
    expect(ssh.isOpen()).toBe(false)
    expect(document.documentElement.hasAttribute('data-dsh-taskboard-active')).toBe(false)
    expect(document.documentElement.hasAttribute('data-dsh-skill-explorer-active')).toBe(true)
    await act(async () => { ssh.setOpen(true) })
    expect(skills.isOpen()).toBe(false)
    expect(document.documentElement.hasAttribute('data-dsh-skill-explorer-active')).toBe(false)
    expect(mounted).toBe(3)
  })

  it('mounts an already-open panel when the shell arrives later', async () => {
    document.body.replaceChildren()
    mount('ssh', true)
    expect(mounted).toBe(0)
    document.body.innerHTML = '<main data-pane="conversation"></main>'
    await flushMutations()
    expect(document.querySelector('button')).not.toBeNull()
    expect(mounted).toBe(1)
  })

  it('releases a replaced hidden tree and waits until reopening to mount it again', async () => {
    let panel: ReturnType<typeof mount>
    await act(async () => { panel = mount('ssh', true) })
    await act(async () => { panel!.setOpen(false) })
    document.body.innerHTML = '<main data-pane="conversation"></main>'
    await flushMutations()
    expect(unmounted).toBe(1)
    expect(mounted).toBe(1)
    expect(document.querySelector('button')).toBeNull()
    await act(async () => { panel!.setOpen(true) })
    expect(mounted).toBe(2)
  })

  it('does not resurrect a disposed panel when queued mutations flush', async () => {
    await act(async () => { mount('ssh', true) })
    document.body.innerHTML = '<main data-pane="conversation"></main>'
    await Promise.resolve()
    act(() => { disposers.pop()!() })
    await flushMutations()
    expect(document.querySelector('[data-dsh-plugin]')).toBeNull()
    expect(unmounted).toBe(1)
  })
})
