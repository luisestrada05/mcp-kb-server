import type { SearchRepo } from '../repos/SearchRepo.js'
import type { VectorRepo, VectorHit, VectorIndexStatus } from '../repos/VectorRepo.js'
import type { Embedder } from '../embeddings/Embedder.js'
import type { SearchHit } from '../types/kb.js'

export type FindMode = 'hybrid' | 'semantic' | 'fts'

export interface FindResult {
  /** The mode that actually ran — 'fts' when vectors were unavailable. */
  mode: FindMode
  hits: SearchHit[]
  /** Set when the requested mode had to fall back to FTS, and why. */
  warning?: string
}

/** RRF damping constant from Cormack et al. (2009); 60 is the usual default. */
const RRF_K = 60

function excerpt(body: string | null): string {
  if (!body) return ''
  return body.length > 140 ? body.slice(0, 140) + '…' : body
}

function vectorToHit(v: VectorHit): SearchHit {
  return {
    id: v.id,
    type: v.type,
    name: v.name,
    snippet: excerpt(v.body),
    similarity: v.similarity,
    matchedBy: ['vector'],
  }
}

/**
 * Merges two ranked lists with Reciprocal Rank Fusion: each hit scores
 * Σ 1 / (RRF_K + rank) over the lists it appears in. Rank-based, so BM25 and
 * cosine scores never need to be put on the same scale.
 */
export function reciprocalRankFusion(fts: SearchHit[], vectors: VectorHit[]): SearchHit[] {
  const merged = new Map<string, SearchHit>()
  fts.forEach((hit, i) => {
    merged.set(hit.id, { ...hit, score: 1 / (RRF_K + i + 1), matchedBy: ['fts'] })
  })
  vectors.forEach((v, i) => {
    const add = 1 / (RRF_K + i + 1)
    const prev = merged.get(v.id)
    if (prev) {
      prev.score = (prev.score ?? 0) + add
      prev.similarity = v.similarity
      prev.matchedBy = ['fts', 'vector']
    } else {
      merged.set(v.id, { ...vectorToHit(v), score: add })
    }
  })
  return [...merged.values()].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
}

/**
 * Search entry point for kb_find: FTS (BM25), vector similarity, or both
 * fused. Vectors are optional — a KB built without `kb-ingest embed`, or a
 * host where the embedding model cannot load, degrades to FTS with a warning
 * instead of failing the call.
 *
 * Queries are embedded with the model recorded in the DB, so the server
 * always compares like with like no matter what model it was configured with.
 */
export class HybridSearch {
  private readonly embedders = new Map<string, Embedder>()

  constructor(
    private readonly search: SearchRepo,
    private readonly vectors: VectorRepo,
    private readonly makeEmbedder: (model: string) => Embedder
  ) {}

  /** The embedding model the DB's vectors were built with, or null if none. */
  model(): string | null {
    return this.vectors.models()[0]?.model ?? null
  }

  /** Whether vector kNN runs on the sqlite-vec index or a JS scan. */
  vectorEngine(): VectorIndexStatus {
    return this.vectors.indexStatus()
  }

  /**
   * Loads the embedding model ahead of the first query (the first load takes
   * a few seconds). No-op when the DB has no vectors.
   */
  async warmup(): Promise<void> {
    const model = this.model()
    if (model) await this.embedder(model).embedQuery('warmup')
  }

  async find(
    query: string,
    opts: { type?: string; limit?: number; mode?: FindMode } = {}
  ): Promise<FindResult> {
    const limit = opts.limit ?? 20
    const mode = opts.mode ?? 'hybrid'
    // Fetch more than `limit` from each retriever so fusion has overlap to work with.
    const pool = Math.max(limit * 3, 30)
    const ftsOnly = (warning?: string): FindResult => ({
      mode: 'fts',
      hits: this.search.fullTextLenient(query, { type: opts.type, limit }),
      ...(warning ? { warning } : {}),
    })

    if (mode === 'fts') return ftsOnly()

    const model = this.model()
    if (!model) return ftsOnly('the KB has no embeddings (run `kb-ingest embed`); used FTS only')

    let queryVector: Float32Array
    try {
      queryVector = await this.embedder(model).embedQuery(query)
    } catch (err) {
      return ftsOnly(`embedding model ${model} unavailable (${String(err)}); used FTS only`)
    }

    const nearest = this.vectors.nearest(queryVector, { model, type: opts.type, limit: pool })
    if (mode === 'semantic') {
      return { mode, hits: nearest.slice(0, limit).map(vectorToHit) }
    }

    const fts = this.search.fullTextLenient(query, { type: opts.type, limit: pool })
    return { mode, hits: reciprocalRankFusion(fts, nearest).slice(0, limit) }
  }

  private embedder(model: string): Embedder {
    let e = this.embedders.get(model)
    if (!e) {
      e = this.makeEmbedder(model)
      this.embedders.set(model, e)
    }
    return e
  }
}
