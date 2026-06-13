/**
 * Core types for the knowledge graph.
 *
 * The schema is intentionally domain-agnostic: `type` and `relation` are free-form
 * strings so each project defines its own taxonomy (e.g. `rule`, `feature`, `decision`
 * for one domain; `product`, `customer`, `order` for another). Validation of
 * type/relation against an allowlist is a per-project concern, handled by the
 * ingestion plugin — the server stores whatever it's given.
 */

export interface Entity {
  id: string
  type: string
  name: string
  body: string | null
  metadata: Record<string, unknown>
  sourcePath: string | null
  updatedAt: string
}

export interface EntityInput {
  id: string
  type: string
  name: string
  body?: string | null
  metadata?: Record<string, unknown>
  sourcePath?: string | null
}

export interface Edge {
  src: string
  dst: string
  relation: string
  metadata: Record<string, unknown>
}

export interface EdgeInput {
  src: string
  dst: string
  relation: string
  metadata?: Record<string, unknown>
}

export interface SearchHit {
  id: string
  type: string
  name: string
  snippet: string
  /** FTS bm25 rank — lower is better. Only present for FTS-driven searches. */
  rank?: number
}

export interface TraverseResult {
  entity: Entity
  /** Depth from the start node (0 = the start node itself). */
  depth: number
  /** The relation that led to this node from its parent (null for the start node). */
  relation: string | null
}
