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
import { loadCatalog, validateCatalog } from '../../../src/content/catalog.js'
import { loadPrecedents, validatePrecedents } from '../../../src/content/precedents.js'
import {
  ingestCatalog,
  ingestPrecedentFiles,
  ingestRuleFiles,
} from '../../../src/content/ingest.js'

const LAYERS = ['bd', 'ms', 'web'] as const

const REPOS = `
repos:
  - id: bd-diferidos
    layer: bd
    url: git@github.com:org/bd-diferidos.git
    contiene: SPs y DDL de diferidos
`

const COMPONENTS = `
metadata:
  layer: bd
componentes:
  - objeto: sp:DIVVAL
    repo: bd-diferidos
    ruta: sp/DIVVAL.sql
`

const RULES = `
metadata:
  domain: diferidos
rules:
  - id: R-DIF-001
    type: rule
    summary: Toda alta de diferido requiere validación previa
    related_objects:
      sps: [DIVVAL]
  - id: E-DIF-001
    type: exception
    summary: Comercios pre-aprobados omiten la validación previa
    formal_rule:
      overrides: R-DIF-001
    related_objects:
      sps: [DIVVAL]
`

const PRECEDENT = `
metadata:
  area: diferidos
precedentes:
  - id: P-DIF-001
    titulo: Omitir validación para comercios pre-aprobados
    que_se_pidio: Permitir alta directa a comercios pre-aprobados
    como_se_resolvio: Bandera en DIF y una rama en DIVVAL que salta la validación
    capas: [bd]
    traza: confirmada
    verificado_en: [sp:DIVVAL, proceso:cobro-nocturno]
    reglas: [E-DIF-001, R-DIF-999]
    evidencia: [JIRA-1234]
    fecha: 2026-03-10
    status: active
`

function makeCtx(tmp: string, logs: string[]): IngestionContext {
  const db = new Database({ path: join(tmp, 'kb.db') })
  runMigrations(db)
  return {
    db,
    entities: new EntityRepo(db),
    edges: new EdgeRepo(db),
    search: new SearchRepo(db),
    options: {},
    log: (msg) => logs.push(msg),
  }
}

describe('content/catalog + precedents', () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kb-catalog-'))
    for (const dir of ['catalogo/bd', 'catalogo/_plantillas', 'precedentes/diferidos']) {
      mkdirSync(join(tmp, dir), { recursive: true })
    }
    writeFileSync(join(tmp, 'catalogo', '_plantillas', 'x.yaml'), 'componentes: [{ objeto: nope }]')
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('accepts a catalog whose components point to declared repos', () => {
    writeFileSync(join(tmp, 'catalogo', 'repos.yaml'), REPOS)
    writeFileSync(join(tmp, 'catalogo', 'bd', 'diferidos.yaml'), COMPONENTS)
    expect(validateCatalog(loadCatalog(join(tmp, 'catalogo')), { layers: LAYERS })).toEqual({
      errors: [],
      warnings: [],
    })
  })

  it('rejects unknown repos, absolute paths, bad object ids, duplicates and unknown layers', () => {
    writeFileSync(join(tmp, 'catalogo', 'repos.yaml'), REPOS.replace('layer: bd', 'layer: batch'))
    writeFileSync(
      join(tmp, 'catalogo', 'bd', 'malos.yaml'),
      `
metadata:
  layer: bd
componentes:
  - objeto: sp:DIVVAL
    repo: bd-otro
    ruta: /Users/luis/dev/bd/sp/DIVVAL.sql
  - objeto: DIVVAL
    repo: bd-diferidos
    ruta: sp/DIVVAL.sql
  - objeto: sp:DIVVAL
    repo: bd-diferidos
    ruta: sp/DIVVAL.sql
`
    )
    const all = validateCatalog(loadCatalog(join(tmp, 'catalogo')), { layers: LAYERS }).errors.join(
      '\n'
    )
    expect(all).toMatch(/bd-diferidos: layer "batch" no es válida/)
    expect(all).toMatch(/sp:DIVVAL: repo "bd-otro" no está en el catálogo/)
    expect(all).toMatch(/sp:DIVVAL: "ruta" debe ser relativa al repo/)
    expect(all).toMatch(/DIVVAL: "objeto" debe ser <tipo>:<nombre>/)
    expect(all).toMatch(/sp:DIVVAL: objeto mapeado dos veces/)
  })

  it('requires verificado_en for a confirmed trace and warns on a possible one', () => {
    writeFileSync(
      join(tmp, 'precedentes', 'diferidos', 'p.yaml'),
      PRECEDENT.replace('verificado_en: [sp:DIVVAL, proceso:cobro-nocturno]', '') +
        `  - id: P-DIF-002
    titulo: x
    que_se_pidio: x
    como_se_resolvio: x
    capas: [batch]
    traza: posible
    status: active
`
    )
    const { errors, warnings } = validatePrecedents(loadPrecedents(join(tmp, 'precedentes')), {
      layers: LAYERS,
    })
    const label = (id: string) => `${join(tmp, 'precedentes', 'diferidos', 'p.yaml')}: ${id}`
    expect(errors).toEqual([
      `${label('P-DIF-001')}: traza confirmada sin "verificado_en" — di en qué objeto se leyó la solución`,
      `${label('P-DIF-002')}: layer "batch" no es válida (bd, ms, web)`,
    ])
    expect(warnings).toEqual([
      `${label('P-DIF-002')}: traza posible — confirmarla en el código antes de seguirla`,
    ])
  })

  it('keeps an unquoted date as text', () => {
    writeFileSync(join(tmp, 'precedentes', 'diferidos', 'p.yaml'), PRECEDENT)
    expect(loadPrecedents(join(tmp, 'precedentes'))[0]?.precedents[0]?.fecha).toBe('2026-03-10')
  })

  it('adds the location to objects rules created and links precedents to what exists', () => {
    writeFileSync(join(tmp, 'rules.yaml'), RULES)
    writeFileSync(join(tmp, 'catalogo', 'repos.yaml'), REPOS)
    writeFileSync(join(tmp, 'catalogo', 'bd', 'diferidos.yaml'), COMPONENTS)
    writeFileSync(join(tmp, 'precedentes', 'diferidos', 'p.yaml'), PRECEDENT)
    const logs: string[] = []
    const ctx = makeCtx(tmp, logs)
    try {
      ingestRuleFiles(ctx, [join(tmp, 'rules.yaml')])
      expect(ingestCatalog(ctx, loadCatalog(join(tmp, 'catalogo')))).toEqual({
        repos: 1,
        components: 1,
        edges: 1,
      })
      const sp = ctx.entities.getById('sp:DIVVAL')
      expect(sp?.type).toBe('stored_procedure')
      expect(sp?.metadata).toMatchObject({
        domain: 'diferidos',
        location: { repo: 'bd-diferidos', path: 'sp/DIVVAL.sql', layer: 'bd' },
      })
      expect(sp?.body).toContain('Ubicación: bd-diferidos/sp/DIVVAL.sql')
      expect(ctx.edges.outgoing('sp:DIVVAL').map((e) => e.dst)).toEqual(['repo:bd-diferidos'])
      // The file name an agent has open finds the object.
      expect(ctx.search.byTerm('divval.sql').map((h) => h.id)).toContain('sp:DIVVAL')

      expect(ingestPrecedentFiles(ctx, loadPrecedents(join(tmp, 'precedentes')))).toEqual({
        precedents: 1,
        edges: 3,
      })
      const p = ctx.entities.getById('precedent:P-DIF-001')
      expect(p?.body).toContain('Traza: confirmada en sp:DIVVAL, proceso:cobro-nocturno')
      expect(
        ctx.edges
          .outgoing('precedent:P-DIF-001')
          .map((e) => `${e.relation} ${e.dst}`)
          .sort()
      ).toEqual([
        'applies_rule exception:E-DIF-001',
        'verified_in proceso:cobro-nocturno',
        'verified_in sp:DIVVAL',
      ])
      // An object only the precedent knows is created; the located one keeps its location.
      expect(ctx.entities.getById('proceso:cobro-nocturno')?.type).toBe('proceso')
      expect(ctx.entities.getById('sp:DIVVAL')?.metadata.location).toBeTruthy()
      expect(logs).toEqual([
        'WARN: precedent:P-DIF-001 apunta a la regla R-DIF-999, que no está en la KB',
      ])
      expect(ctx.search.byTerm('jira-1234').map((h) => h.id)).toEqual(['precedent:P-DIF-001'])
      expect(ctx.search.byTerm('divval').map((h) => h.id)).toContain('precedent:P-DIF-001')
    } finally {
      ctx.db.close()
    }
  })
})
