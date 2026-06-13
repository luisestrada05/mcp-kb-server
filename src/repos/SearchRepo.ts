import type { Database } from '../db/Database.js'
import type { SearchHit } from '../types/kb.js'

interface FtsRow {
  id: string
  type: string
  name: string
  snippet: string
  rank: number
}

interface TermLookupRow {
  id: string
  type: string
  name: string
  body: string | null
}

/**
 * Read-only queries that span search and keyword indexes. Repository methods
 * here NEVER mutate — writes flow through EntityRepo (which keeps FTS in sync
 * via the SQL triggers defined in 0001_init.sql).
 */
export class SearchRepo {
  constructor(private readonly db: Database) {}

  /**
   * Full-text search via FTS5. Returns hits ranked by BM25 (lower rank = better).
   * `type` is an optional post-filter — FTS doesn't index `type` so we apply it
   * as a WHERE clause against the entity row.
   *
   * `query` is passed verbatim to FTS5, so callers can use FTS5 operators
   * (`AND`, `OR`, `NEAR`, `"phrase"`, prefix `term*`). Sanitization is the
   * caller's responsibility — escape user input that may contain SQL syntax.
   */
  fullText(query: string, opts: { type?: string; limit?: number } = {}): SearchHit[] {
    const limit = opts.limit ?? 20
    const sql = opts.type
      ? `SELECT e.id, e.type, e.name,
                snippet(entities_fts, 1, '<<', '>>', '…', 16) AS snippet,
                entities_fts.rank AS rank
         FROM entities_fts
         JOIN entities e ON e.rowid = entities_fts.rowid
         WHERE entities_fts MATCH ? AND e.type = ?
         ORDER BY entities_fts.rank
         LIMIT ?`
      : `SELECT e.id, e.type, e.name,
                snippet(entities_fts, 1, '<<', '>>', '…', 16) AS snippet,
                entities_fts.rank AS rank
         FROM entities_fts
         JOIN entities e ON e.rowid = entities_fts.rowid
         WHERE entities_fts MATCH ?
         ORDER BY entities_fts.rank
         LIMIT ?`

    const rows = opts.type
      ? (this.db.raw.prepare(sql).all(query, opts.type, limit) as FtsRow[])
      : (this.db.raw.prepare(sql).all(query, limit) as FtsRow[])

    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      name: r.name,
      snippet: r.snippet,
      rank: r.rank,
    }))
  }

  /**
   * Exact lookup by term (case-insensitive). The keyword index stores
   * lowercased terms; we lowercase the query to match. Returns the entities
   * that have the term in their tag list.
   *
   * This is the "diferidos" → [rule_ids] pattern: per-project ingestion
   * extracts terms from frontmatter and we resolve them as O(log n) lookups.
   */
  byTerm(term: string, opts: { type?: string; limit?: number } = {}): SearchHit[] {
    const limit = opts.limit ?? 20
    const normalized = term.toLowerCase()
    const sql = opts.type
      ? `SELECT e.id, e.type, e.name, e.body
         FROM terms t
         JOIN entities e ON e.id = t.entity_id
         WHERE t.term = ? AND e.type = ?
         ORDER BY e.updated_at DESC
         LIMIT ?`
      : `SELECT e.id, e.type, e.name, e.body
         FROM terms t
         JOIN entities e ON e.id = t.entity_id
         WHERE t.term = ?
         ORDER BY e.updated_at DESC
         LIMIT ?`

    const rows = opts.type
      ? (this.db.raw.prepare(sql).all(normalized, opts.type, limit) as TermLookupRow[])
      : (this.db.raw.prepare(sql).all(normalized, limit) as TermLookupRow[])

    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      name: r.name,
      // For term lookups we don't have FTS context, so we excerpt the first
      // ~140 chars of the body as a preview. Empty body → empty snippet.
      snippet: r.body ? (r.body.length > 140 ? r.body.slice(0, 140) + '…' : r.body) : '',
    }))
  }

  /**
   * Tag an entity with one or more terms. Idempotent (PRIMARY KEY on (term, entity_id)).
   * Terms are stored lowercased so byTerm() lookups are case-insensitive.
   */
  addTerms(entityId: string, terms: string[]): void {
    this.db.transaction(() => {
      const stmt = this.db.raw.prepare(
        'INSERT INTO terms (term, entity_id) VALUES (?, ?) ON CONFLICT DO NOTHING'
      )
      for (const term of terms) {
        stmt.run(term.toLowerCase(), entityId)
      }
    })
  }

  /** Remove all terms for an entity (useful before re-indexing in ingestion). */
  clearTerms(entityId: string): void {
    this.db.raw.prepare('DELETE FROM terms WHERE entity_id = ?').run(entityId)
  }
}
