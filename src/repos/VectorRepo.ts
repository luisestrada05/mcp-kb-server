import type { Database } from '../db/Database.js'

export interface StoredVector {
  entityId: string
  model: string
  contentHash: string
  vector: Float32Array
}

export interface VectorHit {
  id: string
  type: string
  name: string
  body: string | null
  /** Cosine similarity in [-1, 1] — higher is better. */
  similarity: number
}

interface VectorRow {
  id: string
  type: string
  name: string
  body: string | null
  vector: Buffer
}

function toBlob(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength)
}

function fromBlob(b: Buffer): Float32Array {
  // Copy: SQLite blobs are not guaranteed to be 4-byte aligned.
  return new Float32Array(new Uint8Array(b).buffer)
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += (a[i] as number) * (b[i] as number)
  return s
}

/**
 * Storage and nearest-neighbour search over entity embeddings. Vectors are
 * L2-normalized at write time, so similarity is a plain dot product.
 *
 * Search is an exhaustive scan: exact, no index to keep in sync, and fast
 * enough for knowledge bases up to roughly 100k entities.
 */
export class VectorRepo {
  constructor(private readonly db: Database) {}

  upsert(entityId: string, model: string, contentHash: string, vector: Float32Array): void {
    this.db.raw
      .prepare(
        `INSERT INTO embeddings (entity_id, model, dims, content_hash, vector, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(entity_id) DO UPDATE SET
           model = excluded.model,
           dims = excluded.dims,
           content_hash = excluded.content_hash,
           vector = excluded.vector,
           updated_at = excluded.updated_at`
      )
      .run(entityId, model, vector.length, contentHash, toBlob(vector), new Date().toISOString())
  }

  /** content_hash per entity, for incremental re-embedding. */
  hashes(): Map<string, string> {
    const rows = this.db.raw
      .prepare('SELECT entity_id, content_hash FROM embeddings')
      .all() as Array<{ entity_id: string; content_hash: string }>
    return new Map(rows.map((r) => [r.entity_id, r.content_hash]))
  }

  /** Drop vectors made by any model other than `model`. Returns rows deleted. */
  deleteOtherModels(model: string): number {
    return this.db.raw.prepare('DELETE FROM embeddings WHERE model <> ?').run(model).changes
  }

  /**
   * Models present in the table with their vector counts. Empty for a DB
   * created before migration 0002 and opened read-only (no migrations run).
   */
  models(): Array<{ model: string; count: number }> {
    const hasTable = this.db.raw
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'embeddings'")
      .get()
    if (!hasTable) return []
    return this.db.raw
      .prepare('SELECT model, COUNT(*) AS count FROM embeddings GROUP BY model ORDER BY count DESC')
      .all() as Array<{ model: string; count: number }>
  }

  count(): number {
    return (this.db.raw.prepare('SELECT COUNT(*) c FROM embeddings').get() as { c: number }).c
  }

  /** Top-`limit` entities by cosine similarity to `query`. */
  nearest(
    query: Float32Array,
    opts: { model: string; type?: string; limit?: number }
  ): VectorHit[] {
    const limit = opts.limit ?? 20
    const sql = `SELECT e.id, e.type, e.name, e.body, v.vector
                 FROM embeddings v
                 JOIN entities e ON e.id = v.entity_id
                 WHERE v.model = ? AND v.dims = ?${opts.type ? ' AND e.type = ?' : ''}`
    const params: unknown[] = [opts.model, query.length]
    if (opts.type) params.push(opts.type)

    const scored: VectorHit[] = []
    for (const row of this.db.raw.prepare(sql).iterate(...params) as Iterable<VectorRow>) {
      scored.push({
        id: row.id,
        type: row.type,
        name: row.name,
        body: row.body,
        similarity: dot(query, fromBlob(row.vector)),
      })
    }
    scored.sort((a, b) => b.similarity - a.similarity)
    return scored.slice(0, limit)
  }
}
