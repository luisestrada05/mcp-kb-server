import BetterSqlite3 from 'better-sqlite3'
import type { Database as Sqlite } from 'better-sqlite3'

export interface DatabaseOptions {
  /** Path to the SQLite file. Use `':memory:'` for in-memory (tests). */
  path: string
  /** If true, enables verbose SQL logging to stderr. Default: false. */
  verbose?: boolean
  /** If true, opens read-only. Default: false. */
  readonly?: boolean
}

/**
 * Thin wrapper around `better-sqlite3` that owns the connection and applies
 * project-wide PRAGMAs. All repository classes take a `Database` rather than
 * the raw `better-sqlite3` handle so we can swap implementations or layer in
 * instrumentation without touching every call-site.
 *
 * Per better-sqlite3 docs, the connection is single-threaded and synchronous —
 * which is exactly what we want for a local MCP server (no async overhead, no
 * connection-pool gymnastics).
 */
export class Database {
  readonly raw: Sqlite

  constructor(opts: DatabaseOptions) {
    this.raw = new BetterSqlite3(opts.path, {
      readonly: opts.readonly ?? false,
      verbose: opts.verbose ? (msg) => process.stderr.write(`[sql] ${String(msg)}\n`) : undefined,
    })

    // PRAGMAs:
    // - foreign_keys: not on by default in SQLite, we need it for ON DELETE CASCADE.
    // - journal_mode WAL: better concurrent reads alongside the single writer; only
    //   meaningful for file-backed DBs but harmless for :memory:.
    // - synchronous NORMAL: WAL-safe and faster than FULL; for a KB the small risk
    //   of losing the last commit on power loss is acceptable.
    // - busy_timeout: 5s — short waits to ride out concurrent ingestion jobs.
    this.raw.pragma('foreign_keys = ON')
    if (opts.path !== ':memory:') {
      this.raw.pragma('journal_mode = WAL')
      this.raw.pragma('synchronous = NORMAL')
    }
    this.raw.pragma('busy_timeout = 5000')
  }

  close(): void {
    this.raw.close()
  }

  /**
   * Run `fn` inside a transaction. Returns the function's result. Throws if
   * `fn` throws (rolling back the transaction). Nested transactions are
   * coalesced by better-sqlite3 into SAVEPOINTs.
   */
  transaction<T>(fn: () => T): T {
    return this.raw.transaction(fn)()
  }
}
