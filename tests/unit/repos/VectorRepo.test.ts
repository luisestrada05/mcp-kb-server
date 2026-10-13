import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Database } from '../../../src/db/Database.js'
import { runMigrations } from '../../../src/db/migrations.js'
import { EntityRepo } from '../../../src/repos/EntityRepo.js'
import { VectorRepo } from '../../../src/repos/VectorRepo.js'

const unit = (...xs: number[]): Float32Array => {
  const n = Math.hypot(...xs)
  return Float32Array.from(xs.map((x) => x / n))
}

describe('VectorRepo', () => {
  let db: Database
  let entities: EntityRepo
  let vectors: VectorRepo

  beforeEach(() => {
    db = new Database({ path: ':memory:' })
    runMigrations(db)
    entities = new EntityRepo(db)
    vectors = new VectorRepo(db)
    entities.upsertMany([
      { id: 'a', type: 'rule', name: 'A', body: 'alpha' },
      { id: 'b', type: 'rule', name: 'B', body: 'beta' },
      { id: 'c', type: 'feature', name: 'C', body: null },
    ])
    vectors.upsert('a', 'm1', 'h-a', unit(1, 0, 0))
    vectors.upsert('b', 'm1', 'h-b', unit(1, 1, 0))
    vectors.upsert('c', 'm1', 'h-c', unit(0, 0, 1))
  })

  afterEach(() => db.close())

  it('nearest ranks by cosine similarity and round-trips the float32 blob', () => {
    const hits = vectors.nearest(unit(1, 0.1, 0), { model: 'm1' })
    expect(hits.map((h) => h.id)).toEqual(['a', 'b', 'c'])
    expect(hits[0]?.similarity).toBeCloseTo(0.995, 3)
    expect(hits[2]?.similarity).toBeCloseTo(0, 5)
  })

  it('nearest applies the type filter and limit', () => {
    expect(vectors.nearest(unit(0, 1, 0), { model: 'm1', type: 'rule' }).map((h) => h.id)).toEqual([
      'b',
      'a',
    ])
    expect(vectors.nearest(unit(1, 0, 0), { model: 'm1', limit: 1 })).toHaveLength(1)
  })

  it('nearest ignores vectors from other models or dimensions', () => {
    expect(vectors.nearest(unit(1, 0, 0), { model: 'other' })).toEqual([])
    expect(vectors.nearest(unit(1, 0), { model: 'm1' })).toEqual([])
  })

  it('deleting an entity cascades to its vector', () => {
    entities.delete('a')
    expect(vectors.count()).toBe(2)
  })

  it('deleteOtherModels keeps only the given model', () => {
    vectors.upsert('a', 'm2', 'h', unit(1, 0, 0))
    expect(vectors.models()).toEqual([
      { model: 'm1', count: 2 },
      { model: 'm2', count: 1 },
    ])
    expect(vectors.deleteOtherModels('m2')).toBe(2)
    expect(vectors.models()).toEqual([{ model: 'm2', count: 1 }])
  })
})

describe('VectorRepo on a DB without migration 0002', () => {
  it('models() is empty instead of throwing', () => {
    const db = new Database({ path: ':memory:' })
    db.raw.exec('CREATE TABLE entities (id TEXT PRIMARY KEY)')
    expect(new VectorRepo(db).models()).toEqual([])
    db.close()
  })
})

describe('VectorRepo with the sqlite-vec index', () => {
  let db: Database
  let vectors: VectorRepo

  beforeEach(() => {
    db = new Database({ path: ':memory:' })
    runMigrations(db)
    new EntityRepo(db).upsertMany([
      { id: 'a', type: 'rule', name: 'A', body: 'alpha' },
      { id: 'b', type: 'rule', name: 'B', body: 'beta' },
      { id: 'c', type: 'feature', name: 'C', body: null },
    ])
    vectors = new VectorRepo(db)
    vectors.upsert('a', 'm1', 'h-a', unit(1, 0, 0))
    vectors.upsert('b', 'm1', 'h-b', unit(1, 1, 0))
    vectors.upsert('c', 'm1', 'h-c', unit(0, 0, 1))
  })

  afterEach(() => db.close())

  it('scans until the index is built', () => {
    expect(vectors.indexStatus()).toEqual({
      engine: 'scan',
      reason: 'no index in the DB (run kb-ingest embed)',
    })
    expect(vectors.rebuildIndex()).toBe(3)
    expect(vectors.indexStatus()).toEqual({ engine: 'sqlite-vec' })
  })

  it('returns the same ranking and similarities as the JS scan', () => {
    vectors.rebuildIndex()
    const scan = new VectorRepo(db, { sqliteVec: false })
    expect(scan.indexStatus().engine).toBe('scan')
    for (const [q, type] of [
      [unit(1, 0.1, 0), undefined],
      [unit(0, 1, 0), 'rule'],
      [unit(0.2, 0, 1), 'feature'],
    ] as const) {
      const fast = vectors.nearest(q, { model: 'm1', type, limit: 2 })
      const slow = scan.nearest(q, { model: 'm1', type, limit: 2 })
      expect(fast.map((h) => h.id)).toEqual(slow.map((h) => h.id))
      fast.forEach((h, i) => expect(h.similarity).toBeCloseTo(slow[i]?.similarity ?? NaN, 5))
    }
  })

  it('falls back to the scan when embeddings changed after the index was built', () => {
    vectors.rebuildIndex()
    db.raw
      .prepare("INSERT INTO entities (id, type, name, updated_at) VALUES ('d', 'rule', 'D', '')")
      .run()
    vectors.upsert('d', 'm1', 'h-d', unit(0, 1, 0))

    const fresh = new VectorRepo(db)
    expect(fresh.indexStatus()).toEqual({
      engine: 'scan',
      reason: 'the index is out of sync with embeddings (run kb-ingest embed)',
    })
    expect(fresh.nearest(unit(0, 1, 0), { model: 'm1', limit: 1 })[0]?.id).toBe('d')
  })

  it('uses the scan for a model the index was not built with', () => {
    vectors.rebuildIndex()
    expect(vectors.nearest(unit(1, 0, 0), { model: 'other' })).toEqual([])
  })
})
