/**
 * market-verify-assets contract: the manifest is the list of paths a user can
 * be asked to install, so the walker must enumerate exactly those paths and
 * report a size mismatch rather than trusting the status code alone.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  assetPaths,
  collectTargets,
  loadManifest,
  remoteLength,
  runPool,
  verifyLocal,
  verifyOrigin,
} from './market-verify-assets.mjs'

function fixtureDist(manifests) {
  const dist = mkdtempSync(join(tmpdir(), 'market-dist-'))
  mkdirSync(join(dist, 'manifest'), { recursive: true })
  for (const [kind, items] of Object.entries(manifests)) {
    writeFileSync(join(dist, 'manifest', `${kind}.json`), JSON.stringify({ items }))
  }
  return dist
}

function writeAsset(dist, relPath, bytes) {
  const abs = join(dist, relPath)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, 'x'.repeat(bytes))
}

test('assetPaths prefixes the file list and folds in previews without duplicates', () => {
  const skins = assetPaths(
    { id: 'harbor', files: ['skin.json', 'skin.css'], preview: { light: 'assets/skins/harbor/preview/light.jpg' } },
    'skins',
  )
  assert.deepEqual(skins, [
    'assets/skins/harbor/skin.json',
    'assets/skins/harbor/skin.css',
    'assets/skins/harbor/preview/light.jpg',
  ])

  const pets = assetPaths(
    {
      id: 'doro',
      files: ['pet.json'],
      previews: ['assets/pets/doro/previews/idle.gif'],
      spritesheet: 'assets/pets/doro/spritesheet.webp',
    },
    'pets',
  )
  assert.deepEqual(pets, [
    'assets/pets/doro/pet.json',
    'assets/pets/doro/previews/idle.gif',
    'assets/pets/doro/spritesheet.webp',
  ])
})

test('loadManifest explains a missing manifest instead of crashing', () => {
  const dist = mkdtempSync(join(tmpdir(), 'market-dist-empty-'))
  try {
    assert.throws(() => loadManifest(dist, 'skins'), /manifest not found/)
  } finally {
    rmSync(dist, { recursive: true, force: true })
  }
})

test('collectTargets covers every listed path of every entry', () => {
  const dist = fixtureDist({
    skins: [{ id: 'harbor', files: ['skin.json'] }],
    pets: [{ id: 'doro', files: ['pet.json'], previews: ['assets/pets/doro/previews/idle.gif'] }],
  })
  try {
    const paths = collectTargets(dist, ['skins', 'pets']).map(target => target.path)
    assert.deepEqual(paths, [
      'assets/skins/harbor/skin.json',
      'assets/pets/doro/pet.json',
      'assets/pets/doro/previews/idle.gif',
    ])
  } finally {
    rmSync(dist, { recursive: true, force: true })
  }
})

test('verifyLocal passes on a present file and names a missing one', () => {
  const dist = mkdtempSync(join(tmpdir(), 'market-dist-local-'))
  try {
    writeAsset(dist, 'assets/skins/harbor/skin.json', 12)
    const ok = verifyLocal(dist, { path: 'assets/skins/harbor/skin.json' })
    assert.deepEqual(ok, { ok: true, bytes: 12 })

    const missing = verifyLocal(dist, { path: 'assets/skins/gone/skin.json' })
    assert.equal(missing.ok, false)
    assert.match(missing.reason, /missing from market\/dist/)
  } finally {
    rmSync(dist, { recursive: true, force: true })
  }
})

test('remoteLength reads the total from content-range on a ranged GET', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, range: init?.headers?.Range })
    return new Response('', { status: 206, headers: { 'content-range': 'bytes 0-0/4242' } })
  }
  const measured = await remoteLength('https://example.test/a.webp', fetchImpl)
  assert.equal(measured.bytes, 4242)
  assert.equal(calls[0].range, 'bytes=0-0')
})

test('verifyOrigin reports a truncated asset and accepts a matching one', async () => {
  const dist = mkdtempSync(join(tmpdir(), 'market-dist-origin-'))
  try {
    writeAsset(dist, 'assets/pets/doro/pet.json', 100)
    const target = { kind: 'pets', id: 'doro', path: 'assets/pets/doro/pet.json' }

    const truncated = await verifyOrigin('https://example.test', target, {
      distDir: dist,
      fetchImpl: async () => new Response('', { status: 206, headers: { 'content-range': 'bytes 0-0/40' } }),
    })
    assert.equal(truncated.ok, false)
    assert.match(truncated.reason, /served 40 bytes, dist has 100/)

    const matching = await verifyOrigin('https://example.test', target, {
      distDir: dist,
      fetchImpl: async () => new Response('', { status: 206, headers: { 'content-range': 'bytes 0-0/100' } }),
    })
    assert.deepEqual(matching, { ok: true, bytes: 100 })
  } finally {
    rmSync(dist, { recursive: true, force: true })
  }
})

test('verifyOrigin surfaces a non-2xx status', async () => {
  const result = await verifyOrigin(
    'https://example.test',
    { kind: 'skins', id: 'x', path: 'assets/skins/x/skin.json' },
    { distDir: '/nonexistent', fetchImpl: async () => new Response('', { status: 404 }) },
  )
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'HTTP 404')
})

test('remoteLength retries a transient edge status and reports the served length', async () => {
  // Given a burst against an edge origin that answers 403 once and then serves,
  let calls = 0
  const fetchImpl = async () => {
    calls += 1
    return calls === 1
      ? new Response('', { status: 403 })
      : new Response('', { status: 206, headers: { 'content-range': 'bytes 0-0/4242' } })
  }
  // When the probe reads the length,
  const measured = await remoteLength('https://example.test/a.webp', fetchImpl, { delay: async () => {} })
  // Then it retries the transient status and reports the real length.
  assert.deepEqual(measured, { bytes: 4242 })
  assert.equal(calls, 2)
})

test('remoteLength reports a transient status that survives every attempt', async () => {
  // Given an origin that answers 403 for the whole retry budget,
  let calls = 0
  const fetchImpl = async () => {
    calls += 1
    return new Response('', { status: 403 })
  }
  // When the probe reads the length,
  const measured = await remoteLength('https://example.test/a.webp', fetchImpl, { delay: async () => {} })
  // Then it gives up and reports the status rather than inventing a length.
  assert.deepEqual(measured, { error: 'HTTP 403' })
  assert.equal(calls, 3)
})

test('remoteLength does not retry a status the origin means', async () => {
  // Given an origin that answers 404, which is a verdict rather than a hiccup,
  let calls = 0
  const fetchImpl = async () => {
    calls += 1
    return new Response('', { status: 404 })
  }
  // When the probe reads the length,
  const measured = await remoteLength('https://example.test/a.webp', fetchImpl, { delay: async () => {} })
  // Then it reports the status on the first answer.
  assert.deepEqual(measured, { error: 'HTTP 404' })
  assert.equal(calls, 1)
})

test('runPool keeps result order and never exceeds the concurrency bound', async () => {
  let inFlight = 0
  let peak = 0
  const items = Array.from({ length: 25 }, (_, index) => index)
  // A microtask yield is enough for the other runners to pick up their first
  // item, so the peak is observable without any wall-clock waiting.
  const results = await runPool(items, 4, async (item) => {
    inFlight++
    peak = Math.max(peak, inFlight)
    await Promise.resolve()
    inFlight--
    return item * 2
  })
  assert.deepEqual(results, items.map(item => item * 2))
  assert.ok(peak <= 4, `peak concurrency was ${peak}`)
  assert.ok(peak > 1, `expected real parallelism, peak was ${peak}`)
})
