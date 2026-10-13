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
