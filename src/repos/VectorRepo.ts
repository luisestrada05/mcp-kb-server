import { createRequire } from 'node:module'
import type { Database } from '../db/Database.js'

const require = createRequire(import.meta.url)

/** Name of the sqlite-vec index built from `embeddings` by `rebuildIndex()`. */
export const VEC_INDEX_TABLE = 'embeddings_vec'

/**
 * Loads the sqlite-vec extension into this connection. It is an optional
 * dependency: when the package (or its prebuilt binary for this platform) is
 * missing, search falls back to scanning in JS.
 */
function loadSqliteVec(db: Database): boolean {
  try {
    const sqliteVec = require('sqlite-vec') as { load(db: unknown): void }
    sqliteVec.load(db.raw)
    return true
  } catch {
    return false
  }
}

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

export interface VectorIndexStatus {
  /** 'sqlite-vec' when kNN runs on the vec0 index, 'scan' when it scans in JS. */
  engine: 'sqlite-vec' | 'scan'
  /** Why the index is not used, when engine is 'scan'. */
  reason?: string
}

interface IndexState {
  model: string
  dims: number
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
 * `embeddings` is the source of truth and needs no extension. On top of it,
 * `rebuildIndex()` builds a sqlite-vec `vec0` table; when it is present and
 * in sync, `nearest()` runs kNN there (about 14x faster than the JS scan:
 * ~70ms vs ~1s over 100k vectors of 384 dims). Otherwise `nearest()` scans
 * `embeddings` in JS, which is fine up to a few thousand entities. Both
 * paths are exact and return the same ranking.
 */
export class VectorRepo {
  private readonly vecLoaded: boolean
  /** Cached result of the index check; undefined = not checked yet. */
  private index: IndexState | null | undefined

  constructor(
    private readonly db: Database,
    opts: { sqliteVec?: boolean } = {}
  ) {
    this.vecLoaded = opts.sqliteVec === false ? false : loadSqliteVec(db)
  }

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

  /**
   * Rebuilds the sqlite-vec index from `embeddings`. Run after embedding (the
   * `kb-ingest embed` CLI does). Returns the indexed row count, or null when
   * sqlite-vec is not available — search then keeps working by scanning.
   */
  rebuildIndex(): number | null {
    this.index = undefined
    if (!this.vecLoaded) return null
    const dims = (
      this.db.raw.prepare('SELECT DISTINCT dims FROM embeddings').all() as Array<{ dims: number }>
    ).map((r) => r.dims)
    if (dims.length > 1) {
      throw new Error(`embeddings mix dimensions (${dims.join(', ')}); re-run kb-ingest embed`)
    }
    return this.db.transaction(() => {
      this.db.raw.exec(`DROP TABLE IF EXISTS ${VEC_INDEX_TABLE}`)
      if (dims.length === 0) return 0
      // `type` is a vec0 metadata column so kb_find's type filter applies
      // inside the kNN search, before `k` is cut.
      this.db.raw.exec(
        `CREATE VIRTUAL TABLE ${VEC_INDEX_TABLE} USING vec0(
           entity_id TEXT PRIMARY KEY,
           type TEXT,
           embedding float[${dims[0]}] distance_metric=cosine
         )`
      )
      return this.db.raw
        .prepare(
          `INSERT INTO ${VEC_INDEX_TABLE} (entity_id, type, embedding)
           SELECT v.entity_id, e.type, v.vector
           FROM embeddings v JOIN entities e ON e.id = v.entity_id`
        )
        .run().changes
    })
  }

  /** Which engine `nearest()` uses, and why not the index if it can't. */
  indexStatus(): VectorIndexStatus {
    if (!this.vecLoaded) return { engine: 'scan', reason: 'sqlite-vec is not installed' }
    const state = this.indexState()
    if (state) return { engine: 'sqlite-vec' }
    const exists = this.db.raw
      .prepare('SELECT 1 FROM sqlite_master WHERE name = ?')
      .get(VEC_INDEX_TABLE)
    return {
      engine: 'scan',
      reason: exists
        ? 'the index is out of sync with embeddings (run kb-ingest embed)'
        : 'no index in the DB (run kb-ingest embed)',
    }
  }

  /** Top-`limit` entities by cosine similarity to `query`. */
  nearest(
    query: Float32Array,
    opts: { model: string; type?: string; limit?: number }
  ): VectorHit[] {
    const limit = opts.limit ?? 20
    const index = this.indexState()
    if (index && index.model === opts.model && index.dims === query.length) {
      return this.nearestIndexed(query, { type: opts.type, limit })
    }
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

  /**
   * kNN on the vec0 index. sqlite-vec caps k at 4096; kb_find asks for at
   * most a few hundred.
   */
  private nearestIndexed(query: Float32Array, opts: { type?: string; limit: number }): VectorHit[] {
    const sql = `WITH knn AS (
                   SELECT entity_id, distance FROM ${VEC_INDEX_TABLE}
                   WHERE embedding MATCH ? AND k = ?${opts.type ? ' AND type = ?' : ''}
                 )
                 SELECT e.id, e.type, e.name, e.body, knn.distance
                 FROM knn JOIN entities e ON e.id = knn.entity_id
                 ORDER BY knn.distance`
    const params: unknown[] = [toBlob(query), Math.min(opts.limit, 4096)]
    if (opts.type) params.push(opts.type)
    const rows = this.db.raw.prepare(sql).all(...params) as Array<
      Omit<VectorRow, 'vector'> & { distance: number }
    >
    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      name: r.name,
      body: r.body,
      // vec0's cosine distance is 1 - cosine similarity.
      similarity: 1 - r.distance,
    }))
  }

  /**
   * The index is usable when it exists and holds exactly the rows of
   * `embeddings`, all from one model. Checked once per VectorRepo: the server
   * reads a DB that `kb-ingest embed` built, and `rebuildIndex()` resets it.
   */
  private indexState(): IndexState | null {
    if (this.index !== undefined) return this.index
    this.index = null
    if (!this.vecLoaded) return null
    const exists = this.db.raw
      .prepare('SELECT 1 FROM sqlite_master WHERE name = ?')
      .get(VEC_INDEX_TABLE)
    if (!exists) return null
    const models = this.db.raw
      .prepare('SELECT model, dims, COUNT(*) AS n FROM embeddings GROUP BY model, dims')
      .all() as Array<{ model: string; dims: number; n: number }>
    const indexed = (
      this.db.raw.prepare(`SELECT COUNT(*) AS c FROM ${VEC_INDEX_TABLE}`).get() as { c: number }
    ).c
    const only = models[0]
    if (models.length === 1 && only && only.n === indexed) {
      this.index = { model: only.model, dims: only.dims }
    }
    return this.index
  }
}
