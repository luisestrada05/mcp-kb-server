import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Database } from '../../../src/db/Database.js'
import { runMigrations } from '../../../src/db/migrations.js'
import { EntityRepo } from '../../../src/repos/EntityRepo.js'
import { SearchRepo } from '../../../src/repos/SearchRepo.js'

describe('SearchRepo', () => {
  let db: Database
  let entities: EntityRepo
  let search: SearchRepo

  beforeEach(() => {
    db = new Database({ path: ':memory:' })
    runMigrations(db)
    entities = new EntityRepo(db)
    search = new SearchRepo(db)

    entities.upsertMany([
      {
        id: 'r1',
        type: 'rule',
        name: 'Reglas de diferidos',
        body: 'No aplicar interés sobre diferidos sin promoción vigente.',
      },
      {
        id: 'r2',
        type: 'rule',
        name: 'Promociones bancarias',
        body: 'Las promociones de meses sin intereses requieren autorización.',
      },
      {
        id: 'f1',
        type: 'feature',
        name: 'Calculadora de diferidos',
        body: 'Componente para visualizar pagos diferidos.',
      },
    ])
  })

  afterEach(() => {
    db.close()
  })

  it('fullText finds entities by word in name or body', () => {
    const hits = search.fullText('diferidos')
    const ids = hits.map((h) => h.id).sort()
    expect(ids).toEqual(['f1', 'r1'])
  })

  it('fullText respects type filter', () => {
    const hits = search.fullText('diferidos', { type: 'rule' })
    expect(hits.map((h) => h.id)).toEqual(['r1'])
  })

  it('fullText returns BM25 rank and a snippet', () => {
    const hits = search.fullText('promoción')
    expect(hits[0]).toBeDefined()
    expect(typeof hits[0]?.rank).toBe('number')
    expect(hits[0]?.snippet).toContain('<<')
  })

  it('byTerm resolves keyword to entities (case-insensitive)', () => {
    search.addTerms('r1', ['diferidos', 'finanzas'])
    search.addTerms('f1', ['DIFERIDOS', 'frontend'])

    const hits = search.byTerm('Diferidos')
    const ids = hits.map((h) => h.id).sort()
    expect(ids).toEqual(['f1', 'r1'])

    expect(search.byTerm('finanzas').map((h) => h.id)).toEqual(['r1'])
    expect(search.byTerm('unknown')).toEqual([])
  })

  it('byTerm respects type filter and returns body excerpt as snippet', () => {
    search.addTerms('r1', ['diferidos'])
    search.addTerms('f1', ['diferidos'])
    const hits = search.byTerm('diferidos', { type: 'rule' })
    expect(hits).toHaveLength(1)
    expect(hits[0]?.snippet.length).toBeGreaterThan(0)
  })

  it('addTerms is idempotent on (term, entity_id)', () => {
    search.addTerms('r1', ['diferidos'])
    search.addTerms('r1', ['diferidos'])
    expect(search.byTerm('diferidos').map((h) => h.id)).toEqual(['r1'])
  })

  it('clearTerms wipes only that entity terms', () => {
    search.addTerms('r1', ['diferidos', 'finanzas'])
    search.addTerms('r2', ['promocion'])
    search.clearTerms('r1')
    expect(search.byTerm('diferidos')).toEqual([])
    expect(search.byTerm('promocion').map((h) => h.id)).toEqual(['r2'])
  })

  it('fullText supports phrase queries via FTS5 syntax', () => {
    const hits = search.fullText('"meses sin intereses"')
    expect(hits.map((h) => h.id)).toEqual(['r2'])
  })

  it('fullText respects limit', () => {
    const hits = search.fullText('diferidos', { limit: 1 })
    expect(hits).toHaveLength(1)
  })
})
