/**
 * The host's per-model reasoning-effort preferences:
 * `$DSH_HOME/remote-bridge/model-efforts.json`.
 *
 * A preference belongs to a MODEL, not to a session or a device: the phone picks
 * a level for one model once, and every session on this host that later selects
 * that model is handed the same level. The table therefore has exactly one scope
 * — the whole host — and nothing expires an entry when a session ends.
 *
 * It is deliberately not the catalog's `reasoning.defaultEffort`: that is what
 * the harness publishes for a model, this is what the user chose here, and the
 * two disagree the moment somebody picks a level the catalog does not call the
 * default. The wire keeps them apart too (`session.models` rows carry this one
 * as `preferredEffort`, beside the catalog's own `reasoning`).
 * @module dsh-remote-bridge/core/model-efforts
 */

import { chmod, mkdir, open, readFile, rename } from 'node:fs/promises'
import { dirname } from 'node:path'

/** The schema version this build writes; an older file is read as the table it is. */
export const EFFORT_TABLE_VERSION = 1

/** One remembered choice: the model it belongs to and the level it was given. */
export interface EffortPreference {
  readonly provider: string
  readonly model: string
  readonly effort: string
}

export interface ModelEffortPreferencesOptions {
  /** Absolute path of the preference file. */
  readonly file: string
  readonly log?: (message: string) => void
}

/**
 * The key one model is remembered under: a provider id and a model id, which are
 * only unique together.
 * @param provider - provider id, as the catalog's group id spells it.
 * @param model - model id, as the catalog's row id spells it.
 * @returns the table key of that pair.
 */
function keyOf(provider: string, model: string): string {
  return `${provider}\u0000${model}`
}

/** @returns whether a row read from the file is a preference this build can use. */
function isPreference(value: unknown): value is EffortPreference {
  if (typeof value !== 'object' || value === null) return false
  const row = value as Record<string, unknown>
  return typeof row.provider === 'string' && row.provider !== ''
    && typeof row.model === 'string' && row.model !== ''
    && typeof row.effort === 'string' && row.effort !== ''
}

/**
 * The persisted effort table, shared by every connection of one host.
 *
 * Read once per process and written atomically: a corrupt file is an EMPTY table
 * with one log line, never a failed mount — a phone must still be able to read
 * the catalog and pick a model on a host whose preference file went bad, and the
 * next write replaces the file rather than writing into the damage.
 */
export class ModelEffortPreferences {
  readonly #file: string
  readonly #log: (message: string) => void
  readonly #rows = new Map<string, EffortPreference>()
  #loaded: Promise<void> | undefined
  #writeQueue: Promise<void> = Promise.resolve()

  constructor(options: ModelEffortPreferencesOptions) {
    this.#file = options.file
    this.#log = options.log ?? (() => undefined)
  }

  /**
   * Read the table once. A missing file is an empty table, and an unreadable or
   * malformed one is reported and then read as empty.
   * @returns when the in-memory table reflects the file.
   */
  load(): Promise<void> {
    this.#loaded ??= this.#read()
    return this.#loaded
  }

  /**
   * @param provider - provider id.
   * @param model - model id.
   * @returns the level remembered for that model, or undefined when the table has none.
   */
  effortOf(provider: string, model: string): string | undefined {
    return this.#rows.get(keyOf(provider, model))?.effort
  }

  /**
   * Remember one level and persist it before answering.
   *
   * The write is what the caller is told succeeded, so the memory copy is set
   * first only for the duration of it: a failed write rejects, and the answer
   * the client sees is the failure rather than a level this host never stored.
   * @param provider - provider id.
   * @param model - model id.
   * @param effort - the level chosen for that model.
   */
  async save(provider: string, model: string, effort: string): Promise<void> {
    const key = keyOf(provider, model)
    const previous = this.#rows.get(key)
    const written: EffortPreference = { provider, model, effort }
    this.#rows.set(key, written)
    try {
      await this.#persist()
    } catch (error) {
      // Only this call's own value is rolled back: a later save that already
      // replaced it in memory is the newer truth, and restoring the older level
      // here would silently undo a choice nothing failed on.
      if (this.#rows.get(key) === written) {
        if (previous === undefined) this.#rows.delete(key)
        else this.#rows.set(key, previous)
      }
      throw error
    }
  }

  /**
   * Drop the remembered level for one model, but only the one judged stale.
   *
   * A level a model stopped publishing is worse than none at all: the backfill in
   * `session.setModel` would send it, the harness would refuse, and the model
   * would become unswitchable — and because that backfill is the only writer, the
   * row could never heal itself. Dropping it makes the next switch plain.
   *
   * The `staleEffort` argument is what keeps that cure from being worse than the
   * disease: an awaited catalog read sits between judging a level stale and
   * arriving here, and frames of one connection are dispatched concurrently, so
   * the user may have typed a NEW level in that window. A row that no longer holds
   * the level this caller judged is a newer choice, and it survives.
   * @param provider - provider id.
   * @param model - model id.
   * @param staleEffort - the level this caller found the catalog no longer offers.
   * @param reason - why it is being dropped, for the log line.
   */
  async forget(provider: string, model: string, staleEffort: string, reason: string): Promise<void> {
    const key = keyOf(provider, model)
    const previous = this.#rows.get(key)
    if (previous === undefined || previous.effort !== staleEffort) return
    this.#rows.delete(key)
    try {
      await this.#persist()
    } catch (error) {
      // Same rule on the way back: a row that appeared while the write failed is
      // a newer choice, and restoring the stale one would undo it.
      if (this.#rows.get(key) === undefined) this.#rows.set(key, previous)
      throw error
    }
    this.#log(`model effort table: dropped ${provider}/${model} = ${previous.effort} (${reason})`)
  }

  async #read(): Promise<void> {
    let text: string
    try {
      text = await readFile(this.#file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      this.#log(`model effort table ${this.#file} is unreadable (${String(error)}); continuing with an empty table`)
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      this.#log(`model effort table ${this.#file} is not JSON; continuing with an empty table`)
      return
    }
    const rows = (parsed as { efforts?: unknown } | null)?.efforts
    if (!Array.isArray(rows)) {
      this.#log(`model effort table ${this.#file} has no effort table; continuing with an empty table`)
      return
    }
    // One unreadable row is not a reason to lose the rest: the table is written
    // WHOLE on the next save, so every row dropped here would be erased by that
    // write. Keeping everything this build can read is what makes that write
    // preserve the user's other choices.
    let dropped = 0
    for (const row of rows) {
      if (!isPreference(row)) {
        dropped += 1
        continue
      }
      this.#rows.set(keyOf(row.provider, row.model), { provider: row.provider, model: row.model, effort: row.effort })
    }
    if (dropped > 0) this.#log(`model effort table ${this.#file}: dropped ${dropped} unreadable row(s)`)
    this.#log(`model effort table ${this.#file}: ${rows.length - dropped} remembered model(s)`)
  }

  /**
   * Write the table atomically: same directory, 0600 from creation, flushed
   * before the rename so a crash cannot leave a truncated file in place.
   * Writes are serialized so two sessions choosing the same model cannot race
   * the replacement.
   */
  async #persist(): Promise<void> {
    const pending = this.#writeQueue.then(() => this.#write())
    this.#writeQueue = pending.catch(() => undefined)
    return pending
  }

  async #write(): Promise<void> {
    const directory = dirname(this.#file)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const payload = JSON.stringify({ version: EFFORT_TABLE_VERSION, efforts: [...this.#rows.values()] }, null, 2)
    const temporary = `${this.#file}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`
    const handle = await open(temporary, 'w', 0o600)
    try {
      await handle.writeFile(payload, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, this.#file)
    await chmod(this.#file, 0o600)
  }
}
