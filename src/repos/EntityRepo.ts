import type { Database } from '../db/Database.js'
import type { Entity, EntityInput } from '../types/kb.js'

interface EntityRow {
  id: string
  type: string
  name: string
  body: string | null
  metadata: string
  source_path: string | null
  updated_at: string
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

export class EntityRepo {
  constructor(private readonly db: Database) {}

  /**
   * Insert or replace an entity. The "or replace" semantics make ingestion
   * pipelines idempotent: re-running ingestion overwrites entities with the
   * latest source content rather than failing on duplicate IDs.
   */
  upsert(input: EntityInput): void {
    const now = new Date().toISOString()
    this.db.raw
      .prepare(
        `INSERT INTO entities (id, type, name, body, metadata, source_path, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           type = excluded.type,
           name = excluded.name,
           body = excluded.body,
           metadata = excluded.metadata,
           source_path = excluded.source_path,
           updated_at = excluded.updated_at`
      )
      .run(
        input.id,
        input.type,
        input.name,
        input.body ?? null,
        JSON.stringify(input.metadata ?? {}),
        input.sourcePath ?? null,
        now
      )
  }

  /** Upsert many in a single transaction. Returns the count inserted/updated. */
  upsertMany(inputs: EntityInput[]): number {
    return this.db.transaction(() => {
      for (const input of inputs) {
        this.upsert(input)
      }
      return inputs.length
    })
  }

  getById(id: string): Entity | null {
    const row = this.db.raw.prepare('SELECT * FROM entities WHERE id = ?').get(id) as
      | EntityRow
      | undefined
    return row ? rowToEntity(row) : null
  }

  /** Returns true if the entity existed and was deleted. */
  delete(id: string): boolean {
    const result = this.db.raw.prepare('DELETE FROM entities WHERE id = ?').run(id)
    return result.changes > 0
  }

  listByType(type: string, limit = 100): Entity[] {
    const rows = this.db.raw
      .prepare('SELECT * FROM entities WHERE type = ? ORDER BY updated_at DESC LIMIT ?')
      .all(type, limit) as EntityRow[]
    return rows.map(rowToEntity)
  }

  count(type?: string): number {
    if (type === undefined) {
      const r = this.db.raw.prepare('SELECT COUNT(*) c FROM entities').get() as { c: number }
      return r.c
    }
    const r = this.db.raw.prepare('SELECT COUNT(*) c FROM entities WHERE type = ?').get(type) as {
      c: number
    }
    return r.c
  }
}
