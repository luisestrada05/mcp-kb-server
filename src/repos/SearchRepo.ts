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
 * Spanish question words and fillers that carry no meaning for retrieval
 * ("¿qué pasa si...?"). OR-ed into a query they match nearly every entity and
 * drown out the words that matter. Compared without accents.
 */
const STOPWORDS = new Set(
  (
    'que como cual cuales cuando cuanto cuantos donde quien para por con del los las una uno unos ' +
    'unas este esta estos estas ese esa eso esto hay pasa pasan puede puedo pueden debe deben cada ' +
    'todo toda todos todas mas muy ser son esta estan tiene tienen hace hacer algo alguna alguno ' +
    'cuando sobre entre hasta desde tambien pero porque the and for'
  ).split(' ')
)

function stripAccents(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '')
}

/**
 * Rewrites free text as an FTS5 OR-query. Each term is quoted so punctuation
 * can't be read as FTS5 syntax. A hyphenated or dotted token such as an ID
 * ("R-DIF-011") stays together as a phrase instead of splitting into "dif"
 * and "011". Single words of 4+ letters get a prefix star as a cheap stand-in
 * for stemming; words under 3 letters and STOPWORDS are dropped. Returns ''
 * when nothing survives.
 */
export function toOrQuery(text: string): string {
  const terms: string[] = []
  for (const chunk of text.toLowerCase().split(/\s+/)) {
    const words = chunk.match(/[\p{L}\p{N}_]+/gu) ?? []
    if (words.length > 1) {
      terms.push(`"${words.join(' ')}"`)
      continue
    }
    const w = words[0]
    if (!w || w.length < 3 || STOPWORDS.has(stripAccents(w))) continue
    terms.push(w.length >= 4 ? `"${w}"*` : `"${w}"`)
  }
  return [...new Set(terms)].join(' OR ')
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
   * fullText for queries typed as natural language ("¿se puede diferir una
   * compra?"). Tries the query verbatim first so FTS5 operators keep working;
   * if FTS5 rejects the syntax, or the implicit AND of every word finds
   * nothing, retries with the words OR-ed together (prefix-matched, so
   * "diferido" also finds "diferidos") and lets BM25 rank them.
   */
  fullTextLenient(query: string, opts: { type?: string; limit?: number } = {}): SearchHit[] {
    try {
      const hits = this.fullText(query, opts)
      if (hits.length > 0) return hits
    } catch {
      // FTS5 syntax error — fall through to the tokenized query.
    }
    const relaxed = toOrQuery(query)
    return relaxed ? this.fullText(relaxed, opts) : []
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
