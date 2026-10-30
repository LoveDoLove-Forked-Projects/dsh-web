import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { SqliteDatabase } from './db'

/**
 * Reuses team-hub/migrations/*.sql, the same files the Worker deployment
 * applies through D1. A migration is applied once, inside a transaction, and
 * recorded in the same bookkeeping table D1 uses, so the schema and the ledger
 * stay interchangeable with a database exported from the Worker.
 */

export interface MigrationFile {
  name: string
  sql: string
}

export interface MigrationStatus {
  applied: string[]
  pending: string[]
}

const LEDGER = `CREATE TABLE IF NOT EXISTS d1_migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
)`

export function readMigrations(dir: string): MigrationFile[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') }))
}

function ledger(db: SqliteDatabase, dir: string): void {
  db.exec(LEDGER)
}

function appliedNames(db: SqliteDatabase): string[] {
  const rows = db.prepare('SELECT name FROM d1_migrations ORDER BY id').all() as { name: string }[]
  return rows.map((row) => row.name)
}

export interface MigrationReport {
  /** Every migration on disk, oldest first. */
  applied: string[]
  /** Migrations this run applied. */
  newlyApplied: string[]
}

/** Apply every migration the ledger does not hold yet; idempotent. */
export function applyMigrations(db: SqliteDatabase, dir: string): MigrationReport {
  ledger(db, dir)
  const files = readMigrations(dir)
  const done = new Set(appliedNames(db))
  const newlyApplied: string[] = []
  for (const file of files) {
    if (done.has(file.name)) continue
    // The schema change and its ledger row commit together, so a crash can
    // never leave a half-applied migration recorded as done.
    db.transaction(() => {
      db.exec(file.sql)
      db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run(file.name)
    })()
    newlyApplied.push(file.name)
  }
  return { applied: files.map((file) => file.name), newlyApplied }
}

/** Which migrations on disk are not in the ledger yet; readiness reads this. */
export function migrationStatus(db: SqliteDatabase, dir: string): MigrationStatus {
  ledger(db, dir)
  const done = new Set(appliedNames(db))
  const names = readMigrations(dir).map((file) => file.name)
  return {
    applied: names.filter((name) => done.has(name)),
    pending: names.filter((name) => !done.has(name)),
  }
}
