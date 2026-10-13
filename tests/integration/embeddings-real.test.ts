/**
 * Hybrid search against the real local embedding model. Downloads
 * ~120 MB on first run, so it only runs when asked:
 *
 *   KB_TEST_REAL_EMBEDDINGS=1 npx vitest run tests/integration/embeddings-real.test.ts
 *
 * The unit tests cover the plumbing with a fake embedder; this one checks the
 * claim the feature exists for — questions worded differently from the rule
 * still find it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from '../../src/db/Database.js'
import { runMigrations } from '../../src/db/migrations.js'
import { EntityRepo } from '../../src/repos/EntityRepo.js'
import { SearchRepo } from '../../src/repos/SearchRepo.js'
import { VectorRepo } from '../../src/repos/VectorRepo.js'
import { HybridSearch } from '../../src/search/HybridSearch.js'
import { TransformersEmbedder } from '../../src/embeddings/Embedder.js'
import { runEmbed } from '../../src/cli/runEmbed.js'

describe.skipIf(!process.env.KB_TEST_REAL_EMBEDDINGS)(
  'real embeddings (multilingual-e5-small)',
  () => {
    let tmp: string
    let db: Database
    let hybrid: HybridSearch

    beforeAll(async () => {
      tmp = mkdtempSync(join(tmpdir(), 'kb-real-emb-'))
      const dbPath = join(tmp, 'kb.db')
      const seed = new Database({ path: dbPath })
      runMigrations(seed)
      new EntityRepo(seed).upsertMany([
        {
          id: 'R-DIF-001',
          type: 'rule',
          name: 'Alta de diferido',
          body: 'Diferir una compra a meses requiere validación previa exitosa.',
        },
        {
          id: 'R-INT-001',
          type: 'rule',
          name: 'Tasa ordinaria',
          body: 'El interés ordinario se calcula con base 360 días.',
        },
        {
          id: 'R-SLA-001',
          type: 'sla',
          name: 'Cierre nocturno',
          body: 'El batch de cobro corre todas las noches a las 02:00.',
        },
      ])
      seed.close()

      await runEmbed({ dbPath, logger: () => {} })
      db = new Database({ path: dbPath, readonly: true })
      hybrid = new HybridSearch(
        new SearchRepo(db),
        new VectorRepo(db),
        (model) => new TransformersEmbedder({ model })
      )
    }, 300_000)

    afterAll(() => {
      db?.close()
      rmSync(tmp, { recursive: true, force: true })
    })

    it.each([
      ['¿puedo pagar una compra en mensualidades?', 'R-DIF-001'],
      ['¿cuántos días tiene el año para calcular intereses?', 'R-INT-001'],
      ['¿a qué hora se procesan los cargos de madrugada?', 'R-SLA-001'],
    ])('"%s" → %s', async (question, expected) => {
      const r = await hybrid.find(question, { limit: 1 })
      expect(r.mode).toBe('hybrid')
      expect(r.hits[0]?.id).toBe(expected)
    })
  }
)
