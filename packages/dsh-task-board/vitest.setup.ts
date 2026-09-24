/**
 * Test-environment repair for the storage global.
 *
 * Node 25 defines `localStorage` on the global object: without
 * `--localstorage-file` its getter returns an empty object, so `getItem`,
 * `setItem` and `clear` are all missing. Vitest's jsdom environment populates
 * globals only where the name is still free, and under vitest `window` is the
 * same object as `globalThis`, so `window.localStorage` stays that stub and
 * every spec that touches storage fails on Node 25 while passing on Node 22
 * (which defines no such global, and jsdom's own storage reaches the spec).
 *
 * A DOM environment gets a usable Storage here, so a spec sees what jsdom
 * would have provided. A host-side spec has the stub removed instead, which is
 * what it sees on Node 22.
 */
class MemoryStorage implements Pick<Storage, 'length' | 'clear' | 'getItem' | 'key' | 'removeItem' | 'setItem'> {
  private readonly entries = new Map<string, string>()

  get length(): number {
    return this.entries.size
  }

  clear(): void {
    this.entries.clear()
  }

  getItem(key: string): string | null {
    return this.entries.get(key) ?? null
  }

  key(index: number): string | null {
    return [...this.entries.keys()][index] ?? null
  }

  removeItem(key: string): void {
    this.entries.delete(key)
  }

  setItem(key: string, value: string): void {
    this.entries.set(String(key), String(value))
  }
}

if (typeof globalThis.localStorage?.getItem !== 'function') {
  if (typeof document === 'undefined') {
    delete (globalThis as { localStorage?: Storage }).localStorage
  } else {
    Object.defineProperty(globalThis, 'localStorage', {
      value: new MemoryStorage(),
      configurable: true,
      writable: true,
    })
  }
}
