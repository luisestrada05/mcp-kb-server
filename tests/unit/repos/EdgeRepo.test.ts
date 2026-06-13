import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Database } from '../../../src/db/Database.js'
import { runMigrations } from '../../../src/db/migrations.js'
import { EntityRepo } from '../../../src/repos/EntityRepo.js'
import { EdgeRepo } from '../../../src/repos/EdgeRepo.js'

describe('EdgeRepo', () => {
  let db: Database
  let entities: EntityRepo
  let edges: EdgeRepo

  beforeEach(() => {
    db = new Database({ path: ':memory:' })
    runMigrations(db)
    entities = new EntityRepo(db)
    edges = new EdgeRepo(db)

    // Build a small graph:
    //
    //   a ──depends_on──> b ──depends_on──> c
    //    \                                  /
    //     └────────────cites────────────────┘
    //
    entities.upsertMany([
      { id: 'a', type: 'rule', name: 'A' },
      { id: 'b', type: 'rule', name: 'B' },
      { id: 'c', type: 'rule', name: 'C' },
    ])
    edges.upsert({ src: 'a', dst: 'b', relation: 'depends_on' })
    edges.upsert({ src: 'b', dst: 'c', relation: 'depends_on' })
    edges.upsert({ src: 'a', dst: 'c', relation: 'cites' })
  })

  afterEach(() => {
    db.close()
  })

  it('outgoing returns all edges from src; filter by relation works', () => {
    expect(edges.outgoing('a').map((e) => e.dst).sort()).toEqual(['b', 'c'])
    expect(edges.outgoing('a', 'depends_on').map((e) => e.dst)).toEqual(['b'])
    expect(edges.outgoing('a', 'cites').map((e) => e.dst)).toEqual(['c'])
  })

  it('incoming returns all edges to dst; filter by relation works', () => {
    expect(edges.incoming('c').map((e) => e.src).sort()).toEqual(['a', 'b'])
    expect(edges.incoming('c', 'cites').map((e) => e.src)).toEqual(['a'])
  })

  it('upsert is idempotent on (src, dst, relation)', () => {
    edges.upsert({ src: 'a', dst: 'b', relation: 'depends_on', metadata: { weight: 2 } })
    const out = edges.outgoing('a', 'depends_on')
    expect(out).toHaveLength(1)
    expect(out[0]?.metadata).toEqual({ weight: 2 })
  })

  it('delete only removes the matching triple', () => {
    expect(edges.delete('a', 'b', 'depends_on')).toBe(true)
    expect(edges.delete('a', 'b', 'depends_on')).toBe(false)
    expect(edges.outgoing('a').map((e) => e.dst).sort()).toEqual(['c'])
  })

  it('traverse with depth=1 returns start + direct outgoing nodes', () => {
    const result = edges.traverse('a', { maxDepth: 1 })
    const ids = result.map((r) => r.entity.id)
    expect(ids).toContain('a')
    expect(ids).toContain('b')
    expect(ids).toContain('c')
    expect(result[0]).toMatchObject({ depth: 0, relation: null })
    expect(result.filter((r) => r.depth === 1)).toHaveLength(2)
  })

  it('traverse with relation filter only follows that relation', () => {
    const result = edges.traverse('a', { relation: 'depends_on', maxDepth: 2 })
    const ids = result.map((r) => r.entity.id)
    expect(ids).toEqual(['a', 'b', 'c'])
    expect(result.find((r) => r.entity.id === 'c')?.depth).toBe(2)
    expect(result.find((r) => r.entity.id === 'c')?.relation).toBe('depends_on')
  })

  it('traverse handles cycles without infinite loop', () => {
    edges.upsert({ src: 'c', dst: 'a', relation: 'cites' })
    const result = edges.traverse('a', { maxDepth: 10 })
    // Should still only visit each node once.
    const ids = result.map((r) => r.entity.id).sort()
    expect(ids).toEqual(['a', 'b', 'c'])
  })

  it('traverse on unknown start returns empty', () => {
    expect(edges.traverse('ghost')).toEqual([])
  })

  it('related returns both directions', () => {
    const r = edges.related('b')
    expect(r.outgoing.map((e) => e.dst)).toEqual(['c'])
    expect(r.incoming.map((e) => e.src)).toEqual(['a'])
  })
})
