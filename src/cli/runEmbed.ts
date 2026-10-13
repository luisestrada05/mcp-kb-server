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
  migrationsDir?: string
  logger?: (msg: string) => void
}

export interface RunEmbedResult {
  model: string
  entities: number
  embedded: number
  unchanged: number
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
    const pending = rows
      .map((r) => {
        const text = entityText(r.name, r.body)
        return { id: r.id, text, hash: contentHash(embedder.model, text) }
      })
      .filter((r) => known.get(r.id) !== r.hash)

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

    return {
      model: embedder.model,
      entities: rows.length,
      embedded: pending.length,
      unchanged: rows.length - pending.length,
      droppedOtherModel,
      durationMs: Date.now() - started,
    }
  } finally {
    db.close()
  }
}
