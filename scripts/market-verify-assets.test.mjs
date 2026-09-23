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
  refusalNotice,
  remoteLength,
  reverifySerially,
  runPool,
  transientFailure,
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

test('transientFailure separates a status the burst provoked from a verdict', () => {
  // Given the reasons the sweep can report,
  // When each is classified,
  // Then only the ones the edge may have produced under the burst are re-checked.
  assert.equal(transientFailure('HTTP 403'), true)
  assert.equal(transientFailure('HTTP 503'), true)
  assert.equal(transientFailure('request failed: fetch failed'), true)
  assert.equal(transientFailure('HTTP 404'), false)
  assert.equal(transientFailure('served 40 bytes, dist has 100'), false)
})

test('reverifySerially probes the window and re-checks one path at a time', async () => {
  // Given two paths a burst failed and an origin still inside its rate window,
  const dist = fixtureDist({ skins: [{ id: 'harbor', files: ['skin.json'] }, { id: 'xp', files: ['skin.json'] }] })
  try {
    writeAsset(dist, 'assets/skins/harbor/skin.json', 12)
    writeAsset(dist, 'assets/skins/xp/skin.json', 12)
    const targets = collectTargets(dist, ['skins'])
    const waits = []
    let calls = 0
    let inFlight = 0
    let peak = 0
    const fetchImpl = async () => {
      calls += 1
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await Promise.resolve()
      inFlight -= 1
      // The window is open for the first two probes, then the origin serves.
      return calls > 2
        ? new Response('', { status: 206, headers: { 'content-range': 'bytes 0-0/12' } })
        : new Response('', { status: 403 })
    }

    // When the failures are re-checked,
    const { results, gaveUp } = await reverifySerially('https://example.test', targets, {
      distDir: dist,
      delay: async (ms) => { waits.push(ms) },
      fetchImpl,
      attempts: 1,
      probeStepMs: 5_000,
    })

    // Then every path was re-checked, and the pass never ran two at once.
    assert.equal(gaveUp, false)
    assert.deepEqual([...results.keys()], targets.map(target => target.path))
    assert.deepEqual([...results.values()].map(result => result.ok), [true, true])
    assert.equal(peak, 1, `peak concurrency was ${peak}`)
    // Then it waited for the window to reset before believing the re-check.
    assert.deepEqual(waits, [5_000, 5_000])
  } finally {
    rmSync(dist, { recursive: true, force: true })
  }
})

test('reverifySerially clears a status that only the burst produced', async () => {
  // Given a re-check whose first probe still lands inside the window,
  const dist = fixtureDist({ skins: [{ id: 'harbor', files: ['skin.json'] }] })
  try {
    writeAsset(dist, 'assets/skins/harbor/skin.json', 12)
    const targets = collectTargets(dist, ['skins'])
    let calls = 0
    const fetchImpl = async () => {
      calls += 1
      return calls === 1
        ? new Response('', { status: 403 })
        : new Response('', { status: 206, headers: { 'content-range': 'bytes 0-0/12' } })
    }

    // When the path is re-checked,
    const { results } = await reverifySerially('https://example.test', targets, {
      distDir: dist,
      delay: async () => {},
      fetchImpl,
      attempts: 1,
    })

    // Then the probe that follows the window reports the asset the origin serves.
    assert.deepEqual(results.get('assets/skins/harbor/skin.json'), { ok: true, bytes: 12 })
    assert.equal(calls, 2)
  } finally {
    rmSync(dist, { recursive: true, force: true })
  }
})

test('reverifySerially keeps a repeated verdict and stops on a run of failures', async () => {
  // Given an origin that refuses every re-check and five failed paths,
  const dist = fixtureDist({
    skins: Array.from({ length: 5 }, (_, index) => ({ id: `skin-${index}`, files: ['skin.json'] })),
  })
  try {
    for (let index = 0; index < 5; index++) writeAsset(dist, `assets/skins/skin-${index}/skin.json`, 12)
    const targets = collectTargets(dist, ['skins'])
    assert.equal(targets.length, 5)

    // When the failures are re-checked,
    const { results, gaveUp } = await reverifySerially('https://example.test', targets, {
      distDir: dist,
      delay: async () => {},
      attempts: 1,
      probeBudgetMs: 10_000,
      giveUpAfter: 3,
      fetchImpl: async () => new Response('', { status: 403 }),
    })

    // Then the pass stopped after the streak instead of walking the whole list,
    assert.equal(gaveUp, true)
    assert.equal(results.size, 3)
    // And every path it did re-check kept the status rather than being excused.
    for (const result of results.values()) {
      assert.equal(result.ok, false)
      assert.equal(result.reason, 'HTTP 403')
    }
  } finally {
    rmSync(dist, { recursive: true, force: true })
  }
})

test('refusalNotice names a sweep the edge refused as a vantage policy', () => {
  // Given sweeps that failed for the statuses the edge can answer with,
  const refused = [{ result: { ok: false, reason: 'HTTP 403' } }, { result: { ok: false, reason: 'HTTP 403' } }]
  // When each is summarised,
  // Then only an all-403 sweep is named as a refusal rather than a defect.
  assert.match(refusalNotice(refused), /edge policy on this vantage/)
  assert.equal(refusalNotice([{ result: { ok: false, reason: 'HTTP 403' } }, { result: { ok: false, reason: 'HTTP 404' } }]), '')
  assert.equal(refusalNotice([{ result: { ok: false, reason: 'HTTP 404' } }]), '')
  assert.equal(refusalNotice([]), '')
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
