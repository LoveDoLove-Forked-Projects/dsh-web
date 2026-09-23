#!/usr/bin/env node
/**
 * market-verify-assets - prove the deployed market actually serves every asset
 * its manifests advertise.
 *
 * The manifests are the contract: the Workshop installs from
 * manifest/<kind>.json, so any path listed there that the site cannot serve is
 * a broken install for a user. This gate walks every listed path and fails on
 * the first mismatch, which makes a partial upload or a stale manifest loud
 * instead of silent.
 *
 * Usage:
 *   node scripts/market-verify-assets.mjs [--dist]
 *   node scripts/market-verify-assets.mjs --origin https://dsh-market.com
 *   node scripts/market-verify-assets.mjs --kind skins --concurrency 8
 *
 *   --dist            check the local market/dist tree (default)
 *   --origin <url>    check a deployed origin over HTTP
 *   --kind a,b        restrict to skins and/or pets (default: both)
 *   --concurrency N   parallel requests (default 4)
 *   --limit N         stop after N paths (smoke runs)
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = resolve(SCRIPT_DIR, '..')
export const DIST_DIR = join(REPO_ROOT, 'market', 'dist')
const DEFAULT_ORIGIN = 'https://dsh-market.com'
export const KINDS = ['skins', 'pets']

/**
 * Every site-relative path one manifest entry advertises.
 *
 * skins: each entry's file list is relative to assets/skins/<id>/.
 * pets:  each entry's file list is relative to assets/pets/<id>/, while
 *        previews and the sprite sheet are already site-relative.
 */
export function assetPaths(item, kind) {
  const base = `assets/${kind}/${item.id}/`
  const paths = (item.files ?? []).map(file => base + file)
  if (kind === 'skins') {
    for (const preview of Object.values(item.preview ?? {})) if (preview) paths.push(preview)
  } else {
    for (const preview of item.previews ?? []) paths.push(preview)
    if (item.spritesheet) paths.push(item.spritesheet)
  }
  return [...new Set(paths)]
}

/** Read one emitted manifest. */
export function loadManifest(distDir, kind) {
  const file = join(distDir, 'manifest', `${kind}.json`)
  if (!existsSync(file)) throw new Error(`manifest not found: ${file} (run node scripts/market-build)`)
  const parsed = JSON.parse(readFileSync(file, 'utf8'))
  if (!Array.isArray(parsed.items)) throw new Error(`manifest ${file} has no "items" array`)
  return parsed
}

/** Every {kind, id, path} the run must verify. */
export function collectTargets(distDir, kinds) {
  const targets = []
  for (const kind of kinds) {
    for (const item of loadManifest(distDir, kind).items) {
      for (const path of assetPaths(item, kind)) targets.push({ kind, id: item.id, path })
    }
  }
  return targets
}

/** Verify one target against the local dist tree. */
export function verifyLocal(distDir, target) {
  const abs = join(distDir, target.path)
  if (!existsSync(abs)) return { ok: false, reason: 'missing from market/dist' }
  return { ok: true, bytes: statSync(abs).size }
}

/** Backoff between retries; injected by tests so they stay deterministic. */
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Statuses an edge origin returns transiently under a burst: the deploy sweep
 * walks thousands of paths and Cloudflare answers part of a fast run with 403
 * before the rate window resets, which says nothing about the asset.
 */
export function isTransientStatus(status) {
  return status === 403 || status === 408 || status === 429 || status >= 500
}

/**
 * Total byte length a deployed origin serves for one path.
 *
 * A HEAD request is not enough: the Workers static-asset layer answers it with
 * `content-length: 0`, which would report every asset as truncated. A one-byte
 * ranged GET reports the real total in `content-range` while still transferring
 * a single byte.
 *
 * A transient status is retried with backoff so a burst cannot fail the sweep
 * for an asset the origin serves; a status that survives every attempt is
 * reported as it came back.
 */
export async function remoteLength(url, fetchImpl = fetch, { attempts = 3, delay = sleep } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    const res = await fetchImpl(url, { headers: { Range: 'bytes=0-0' } })
    let retry = false
    try {
      if (!res.ok && res.status !== 206) {
        retry = attempt < attempts && isTransientStatus(res.status)
        if (!retry) return { error: `HTTP ${res.status}` }
      } else {
        const contentRange = res.headers.get('content-range')
        const ranged = contentRange === null ? Number.NaN : Number(contentRange.split('/').pop())
        if (Number.isFinite(ranged)) return { bytes: ranged }
        const length = Number(res.headers.get('content-length'))
        return { bytes: Number.isFinite(length) ? length : undefined }
      }
    } finally {
      // Drain the single byte (or cancel) so the connection is released.
      await res.arrayBuffer().catch(() => {})
    }
    if (retry) await delay(attempt * 500)
  }
}

/** Verify one target against a deployed origin. */
export async function verifyOrigin(origin, target, { fetchImpl = fetch, distDir, attempts, delay } = {}) {
  const url = `${origin.replace(/\/+$/, '')}/${target.path}`
  let measured
  try {
    measured = await remoteLength(url, fetchImpl, { attempts, delay })
  } catch (error) {
    return { ok: false, reason: `request failed: ${error.message}` }
  }
  if (measured.error !== undefined) return { ok: false, reason: measured.error }
  const localFile = join(distDir, target.path)
  if (measured.bytes !== undefined && existsSync(localFile)) {
    const local = statSync(localFile).size
    if (measured.bytes !== local) return { ok: false, reason: `served ${measured.bytes} bytes, dist has ${local}` }
  }
  return { ok: true, bytes: measured.bytes }
}

/** Run `worker` over `items` with bounded concurrency, preserving order. */
export async function runPool(items, concurrency, worker) {
  const results = new Array(items.length)
  let next = 0
  const runners = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return results
}

function parseArgs(argv) {
  const options = { mode: 'dist', origin: DEFAULT_ORIGIN, kinds: [...KINDS], concurrency: 4, limit: 0 }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--dist') options.mode = 'dist'
    else if (arg === '--origin') {
      options.mode = 'origin'
      const value = argv[++i]
      if (value === undefined || value.startsWith('--')) throw new Error('--origin needs a URL')
      options.origin = value
    } else if (arg === '--kind') {
      const value = argv[++i]
      if (value === undefined) throw new Error('--kind needs a value')
      options.kinds = value.split(',').map(kind => kind.trim()).filter(Boolean)
    } else if (arg === '--concurrency') {
      options.concurrency = Number(argv[++i])
    } else if (arg === '--limit') {
      options.limit = Number(argv[++i])
    } else if (arg === '--help' || arg === '-h') {
      options.help = true
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  return options
}

async function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`market-verify-assets: ${error.message}`)
    process.exit(2)
  }
  if (options.help) {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0])
    return
  }
  const unknown = options.kinds.filter(kind => !KINDS.includes(kind))
  if (unknown.length > 0) {
    console.error(`market-verify-assets: unknown kind(s): ${unknown.join(', ')}`)
    process.exit(2)
  }

  let targets
  try {
    targets = collectTargets(DIST_DIR, options.kinds)
  } catch (error) {
    console.error(`market-verify-assets: ${error.message}`)
    process.exit(1)
  }
  if (options.limit > 0) targets = targets.slice(0, options.limit)

  const where = options.mode === 'origin' ? options.origin : DIST_DIR
  console.log(`[market-verify-assets] ${targets.length} path(s) from ${options.kinds.join(', ')} against ${where}`)

  const results = await runPool(targets, options.concurrency, async (target) => {
    const result = options.mode === 'origin'
      ? await verifyOrigin(options.origin, target, { distDir: DIST_DIR })
      : verifyLocal(DIST_DIR, target)
    return { target, result }
  })

  const failures = results.filter(entry => !entry.result.ok)
  const bytes = results.reduce((total, entry) => total + (entry.result.bytes ?? 0), 0)
  for (const entry of failures.slice(0, 20)) {
    console.error(`[market-verify-assets] FAIL ${entry.target.kind}/${entry.target.id}: ${entry.target.path} - ${entry.result.reason}`)
  }
  if (failures.length > 20) console.error(`[market-verify-assets] ... and ${failures.length - 20} more`)

  if (failures.length > 0) {
    console.error(`[market-verify-assets] ${failures.length}/${targets.length} path(s) failed`)
    process.exit(1)
  }
  console.log(`[market-verify-assets] OK: ${targets.length} path(s), ${(bytes / 1048576).toFixed(1)} MiB`)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main()
}
