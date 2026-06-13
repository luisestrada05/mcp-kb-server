import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Database } from '../../../src/db/Database.js'
import { runMigrations, listAppliedMigrations } from '../../../src/db/migrations.js'

describe('migrations', () => {
  let db: Database

  beforeEach(() => {
    db = new Database({ path: ':memory:' })
  })

  afterEach(() => {
    db.close()
  })

  it('creates the core tables on first run', () => {
    runMigrations(db)

    const tables = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name)

    expect(tables).toContain('entities')
    expect(tables).toContain('edges')
    expect(tables).toContain('terms')
    expect(tables).toContain('schema_migrations')
    // FTS5 creates a virtual table; better-sqlite3 reports it as type='table'.
    expect(tables).toContain('entities_fts')
  })

  it('is idempotent — second run is a no-op', () => {
    runMigrations(db)
    const firstApplied = listAppliedMigrations(db)
    runMigrations(db)
    const secondApplied = listAppliedMigrations(db)

    expect(secondApplied).toEqual(firstApplied)
  })

  it('records every migration in schema_migrations with an ISO timestamp', () => {
    runMigrations(db)
    const applied = listAppliedMigrations(db)

    expect(applied.length).toBeGreaterThan(0)
    for (const m of applied) {
      expect(m.id).toMatch(/^\d{4}$/)
      // ISO-8601 UTC timestamp (toISOString output).
      expect(m.appliedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
    }
  })

  it('FTS triggers keep entities_fts in sync on insert/update/delete', () => {
    runMigrations(db)

    db.raw
      .prepare(
        'INSERT INTO entities (id, type, name, body, metadata, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run('e1', 'note', 'first', 'hello world', '{}', new Date().toISOString())

    const ftsHits = db.raw.prepare('SELECT name FROM entities_fts WHERE entities_fts MATCH ?').all('hello')
    expect(ftsHits).toHaveLength(1)
    expect((ftsHits[0] as { name: string }).name).toBe('first')

    db.raw
      .prepare('UPDATE entities SET body = ? WHERE id = ?')
      .run('goodbye world', 'e1')

    const afterUpdate = db.raw.prepare('SELECT 1 FROM entities_fts WHERE entities_fts MATCH ?').all('hello')
    expect(afterUpdate).toHaveLength(0)
    const afterUpdate2 = db.raw.prepare('SELECT 1 FROM entities_fts WHERE entities_fts MATCH ?').all('goodbye')
    expect(afterUpdate2).toHaveLength(1)

    db.raw.prepare('DELETE FROM entities WHERE id = ?').run('e1')
    const afterDelete = db.raw.prepare('SELECT 1 FROM entities_fts WHERE entities_fts MATCH ?').all('goodbye')
    expect(afterDelete).toHaveLength(0)
  })

  it('foreign-key cascade removes edges and terms when an entity is deleted', () => {
    runMigrations(db)

    const now = new Date().toISOString()
    db.raw
      .prepare(
        'INSERT INTO entities (id, type, name, body, metadata, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run('a', 'note', 'A', null, '{}', now)
    db.raw
      .prepare(
        'INSERT INTO entities (id, type, name, body, metadata, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run('b', 'note', 'B', null, '{}', now)
    db.raw
      .prepare('INSERT INTO edges (src, dst, relation, metadata) VALUES (?, ?, ?, ?)')
      .run('a', 'b', 'depends_on', '{}')
    db.raw.prepare('INSERT INTO terms (term, entity_id) VALUES (?, ?)').run('foo', 'a')

    db.raw.prepare('DELETE FROM entities WHERE id = ?').run('a')

    expect(db.raw.prepare('SELECT COUNT(*) c FROM edges').get()).toEqual({ c: 0 })
    expect(db.raw.prepare('SELECT COUNT(*) c FROM terms').get()).toEqual({ c: 0 })
  })
})
