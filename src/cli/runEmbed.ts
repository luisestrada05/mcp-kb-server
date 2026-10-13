import { existsSync } from 'node:fs'
import { Database } from '../db/Database.js'
import { runMigrations } from '../db/migrations.js'
import { VectorRepo } from '../repos/VectorRepo.js'
import {
  DEFAULT_EMBED_MODEL,
  TransformersEmbedder,
  contentHash,
  entityText,
  type Embedder,
} from '../embeddings/Embedder.js'

export interface RunEmbedOptions {
  dbPath: string
  /** Defaults to DEFAULT_EMBED_MODEL. Ignored when `embedder` is given. */
  model?: string
  /** Inject an embedder (tests). Defaults to a local TransformersEmbedder. */
  embedder?: Embedder
  /** Passages per model call. Default 32. */
  batchSize?: number
  /**
   * A previous build's DB to copy vectors from: any entity whose text (and
   * model) is unchanged takes the old vector instead of being embedded again.
   * Lets a CI build that recreates the DB from scratch embed only what changed.
   */
  reuseFrom?: string
  migrationsDir?: string
  logger?: (msg: string) => void
}

export interface RunEmbedResult {
  model: string
  entities: number
  embedded: number
  unchanged: number
  /** Vectors copied from `reuseFrom` instead of embedded. */
  reused: number
  /** Rows in the sqlite-vec index, or null when sqlite-vec is not installed. */
  indexed: number | null
  /** Vectors from a previous model, dropped so the DB holds a single model. */
  droppedOtherModel: number
  durationMs: number
}

/**
 * Embeds every entity's `name + body` into the `embeddings` table. Run it
 * after `kb-ingest ingest`.
 *
 * Incremental: an entity whose text and model are unchanged since the last
 * run keeps its vector. Switching models re-embeds everything, because
 * vectors from different models are not comparable.
 */
export async function runEmbed(opts: RunEmbedOptions): Promise<RunEmbedResult> {
  const logger =
    opts.logger ?? ((msg: string): void => void process.stderr.write(`[kb-ingest] ${msg}\n`))
  const embedder =
    opts.embedder ?? new TransformersEmbedder({ model: opts.model ?? DEFAULT_EMBED_MODEL })
  const batchSize = opts.batchSize ?? 32
  const started = Date.now()

  const db = new Database({ path: opts.dbPath })
  try {
    runMigrations(db, opts.migrationsDir)
    const vectors = new VectorRepo(db)
    const droppedOtherModel = vectors.deleteOtherModels(embedder.model)
    if (droppedOtherModel > 0) {
      logger(`dropped ${droppedOtherModel} vector(s) from other models`)
    }

    const known = vectors.hashes()
    const rows = db.raw.prepare('SELECT id, name, body FROM entities ORDER BY id').all() as Array<{
      id: string
      name: string
      body: string | null
    }>
    let pending = rows
      .map((r) => {
        const text = entityText(r.name, r.body)
        return { id: r.id, text, hash: contentHash(embedder.model, text) }
      })
      .filter((r) => known.get(r.id) !== r.hash)
    const stale = pending.length

    let reused = 0
    if (opts.reuseFrom && pending.length > 0) {
      const copied = reuseVectors(db, opts.reuseFrom, embedder.model, pending)
      reused = copied.size
      pending = pending.filter((p) => !copied.has(p.id))
      logger(`reused ${reused} vector(s) from ${opts.reuseFrom}`)
    }

    logger(`${rows.length} entities, ${pending.length} to embed with ${embedder.model}`)
    for (let i = 0; i < pending.length; i += batchSize) {
      const batch = pending.slice(i, i + batchSize)
      const out = await embedder.embedPassages(batch.map((b) => b.text))
      db.transaction(() => {
        batch.forEach((b, j) =>
          vectors.upsert(b.id, embedder.model, b.hash, out[j] as Float32Array)
        )
      })
      logger(`embedded ${Math.min(i + batchSize, pending.length)}/${pending.length}`)
    }

    const indexed = vectors.rebuildIndex()
    logger(
      indexed === null
        ? 'sqlite-vec not installed — the server will scan vectors in JS'
        : `sqlite-vec index rebuilt (${indexed} rows)`
    )

    return {
      model: embedder.model,
      entities: rows.length,
      embedded: pending.length,
      unchanged: rows.length - stale,
      reused,
      indexed,
      droppedOtherModel,
      durationMs: Date.now() - started,
    }
  } finally {
    db.close()
  }
}

/**
 * Copies, from the DB at `path`, the vectors whose content hash matches a
 * pending entity's. The hash covers model + text, so a match is a vector this
 * run would have computed anyway. Returns the ids that got a vector.
 */
function reuseVectors(
  db: Database,
  path: string,
  model: string,
  pending: Array<{ id: string; hash: string }>
): Set<string> {
  // ATTACH would silently create an empty DB at a wrong path.
  if (!existsSync(path)) throw new Error(`--reuse-from: ${path} does not exist`)
  db.raw.prepare('ATTACH DATABASE ? AS prev').run(path)
  try {
    const hasTable = db.raw
      .prepare("SELECT 1 FROM prev.sqlite_master WHERE type = 'table' AND name = 'embeddings'")
      .get()
    if (!hasTable) return new Set()
    return db.transaction(() => {
      db.raw.exec('CREATE TEMP TABLE reuse_pending (id TEXT PRIMARY KEY, hash TEXT NOT NULL)')
      const ins = db.raw.prepare('INSERT INTO temp.reuse_pending (id, hash) VALUES (?, ?)')
      for (const p of pending) ins.run(p.id, p.hash)
      // `WHERE true` disambiguates the upsert's ON CONFLICT from a join constraint.
      db.raw
        .prepare(
          `INSERT INTO main.embeddings (entity_id, model, dims, content_hash, vector, updated_at)
           SELECT p.id, pe.model, pe.dims, pe.content_hash, pe.vector, ?
           FROM temp.reuse_pending p
           JOIN prev.embeddings pe ON pe.content_hash = p.hash AND pe.model = ?
           WHERE true
           ON CONFLICT(entity_id) DO UPDATE SET
             model = excluded.model,
             dims = excluded.dims,
             content_hash = excluded.content_hash,
             vector = excluded.vector,
             updated_at = excluded.updated_at`
        )
        .run(new Date().toISOString(), model)
      const ids = db.raw
        .prepare(
          `SELECT p.id FROM temp.reuse_pending p
           JOIN main.embeddings e ON e.entity_id = p.id AND e.content_hash = p.hash`
        )
        .all() as Array<{ id: string }>
      db.raw.exec('DROP TABLE temp.reuse_pending')
      return new Set(ids.map((r) => r.id))
    })
  } finally {
    db.raw.exec('DETACH DATABASE prev')
  }
}
