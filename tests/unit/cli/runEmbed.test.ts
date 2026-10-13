import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from '../../../src/db/Database.js'
import { runMigrations } from '../../../src/db/migrations.js'
import { EntityRepo } from '../../../src/repos/EntityRepo.js'
import { VectorRepo } from '../../../src/repos/VectorRepo.js'
import { runEmbed } from '../../../src/cli/runEmbed.js'
import { FakeEmbedder } from '../../helpers/fakeEmbedder.js'

describe('runEmbed', () => {
  let tmp: string
  let dbPath: string
  const quiet = (): void => {}

  function withDb<T>(fn: (db: Database) => T): T {
    const db = new Database({ path: dbPath })
    try {
      return fn(db)
    } finally {
      db.close()
    }
  }

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kb-embed-'))
    dbPath = join(tmp, 'kb.db')
    withDb((db) => {
      runMigrations(db)
      new EntityRepo(db).upsertMany([
        { id: 'a', type: 'rule', name: 'Alta de diferido', body: 'validación previa' },
        { id: 'b', type: 'rule', name: 'Tasa', body: null },
        { id: 'c', type: 'rule', name: 'Comercios', body: 'pre-aprobados' },
      ])
    })
  })

  afterEach(() => rmSync(tmp, { recursive: true, force: true }))

  it('embeds every entity, in batches', async () => {
    const embedder = new FakeEmbedder()
    const r = await runEmbed({ dbPath, embedder, batchSize: 2, logger: quiet })
    expect(r).toMatchObject({ model: 'fake/concepts-v1', entities: 3, embedded: 3, unchanged: 0 })
    expect(embedder.calls).toBe(2)
    expect(withDb((db) => new VectorRepo(db).count())).toBe(3)
  })

  it('re-embeds only entities whose text changed', async () => {
    await runEmbed({ dbPath, embedder: new FakeEmbedder(), logger: quiet })
    withDb((db) =>
      new EntityRepo(db).upsert({ id: 'b', type: 'rule', name: 'Tasa', body: 'base 360' })
    )

    const r = await runEmbed({ dbPath, embedder: new FakeEmbedder(), logger: quiet })
    expect(r).toMatchObject({ embedded: 1, unchanged: 2 })
  })

  it('switching models re-embeds everything and drops the old vectors', async () => {
    await runEmbed({ dbPath, embedder: new FakeEmbedder('fake/v1'), logger: quiet })
    const r = await runEmbed({ dbPath, embedder: new FakeEmbedder('fake/v2'), logger: quiet })
    expect(r).toMatchObject({ embedded: 3, droppedOtherModel: 3 })
    expect(withDb((db) => new VectorRepo(db).models())).toEqual([{ model: 'fake/v2', count: 3 }])
  })
})
