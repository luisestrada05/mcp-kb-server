import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Database } from '../../../src/db/Database.js'
import { runMigrations } from '../../../src/db/migrations.js'
import { EntityRepo } from '../../../src/repos/EntityRepo.js'

describe('EntityRepo', () => {
  let db: Database
  let repo: EntityRepo

  beforeEach(() => {
    db = new Database({ path: ':memory:' })
    runMigrations(db)
    repo = new EntityRepo(db)
  })

  afterEach(() => {
    db.close()
  })

  it('upserts and retrieves an entity round-trip', () => {
    repo.upsert({
      id: 'rule:diferidos',
      type: 'rule',
      name: 'Reglas de diferidos',
      body: 'No aplicar interés sobre diferidos sin promoción.',
      metadata: { severity: 'critical', owner: 'finanzas' },
      sourcePath: 'docs/rules/diferidos.md',
    })

    const got = repo.getById('rule:diferidos')
    expect(got).not.toBeNull()
    expect(got?.name).toBe('Reglas de diferidos')
    expect(got?.body).toContain('promoción')
    expect(got?.metadata).toEqual({ severity: 'critical', owner: 'finanzas' })
    expect(got?.sourcePath).toBe('docs/rules/diferidos.md')
  })

  it('upsert is idempotent — second call updates metadata', () => {
    repo.upsert({ id: 'r1', type: 'rule', name: 'v1', metadata: { v: 1 } })
    repo.upsert({ id: 'r1', type: 'rule', name: 'v2', metadata: { v: 2 } })
    expect(repo.getById('r1')?.name).toBe('v2')
    expect(repo.getById('r1')?.metadata).toEqual({ v: 2 })
    expect(repo.count('rule')).toBe(1)
  })

  it('upsertMany runs in a single transaction', () => {
    const n = repo.upsertMany([
      { id: 'a', type: 'rule', name: 'A' },
      { id: 'b', type: 'rule', name: 'B' },
      { id: 'c', type: 'feature', name: 'C' },
    ])
    expect(n).toBe(3)
    expect(repo.count()).toBe(3)
    expect(repo.count('rule')).toBe(2)
  })

  it('getById returns null for unknown id', () => {
    expect(repo.getById('does-not-exist')).toBeNull()
  })

  it('delete returns true when row existed, false when not', () => {
    repo.upsert({ id: 'r1', type: 'rule', name: 'one' })
    expect(repo.delete('r1')).toBe(true)
    expect(repo.delete('r1')).toBe(false)
    expect(repo.getById('r1')).toBeNull()
  })

  it('listByType filters and orders by updated_at DESC', async () => {
    repo.upsert({ id: 'r1', type: 'rule', name: 'first' })
    // Force a different updated_at by waiting at least 1ms.
    await new Promise((r) => setTimeout(r, 5))
    repo.upsert({ id: 'r2', type: 'rule', name: 'second' })
    repo.upsert({ id: 'f1', type: 'feature', name: 'feat' })

    const rules = repo.listByType('rule')
    expect(rules.map((r) => r.id)).toEqual(['r2', 'r1'])
    expect(repo.listByType('feature').map((r) => r.id)).toEqual(['f1'])
  })

  it('defaults: body=null, metadata={}, sourcePath=null', () => {
    repo.upsert({ id: 'r1', type: 'rule', name: 'minimal' })
    const e = repo.getById('r1')
    expect(e?.body).toBeNull()
    expect(e?.metadata).toEqual({})
    expect(e?.sourcePath).toBeNull()
  })
})
