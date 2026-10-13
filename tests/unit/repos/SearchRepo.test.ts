import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Database } from '../../../src/db/Database.js'
import { runMigrations } from '../../../src/db/migrations.js'
import { EntityRepo } from '../../../src/repos/EntityRepo.js'
import { SearchRepo, toOrQuery } from '../../../src/repos/SearchRepo.js'

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

describe('SearchRepo.fullTextLenient', () => {
  let db: Database
  let search: SearchRepo

  beforeEach(() => {
    db = new Database({ path: ':memory:' })
    runMigrations(db)
    search = new SearchRepo(db)
    new EntityRepo(db).upsertMany([
      { id: 'r1', type: 'rule', name: 'Reglas de diferidos', body: 'Sin promoción vigente no hay MSI.' },
      { id: 'r2', type: 'rule', name: 'Promociones', body: 'Requieren autorización.' },
    ])
  })

  afterEach(() => db.close())

  it('accepts punctuation that is FTS5 syntax', () => {
    expect(() => search.fullText('¿qué pasa con diferidos?')).toThrow()
    expect(search.fullTextLenient('¿qué pasa con diferidos?').map((h) => h.id)).toEqual(['r1'])
  })

  it('ORs the words when the implicit AND finds nothing, prefix-matching each', () => {
    expect(search.fullText('diferido autorización')).toEqual([])
    const ids = search.fullTextLenient('diferido autorización').map((h) => h.id).sort()
    expect(ids).toEqual(['r1', 'r2'])
  })

  it('finds an entity by a hyphenated ID that FTS5 would read as operators', () => {
    new EntityRepo(db).upsert({ id: 'r3', type: 'rule', name: '[R-DIF-011] Monto mínimo', body: null })
    expect(() => search.fullText('R-DIF-011')).toThrow()
    expect(search.fullTextLenient('R-DIF-011').map((h) => h.id)).toEqual(['r3'])
  })

  it('keeps FTS5 operators when the verbatim query works', () => {
    expect(search.fullTextLenient('promo*').map((h) => h.id).sort()).toEqual(['r1', 'r2'])
  })
})

describe('toOrQuery', () => {
  it('quotes words, drops short ones and stopwords, prefixes long ones, dedupes', () => {
    expect(toOrQuery('¿Qué pasa si quiero DIFERIR la compra? diferir')).toBe(
      '"quiero"* OR "diferir"* OR "compra"*'
    )
    expect(toOrQuery('a de la ¿cuándo?')).toBe('')
  })

  it('keeps hyphenated IDs together as a phrase', () => {
    expect(toOrQuery('R-DIF-011 pre-aprobados')).toBe('"r dif 011" OR "pre aprobados"')
  })
})
