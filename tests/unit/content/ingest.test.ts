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
import { loadNotes, pickSection } from '../../../src/content/notes.js'
import { loadStandards } from '../../../src/content/standards.js'
import {
  ingestDecisionNotes,
  ingestRuleFiles,
  ingestStandardFiles,
  type Summarize,
} from '../../../src/content/ingest.js'

const summarize: Summarize = (note) => ({
  id: note.id ?? '',
  status: (note.frontmatter.status as string) ?? null,
  why: pickSection(note, 'intencion')?.text ?? null,
  noSignifica: pickSection(note, 'no significa')?.items ?? [],
  validatedBy: null,
})

describe('content/ingest', () => {
  let tmp: string
  let db: Database
  let ctx: IngestionContext
  let logs: string[]

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kb-content-ingest-'))
    db = new Database({ path: join(tmp, 'kb.db') })
    runMigrations(db)
    logs = []
    ctx = {
      db,
      entities: new EntityRepo(db),
      edges: new EdgeRepo(db),
      search: new SearchRepo(db),
      options: {},
      log: (msg) => logs.push(msg),
    }
    mkdirSync(join(tmp, 'vault'))
    writeFileSync(
      join(tmp, 'vault', 'DEC-COB-001.md'),
      `---
id: DEC-COB-001
status: accepted
domain: cobranza
---
# DEC-COB-001 — Prelación explícita

## Intención

El orden es una lista, no un algoritmo.

## No significa

- Que el IVA vaya siempre antes que su principal
`
    )
    writeFileSync(
      join(tmp, 'rules.yaml'),
      `
metadata:
  domain: cobranza
  version: "1.0.0"
rules:
  - id: R-COB-001
    type: rule
    summary: El pago se aplica en el orden de la prelación configurada
    applicability:
      evento: [aplicar_pago]
    decision: DEC-COB-001
    no_significa:
      - Que el orden varíe por producto en Crédito Primero
    related_objects:
      tables: [servicing_payment_allocation_rules]
      code: ["modules/servicing/domain/payment_waterfall.py::split_with_vat"]
  - id: E-COB-001
    type: exception
    summary: Excepción de prueba
    applicability:
      evento: [aplicar_pago]
    formal_rule:
      overrides: R-COB-001
    decision: DEC-COB-404
`
    )
  })

  afterEach(() => {
    db.close()
    rmSync(tmp, { recursive: true, force: true })
  })

  it('embeds the decision and inline misreadings into the rule', () => {
    const decisions = loadNotes(join(tmp, 'vault'))
    expect(ingestDecisionNotes(ctx, decisions, { summarize })).toBe(1)
    const result = ingestRuleFiles(ctx, [join(tmp, 'rules.yaml')], { decisions, summarize })
    expect(result.rules).toBe(2)

    const rule = ctx.entities.getById('rule:R-COB-001')
    expect(rule?.body).toContain('Por qué: El orden es una lista, no un algoritmo.')
    expect(rule?.body).toContain('No significa: Que el IVA vaya siempre antes que su principal')
    expect(rule?.body).toContain('No significa: Que el orden varíe por producto')
    expect(rule?.metadata.decision).toMatchObject({ id: 'DEC-COB-001', status: 'accepted' })

    const out = ctx.edges.outgoing('rule:R-COB-001').map((e) => `${e.relation}→${e.dst}`)
    expect(out).toEqual(
      expect.arrayContaining([
        'justified_by→decision:DEC-COB-001',
        'uses_table→table:servicing_payment_allocation_rules',
        'uses_code→code:modules/servicing/domain/payment_waterfall.py::split_with_vat',
      ])
    )
    expect(ctx.search.byTerm('split_with_vat').map((h) => h.id)).toContain('rule:R-COB-001')
  })

  it('links exceptions to what they override and warns on unknown decisions', () => {
    const decisions = loadNotes(join(tmp, 'vault'))
    ingestDecisionNotes(ctx, decisions, { summarize })
    ingestRuleFiles(ctx, [join(tmp, 'rules.yaml')], { decisions, summarize })
    expect(ctx.edges.outgoing('exception:E-COB-001', 'overrides')[0]?.dst).toBe('rule:R-COB-001')
    expect(ctx.edges.outgoing('exception:E-COB-001', 'justified_by')).toEqual([])
    expect(logs).toContain('WARN: E-COB-001 cita DEC-COB-404 pero no existe')
  })

  it('ingests standards searchable by technology', () => {
    mkdirSync(join(tmp, 'standards', 'python'), { recursive: true })
    writeFileSync(
      join(tmp, 'standards', 'python', 'arquitectura.yaml'),
      `
metadata:
  technology: python
standards:
  - id: STD-PY-001
    category: structure
    summary: domain/ es Python puro
    level: must
    applies_to: [domain]
    rationale: aislar reglas de negocio de la infraestructura
    owner: backend
    status: active
`
    )
    const result = ingestStandardFiles(ctx, loadStandards(join(tmp, 'standards')))
    expect(result.standards).toBe(1)
    expect(ctx.search.byTerm('python').map((h) => h.id)).toEqual(['standard:STD-PY-001'])
  })
})
