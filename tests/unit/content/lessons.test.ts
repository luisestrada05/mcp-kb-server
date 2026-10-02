import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from '../../../src/db/Database.js'
import { runMigrations } from '../../../src/db/migrations.js'
import { EntityRepo } from '../../../src/repos/EntityRepo.js'
import { EdgeRepo } from '../../../src/repos/EdgeRepo.js'
import { SearchRepo } from '../../../src/repos/SearchRepo.js'
import type { IngestionContext } from '../../../src/cli/plugin.js'
import { loadLessons, validateLessons } from '../../../src/content/lessons.js'
import { ingestLessonFiles } from '../../../src/content/ingest.js'

const LESSON = `
metadata:
  area: ops
lessons:
  - id: L-OPS-001
    titulo: Dos ramas con migración eligen el mismo padre
    que_paso: CI verde en ambas; al mergear la segunda, main queda con dos cabezas
    costo: 4 veces
    causa_raiz: el verde se queda viejo
    no_hagas: confiar en CI verde por rama
    haz_en_cambio: exigir rama al día
    guarda:
      estado: parcial
      detalle: test_the_repo_has_a_single_head
    evidencia: [T-0022, AUR-915]
    reglas: [R-OPS-001]
    terminos: [Alembic]
    codigo: ["tests/meta/test_pld_block_migration_chain.py::test_the_repo_has_a_single_head"]
    status: active
`

describe('content/lessons', () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kb-lessons-'))
    mkdirSync(join(tmp, 'ops'))
    mkdirSync(join(tmp, '_plantillas'))
    writeFileSync(join(tmp, '_plantillas', 'lesson.yaml'), 'lessons: [{ id: nope }]')
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('accepts a complete lesson and warns that a partial guard depends on someone reading it', () => {
    writeFileSync(join(tmp, 'ops', 'migraciones.yaml'), LESSON)
    const { errors, warnings } = validateLessons(loadLessons(tmp))
    expect(errors).toEqual([])
    expect(warnings).toEqual([
      `${join(tmp, 'ops', 'migraciones.yaml')}: L-OPS-001: guarda parcial — repetirla depende de que alguien lea la lección`,
    ])
  })

  it('rejects bad ids, empty evidence, unknown guard states and guards without detail', () => {
    writeFileSync(
      join(tmp, 'ops', 'malas.yaml'),
      `
metadata:
  area: ops
lessons:
  - id: L-1
    titulo: x
    que_paso: x
    causa_raiz: x
    no_hagas: x
    haz_en_cambio: x
    guarda: { estado: quizá }
    evidencia: []
    status: active
  - id: L-OPS-002
    titulo: x
    que_paso: x
    causa_raiz: x
    no_hagas: x
    haz_en_cambio: x
    guarda: { estado: completa }
    evidencia: [T-1]
    decision: ADR-404
    status: vigente
`
    )
    const all = validateLessons(loadLessons(tmp), { knownDecisions: new Set() }).errors.join('\n')
    expect(all).toMatch(/L-1: ID no cumple/)
    expect(all).toMatch(/L-1: "evidencia" está vacía/)
    expect(all).toMatch(/L-1: guarda.estado "quizá"/)
    expect(all).toMatch(/L-OPS-002: guarda.detalle es obligatorio/)
    expect(all).toMatch(/L-OPS-002: status "vigente"/)
    expect(all).toMatch(/L-OPS-002: cita ADR-404/)
  })

  it('rejects list items that YAML did not read as text (an unquoted 422 is a number)', () => {
    writeFileSync(
      join(tmp, 'ops', 'migraciones.yaml'),
      LESSON.replace('terminos: [Alembic]', 'terminos: [Alembic, 422, true]').replace(
        'evidencia: [T-0022, AUR-915]',
        'evidencia: T-0022'
      )
    )
    const { errors } = validateLessons(loadLessons(tmp))
    const label = `${join(tmp, 'ops', 'migraciones.yaml')}: L-OPS-001`
    expect(errors).toEqual([
      `${label}: "evidencia" debe ser una lista`,
      `${label}: terminos[1] = 422 no es texto — ponlo entre comillas`,
      `${label}: terminos[2] = true no es texto — ponlo entre comillas`,
    ])
  })

  it('ingests lessons findable by code symbol and ticket, linking only to existing rules', () => {
    writeFileSync(join(tmp, 'ops', 'migraciones.yaml'), LESSON)
    const db = new Database({ path: join(tmp, 'kb.db') })
    runMigrations(db)
    const logs: string[] = []
    const ctx: IngestionContext = {
      db,
      entities: new EntityRepo(db),
      edges: new EdgeRepo(db),
      search: new SearchRepo(db),
      options: {},
      log: (msg) => logs.push(msg),
    }
    try {
      const result = ingestLessonFiles(ctx, loadLessons(tmp))
      expect(result.lessons).toBe(1)

      const lesson = ctx.entities.getById('lesson:L-OPS-001')
      expect(lesson?.body).toContain('Guarda (parcial): test_the_repo_has_a_single_head')
      expect(lesson?.metadata.guard).toBe('parcial')
      expect(ctx.search.byTerm('test_the_repo_has_a_single_head').map((h) => h.id)).toEqual([
        'lesson:L-OPS-001',
      ])
      expect(ctx.search.byTerm('aur-915').map((h) => h.id)).toEqual(['lesson:L-OPS-001'])
      expect(ctx.search.byTerm('alembic').map((h) => h.id)).toEqual(['lesson:L-OPS-001'])
      // The file an agent is editing finds the lesson, by name or by path.
      for (const term of [
        'test_pld_block_migration_chain',
        'test_pld_block_migration_chain.py',
        'tests/meta/test_pld_block_migration_chain.py',
        'tests/meta/test_pld_block_migration_chain.py::test_the_repo_has_a_single_head',
      ]) {
        expect(ctx.search.byTerm(term).map((h) => h.id), term).toEqual(['lesson:L-OPS-001'])
      }
      expect(logs).toContain('WARN: lesson:L-OPS-001 apunta a rule:R-OPS-001, que no está en la KB')
      expect(ctx.edges.outgoing('lesson:L-OPS-001').map((e) => e.relation)).toEqual([
        'involves_code',
      ])
    } finally {
      db.close()
    }
  })
})
