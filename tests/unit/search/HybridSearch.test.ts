import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Database } from '../../../src/db/Database.js'
import { runMigrations } from '../../../src/db/migrations.js'
import { EntityRepo } from '../../../src/repos/EntityRepo.js'
import { SearchRepo } from '../../../src/repos/SearchRepo.js'
import { VectorRepo } from '../../../src/repos/VectorRepo.js'
import { HybridSearch, reciprocalRankFusion } from '../../../src/search/HybridSearch.js'
import { FakeEmbedder } from '../../helpers/fakeEmbedder.js'
import { contentHash, entityText, type Embedder } from '../../../src/embeddings/Embedder.js'

describe('HybridSearch', () => {
  let db: Database
  let entities: EntityRepo
  let search: SearchRepo
  let vectors: VectorRepo
  let embedder: FakeEmbedder

  async function embedAll(): Promise<void> {
    const rows = db.raw.prepare('SELECT id, name, body FROM entities').all() as Array<{
      id: string
      name: string
      body: string | null
    }>
    const out = await embedder.embedPassages(rows.map((r) => entityText(r.name, r.body)))
    rows.forEach((r, i) =>
      vectors.upsert(
        r.id,
        embedder.model,
        contentHash(embedder.model, r.name),
        out[i] as Float32Array
      )
    )
  }

  beforeEach(() => {
    db = new Database({ path: ':memory:' })
    runMigrations(db)
    entities = new EntityRepo(db)
    search = new SearchRepo(db)
    vectors = new VectorRepo(db)
    embedder = new FakeEmbedder()
    entities.upsertMany([
      {
        id: 'R-DIF-001',
        type: 'rule',
        name: 'Alta de diferido',
        body: 'Requiere validación previa exitosa.',
      },
      {
        id: 'R-INT-001',
        type: 'rule',
        name: 'Tasa ordinaria',
        body: 'La tasa se calcula con base 360.',
      },
      {
        id: 'E-COM-001',
        type: 'exception',
        name: 'Comercios pre-aprobados',
        body: 'Omiten la revisión.',
      },
    ])
  })

  afterEach(() => db.close())

  it('falls back to FTS with a warning when the KB has no vectors', async () => {
    const hybrid = new HybridSearch(search, vectors, () => embedder)
    const r = await hybrid.find('diferido')
    expect(r.mode).toBe('fts')
    expect(r.warning).toMatch(/no embeddings/)
    expect(r.hits.map((h) => h.id)).toEqual(['R-DIF-001'])
    expect(embedder.calls).toBe(0)
  })

  it('falls back to FTS with a warning when the model cannot load', async () => {
    await embedAll()
    const broken: Embedder = {
      model: embedder.model,
      embedQuery: () => Promise.reject(new Error('offline')),
      embedPassages: () => Promise.reject(new Error('offline')),
    }
    const r = await new HybridSearch(search, vectors, () => broken).find('diferido')
    expect(r.mode).toBe('fts')
    expect(r.warning).toMatch(/offline/)
    expect(r.hits.map((h) => h.id)).toEqual(['R-DIF-001'])
  })

  it('semantic mode finds a rule that shares no words with the question', async () => {
    await embedAll()
    const hybrid = new HybridSearch(search, vectors, () => embedder)
    const question = '¿puedo pagar a meses?'
    expect(search.fullTextLenient(question)).toEqual([])

    const r = await hybrid.find(question, { mode: 'semantic', limit: 1 })
    expect(r.mode).toBe('semantic')
    expect(r.hits[0]).toMatchObject({ id: 'R-DIF-001', matchedBy: ['vector'] })
    expect(r.hits[0]?.snippet).toContain('validación')
  })

  it('hybrid mode ranks hits found by both retrievers first', async () => {
    await embedAll()
    const hybrid = new HybridSearch(search, vectors, () => embedder)
    const r = await hybrid.find('verificar comercios')
    expect(r.mode).toBe('hybrid')
    expect(r.hits[0]).toMatchObject({ id: 'E-COM-001', matchedBy: ['fts', 'vector'] })
    expect(r.hits[0]?.score).toBeGreaterThan(r.hits[1]?.score ?? 0)
  })

  it('embeds queries with the model recorded in the DB', async () => {
    await embedAll()
    const asked: string[] = []
    const hybrid = new HybridSearch(search, vectors, (model) => {
      asked.push(model)
      return embedder
    })
    await hybrid.find('diferido')
    await hybrid.find('tasa')
    expect(asked).toEqual(['fake/concepts-v1'])
  })

  it('fts mode never touches the embedder', async () => {
    await embedAll()
    const r = await new HybridSearch(search, vectors, () => embedder).find('tasa', { mode: 'fts' })
    expect(r).toEqual({ mode: 'fts', hits: [expect.objectContaining({ id: 'R-INT-001' })] })
    expect(embedder.calls).toBe(1) // only the embedAll() call
  })

  it('applies the type filter to both retrievers', async () => {
    await embedAll()
    const r = await new HybridSearch(search, vectors, () => embedder).find('comercios', {
      type: 'rule',
    })
    expect(r.hits.length).toBeGreaterThan(0)
    expect(r.hits.every((h) => h.type === 'rule')).toBe(true)
  })
})

describe('reciprocalRankFusion', () => {
  it('sums 1/(60+rank) across lists and sorts by score', () => {
    const fts = [
      { id: 'x', type: 't', name: 'X', snippet: '' },
      { id: 'y', type: 't', name: 'Y', snippet: '' },
    ]
    const vec = [
      { id: 'y', type: 't', name: 'Y', body: null, similarity: 0.9 },
      { id: 'z', type: 't', name: 'Z', body: null, similarity: 0.8 },
    ]
    const out = reciprocalRankFusion(fts, vec)
    expect(out.map((h) => h.id)).toEqual(['y', 'x', 'z'])
    expect(out[0]?.score).toBeCloseTo(1 / 62 + 1 / 61, 10)
    expect(out[0]?.matchedBy).toEqual(['fts', 'vector'])
  })
})
