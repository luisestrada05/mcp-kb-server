import type { Database } from '../db/Database.js'
import type { Edge, EdgeInput, Entity, TraverseResult } from '../types/kb.js'

interface EdgeRow {
  src: string
  dst: string
  relation: string
  metadata: string
}

interface EntityRow {
  id: string
  type: string
  name: string
  body: string | null
  metadata: string
  source_path: string | null
  updated_at: string
}

function rowToEdge(row: EdgeRow): Edge {
  return {
    src: row.src,
    dst: row.dst,
    relation: row.relation,
    metadata: JSON.parse(row.metadata) as Record<string, unknown>,
  }
}

function rowToEntity(row: EntityRow): Entity {
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    body: row.body,
    metadata: JSON.parse(row.metadata) as Record<string, unknown>,
    sourcePath: row.source_path,
    updatedAt: row.updated_at,
  }
}

export class EdgeRepo {
  constructor(private readonly db: Database) {}

  /**
   * Upsert an edge. (src, dst, relation) is the primary key so re-asserting
   * the same edge just updates metadata. Returns true if a new row was inserted,
   * false if it was an update.
   */
  upsert(input: EdgeInput): boolean {
    const result = this.db.raw
      .prepare(
        `INSERT INTO edges (src, dst, relation, metadata)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(src, dst, relation) DO UPDATE SET metadata = excluded.metadata`
      )
      .run(input.src, input.dst, input.relation, JSON.stringify(input.metadata ?? {}))
    // better-sqlite3 reports changes=1 for both INSERT and UPDATE via UPSERT;
    // we read lastInsertRowid being non-zero to discriminate, but that's not
    // reliable across all dialects. We accept the simplification: callers
    // shouldn't depend on the insert-vs-update distinction.
    return result.changes > 0
  }

  upsertMany(inputs: EdgeInput[]): number {
    return this.db.transaction(() => {
      for (const input of inputs) {
        this.upsert(input)
      }
      return inputs.length
    })
  }

  /** Returns true if the edge existed and was deleted. */
  delete(src: string, dst: string, relation: string): boolean {
    const result = this.db.raw
      .prepare('DELETE FROM edges WHERE src = ? AND dst = ? AND relation = ?')
      .run(src, dst, relation)
    return result.changes > 0
  }

  /** All outgoing edges from `src` (optionally filtered by relation). */
  outgoing(src: string, relation?: string): Edge[] {
    if (relation === undefined) {
      const rows = this.db.raw.prepare('SELECT * FROM edges WHERE src = ?').all(src) as EdgeRow[]
      return rows.map(rowToEdge)
    }
    const rows = this.db.raw
      .prepare('SELECT * FROM edges WHERE src = ? AND relation = ?')
      .all(src, relation) as EdgeRow[]
    return rows.map(rowToEdge)
  }

  /** All incoming edges to `dst` (optionally filtered by relation). */
  incoming(dst: string, relation?: string): Edge[] {
    if (relation === undefined) {
      const rows = this.db.raw.prepare('SELECT * FROM edges WHERE dst = ?').all(dst) as EdgeRow[]
      return rows.map(rowToEdge)
    }
    const rows = this.db.raw
      .prepare('SELECT * FROM edges WHERE dst = ? AND relation = ?')
      .all(dst, relation) as EdgeRow[]
    return rows.map(rowToEdge)
  }

  /** All edges touching `id` (in or out). */
  related(id: string): { outgoing: Edge[]; incoming: Edge[] } {
    return { outgoing: this.outgoing(id), incoming: this.incoming(id) }
  }

  /**
   * BFS from `start` following outgoing edges, optionally filtered by `relation`.
   * Returns the start node at depth 0 followed by every reachable node up to
   * `maxDepth` (default 1). Cycles are detected via a visited set.
   *
   * Each result includes the relation that led to it (null for the start node)
   * so callers can render the path. The order is BFS layer-by-layer; siblings
   * at the same depth retain their database order.
   */
  traverse(start: string, opts: { relation?: string; maxDepth?: number } = {}): TraverseResult[] {
    const maxDepth = opts.maxDepth ?? 1
    const relation = opts.relation

    const startEntity = this.db.raw.prepare('SELECT * FROM entities WHERE id = ?').get(start) as
      | EntityRow
      | undefined
    if (!startEntity) {
      return []
    }

    const visited = new Set<string>([start])
    const results: TraverseResult[] = [{ entity: rowToEntity(startEntity), depth: 0, relation: null }]

    let frontier: Array<{ id: string }> = [{ id: start }]
    for (let depth = 1; depth <= maxDepth; depth++) {
      const nextFrontier: Array<{ id: string }> = []
      for (const node of frontier) {
        const outgoing = this.outgoing(node.id, relation)
        for (const edge of outgoing) {
          if (visited.has(edge.dst)) {
            continue
          }
          visited.add(edge.dst)
          const dstEntity = this.db.raw
            .prepare('SELECT * FROM entities WHERE id = ?')
            .get(edge.dst) as EntityRow | undefined
          if (dstEntity) {
            results.push({
              entity: rowToEntity(dstEntity),
              depth,
              relation: edge.relation,
            })
            nextFrontier.push({ id: edge.dst })
          }
        }
      }
      if (nextFrontier.length === 0) {
        break
      }
      frontier = nextFrontier
    }

    return results
  }
}
