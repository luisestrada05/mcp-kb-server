import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Database } from './Database.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

/**
 * Default migrations directory — resolved relative to the compiled `dist/db/`
 * folder so it points at the package's bundled `migrations/` regardless of
 * where the consumer's CWD is.
 *
 * Layout assumed:
 *   <package>/migrations/0001_init.sql
 *   <package>/dist/db/migrations.js   ← this file at runtime
 *
 * Callers can override via the `migrationsDir` argument to `runMigrations`.
 */
const DEFAULT_MIGRATIONS_DIR = join(__dirname, '..', '..', 'migrations')

/**
 * Migration filename pattern: `NNNN_description.sql` where `NNNN` is a
 * zero-padded ordinal. We sort by full filename so the ordinal drives order
 * deterministically across filesystems and locales.
 */
const MIGRATION_PATTERN = /^(\d{4})_.+\.sql$/

interface MigrationFile {
  filename: string
  id: string
  sql: string
}

function loadMigrations(dir: string): MigrationFile[] {
  const files = readdirSync(dir)
    .filter((f) => MIGRATION_PATTERN.test(f))
    .sort()
  return files.map((filename) => {
    const match = MIGRATION_PATTERN.exec(filename)
    if (!match) {
      // Filtered above, defensive.
      throw new Error(`Invalid migration filename: ${filename}`)
    }
    return {
      filename,
      id: match[1] as string,
      sql: readFileSync(join(dir, filename), 'utf-8'),
    }
  })
}

/**
 * Apply pending migrations in order. Idempotent: already-applied migrations
 * are skipped. Each migration runs inside its own transaction; if one fails,
 * the partially-applied statements roll back and subsequent migrations are
 * not attempted.
 *
 * Tracking table `schema_migrations` is created on first run.
 */
export function runMigrations(db: Database, migrationsDir: string = DEFAULT_MIGRATIONS_DIR): void {
  db.raw.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id          TEXT PRIMARY KEY,
      filename    TEXT NOT NULL,
      applied_at  TEXT NOT NULL
    )
  `)

  const applied = new Set(
    db.raw.prepare('SELECT id FROM schema_migrations').all().map((r) => (r as { id: string }).id)
  )

  const pending = loadMigrations(migrationsDir).filter((m) => !applied.has(m.id))

  for (const migration of pending) {
    db.transaction(() => {
      db.raw.exec(migration.sql)
      db.raw
        .prepare('INSERT INTO schema_migrations (id, filename, applied_at) VALUES (?, ?, ?)')
        .run(migration.id, migration.filename, new Date().toISOString())
    })
  }
}

/**
 * Returns the list of applied migration IDs in order. Useful for diagnostics
 * (the CLI prints this in `kb-ingest status`).
 */
export function listAppliedMigrations(db: Database): Array<{ id: string; filename: string; appliedAt: string }> {
  return db.raw
    .prepare('SELECT id, filename, applied_at as appliedAt FROM schema_migrations ORDER BY id')
    .all() as Array<{ id: string; filename: string; appliedAt: string }>
}
