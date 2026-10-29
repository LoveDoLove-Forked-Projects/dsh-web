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
    const previous = this.#rows.get(keyOf(provider, model))
    this.#rows.set(keyOf(provider, model), { provider, model, effort })
    try {
      await this.#persist()
    } catch (error) {
      if (previous === undefined) this.#rows.delete(keyOf(provider, model))
      else this.#rows.set(keyOf(provider, model), previous)
      throw error
    }
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
    if (!Array.isArray(rows) || !rows.every(isPreference)) {
      this.#log(`model effort table ${this.#file} has no valid effort rows; continuing with an empty table`)
      return
    }
    for (const row of rows) this.#rows.set(keyOf(row.provider, row.model), { provider: row.provider, model: row.model, effort: row.effort })
    this.#log(`model effort table ${this.#file}: ${rows.length} remembered model(s)`)
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
