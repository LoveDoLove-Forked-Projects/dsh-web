import BetterSqlite3 from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * The SQLite data layer and the D1 surface the shared Worker modules expect.
 *
 * team-hub/src keeps every query as a prepared statement with bound parameters
 * and reads the D1 result envelope (first / all / run / batch and
 * meta.changes). Implementing that envelope over better-sqlite3 lets the whole
 * domain layer and its lease state machine run unchanged, instead of being
 * rewritten against a second data API that could drift from it.
 *
 * Writes are synchronous: better-sqlite3 executes on the event loop thread, so
 * one statement or one batch can never interleave with another. That is what
 * the Durable Object used to provide per team, and why no lock or queue is
 * needed here.
 */

export type SqliteDatabase = InstanceType<typeof BetterSqlite3>

class SqliteStatement implements D1PreparedStatement {
  readonly #database: SqliteDatabase
  readonly #sql: string
  readonly #params: unknown[]

  constructor(database: SqliteDatabase, sql: string, params: unknown[] = []) {
    this.#database = database
    this.#sql = sql
    this.#params = params
  }

  bind(...values: unknown[]): D1PreparedStatement {
    // D1 refuses undefined bindings; the domain layer never passes one, but
    // normalising here keeps an accidental undefined a NULL instead of a crash
    // raised from inside the native driver.
    return new SqliteStatement(
      this.#database,
      this.#sql,
      values.map((value) => (value === undefined ? null : value)),
    )
  }

  /** One execution, used by all(), run() and batch() so the semantics match. */
  execute(): D1Result<unknown> {
    const prepared = this.#database.prepare(this.#sql)
    if (prepared.reader) {
      const rows = prepared.all(...(this.#params as never[])) as unknown[]
      return { success: true, results: rows, meta: { changes: 0, last_row_id: 0 } }
    }
    const info = prepared.run(...(this.#params as never[]))
    return {
      success: true,
      results: [],
      meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid) },
    }
  }

  async first<T = unknown>(colName?: string): Promise<T | null> {
    const prepared = this.#database.prepare(this.#sql)
    const row = prepared.get(...(this.#params as never[])) as Record<string, unknown> | undefined
    if (row === undefined) return null
    if (colName === undefined) return row as T
    const value = row[colName]
    return (value === undefined ? null : value) as T
  }

  async all<T = unknown>(): Promise<D1Result<T>> {
    return this.execute() as D1Result<T>
  }

  async run<T = unknown>(): Promise<D1Result<T>> {
    return this.execute() as D1Result<T>
  }
}

export class SqliteD1Database implements D1Database {
  readonly #database: SqliteDatabase

  constructor(database: SqliteDatabase) {
    this.#database = database
  }

  prepare(query: string): D1PreparedStatement {
    return new SqliteStatement(this.#database, query)
  }

  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    // One transaction, like a D1 batch: either every statement lands or none
    // does, which the comment+mention and bootstrap writes rely on.
    const runAll = this.#database.transaction((entries: SqliteStatement[]) =>
      entries.map((statement) => statement.execute()),
    )
    return runAll(statements as SqliteStatement[]) as D1Result<T>[]
  }

  async exec(query: string): Promise<{ count: number; duration: number }> {
    this.#database.exec(query)
    return { count: 0, duration: 0 }
  }

  /** Readiness probe: the file answers one trivial query. */
  probe(): boolean {
    return this.#database.prepare('SELECT 1 AS ok').get() !== undefined
  }
}

export interface OpenedDatabase {
  /** Direct handle for migrations and readiness reporting. */
  sqlite: SqliteDatabase
  /** D1-compatible handle the shared Worker modules receive as env.DB. */
  d1: SqliteD1Database
  path: string
  close(): void
}

export function openDatabase(path: string): OpenedDatabase {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const sqlite = new BetterSqlite3(path)
  // WAL keeps a checkpoint cheap and lets an operator read the file while the
  // service runs; foreign keys are enforced because D1 enforced them.
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('synchronous = NORMAL')
  sqlite.pragma('foreign_keys = ON')
  sqlite.pragma('busy_timeout = 5000')
  return {
    sqlite,
    d1: new SqliteD1Database(sqlite),
    path,
    close: () => sqlite.close(),
  }
}
