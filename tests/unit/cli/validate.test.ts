import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateRulesFile } from '../../../src/cli/validate.js'

/**
 * Tests focused on schema validation that does NOT touch interactive prompts.
 * autoRegister: true keeps handleMissing non-interactive so the cases that
 * involve unknown table/sp refs can run headless.
 */
describe('validateRulesFile — schema integrity', () => {
  let tmp: string
  let dbPath: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kb-validate-'))
    dbPath = join(tmp, 'kb.db')
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  function writeYaml(body: string): string {
    const file = join(tmp, 'rules.yaml')
    writeFileSync(file, body)
    return file
  }

  it('rejects ID prefix that does not match type', async () => {
    const file = writeYaml(`
metadata:
  domain: diferidos
  version: "1.0.0"
  created_at: "2026-06-15"
rules:
  - id: R-DIF-001
    type: exception
    summary: test
    applicability:
      evento: [alta]
    source_ref: page
    owner: team
    status: active
    risk_note: nota
    formal_rule:
      action: registrar
      conditions:
        - field: monto
          op: gt
          value: 0
`)
    const result = await validateRulesFile({ dbPath, filePath: file, autoRegister: true })
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes('ID prefix "R-" implica type="rule"'))).toBe(true)
  })

  it('rejects status outside the active|deprecated|draft enum', async () => {
    const file = writeYaml(`
metadata:
  domain: diferidos
  version: "1.0.0"
  created_at: "2026-06-15"
rules:
  - id: R-DIF-002
    type: rule
    summary: test
    applicability:
      evento: [alta]
    source_ref: page
    owner: team
    status: en-revision
    risk_note: nota
    formal_rule:
      action: registrar
      conditions:
        - field: monto
          op: gt
          value: 0
`)
    const result = await validateRulesFile({ dbPath, filePath: file, autoRegister: true })
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes('status "en-revision"'))).toBe(true)
  })

  it('rejects empty or non-array applicability.evento', async () => {
    const file = writeYaml(`
metadata:
  domain: diferidos
  version: "1.0.0"
  created_at: "2026-06-15"
rules:
  - id: R-DIF-003
    type: rule
    summary: test
    applicability:
      evento: []
    source_ref: page
    owner: team
    status: active
    risk_note: nota
    formal_rule:
      action: registrar
      conditions:
        - field: monto
          op: gt
          value: 0
`)
    const result = await validateRulesFile({ dbPath, filePath: file, autoRegister: true })
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes('applicability.evento debe ser un array'))).toBe(true)
  })

  it('rejects applicability and related_objects items that YAML did not read as text', async () => {
    const file = writeYaml(`
metadata:
  domain: diferidos
  version: "1.0.0"
  created_at: "2026-06-15"
rules:
  - id: R-DIF-005
    type: rule
    summary: test
    applicability:
      evento: [alta_diferido, 422]
    source_ref: page
    owner: team
    status: active
    risk_note: nota
    related_objects:
      tables: [diferidos]
      code: ["modules/x.py::y", 2026-10-01]
    formal_rule:
      action: registrar
      conditions:
        - field: monto
          op: gt
          value: 0
`)
    const result = await validateRulesFile({ dbPath, filePath: file, autoRegister: true })
    expect(result.valid).toBe(false)
    expect(result.errors).toContain(
      'R-DIF-005: applicability.evento[1] = 422 no es texto — ponlo entre comillas'
    )
    expect(
      result.errors.some((e) => e.startsWith('R-DIF-005: related_objects.code[1] = "2026-10-01'))
    ).toBe(true)
  })

  it('accepts a well-formed rule with no related_objects (warns only)', async () => {
    const file = writeYaml(`
metadata:
  domain: diferidos
  version: "1.0.0"
  created_at: "2026-06-15"
rules:
  - id: R-DIF-004
    type: rule
    summary: regla bien formada
    applicability:
      evento: [alta_diferido]
    source_ref: page
    owner: team
    status: active
    risk_note: si no se cumple, X
    formal_rule:
      action: aprobar
      conditions:
        - field: saldo
          op: gte
          value: 0
`)
    const result = await validateRulesFile({ dbPath, filePath: file, autoRegister: true })
    expect(result.valid).toBe(true)
    expect(result.errors).toEqual([])
    expect(result.warnings.some((w) => w.includes('no tiene "related_objects"'))).toBe(true)
  })
})

describe('validateRulesFile — formal_rule', () => {
  let tmp: string
  let dbPath: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kb-validate-fr-'))
    dbPath = join(tmp, 'kb.db')
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  function writeYaml(body: string): string {
    const file = join(tmp, 'rules.yaml')
    writeFileSync(file, body)
    return file
  }

  it('rejects a rule that omits formal_rule entirely', async () => {
    const file = writeYaml(`
metadata:
  domain: diferidos
  version: "1.0.0"
  created_at: "2026-06-15"
rules:
  - id: R-DIF-100
    type: rule
    summary: sin lógica formal
    applicability:
      evento: [alta]
    source_ref: page
    owner: team
    status: active
    risk_note: nota
`)
    const result = await validateRulesFile({ dbPath, filePath: file, autoRegister: true })
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes('falta "formal_rule"'))).toBe(true)
  })

  it('rejects formal_rule without action', async () => {
    const file = writeYaml(`
metadata:
  domain: diferidos
  version: "1.0.0"
  created_at: "2026-06-15"
rules:
  - id: R-DIF-101
    type: rule
    summary: sin action
    applicability:
      evento: [alta]
    source_ref: page
    owner: team
    status: active
    risk_note: nota
    formal_rule:
      conditions:
        - field: monto
          op: gt
          value: 0
`)
    const result = await validateRulesFile({ dbPath, filePath: file, autoRegister: true })
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes('falta "formal_rule.action"'))).toBe(true)
  })

  it('rejects a condition with an unknown op', async () => {
    const file = writeYaml(`
metadata:
  domain: diferidos
  version: "1.0.0"
  created_at: "2026-06-15"
rules:
  - id: R-DIF-102
    type: rule
    summary: op inválido
    applicability:
      evento: [alta]
    source_ref: page
    owner: team
    status: active
    risk_note: nota
    formal_rule:
      action: aprobar
      conditions:
        - field: saldo
          op: equals
          value: 0
`)
    const result = await validateRulesFile({ dbPath, filePath: file, autoRegister: true })
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes('op "equals" no es válido'))).toBe(true)
  })

  it('rejects a condition missing field / value', async () => {
    const file = writeYaml(`
metadata:
  domain: diferidos
  version: "1.0.0"
  created_at: "2026-06-15"
rules:
  - id: R-DIF-103
    type: rule
    summary: condición incompleta
    applicability:
      evento: [alta]
    source_ref: page
    owner: team
    status: active
    risk_note: nota
    formal_rule:
      action: aprobar
      conditions:
        - op: gt
`)
    const result = await validateRulesFile({ dbPath, filePath: file, autoRegister: true })
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes('falta "field"'))).toBe(true)
    expect(result.errors.some((e) => e.includes('falta "value"'))).toBe(true)
  })

  it('warns when a non-exception rule has empty conditions', async () => {
    const file = writeYaml(`
metadata:
  domain: diferidos
  version: "1.0.0"
  created_at: "2026-06-15"
rules:
  - id: R-DIF-104
    type: rule
    summary: sin condiciones
    applicability:
      evento: [alta]
    source_ref: page
    owner: team
    status: active
    risk_note: nota
    formal_rule:
      action: aprobar
      conditions: []
`)
    const result = await validateRulesFile({ dbPath, filePath: file, autoRegister: true })
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.includes('no es verificable automáticamente'))).toBe(true)
  })

  it('schemaOnly mode: catches formal_rule errors without touching the DB', async () => {
    const file = writeYaml(`
metadata:
  domain: diferidos
  version: "1.0.0"
  created_at: "2026-06-15"
rules:
  - id: R-DIF-200
    type: rule
    summary: op inválido
    applicability:
      evento: [alta]
    source_ref: page
    owner: team
    status: active
    risk_note: nota
    formal_rule:
      action: aprobar
      conditions:
        - field: saldo
          op: equals
          value: 0
`)
    // dbPath deliberately omitted — schemaOnly must not need it.
    const result = await validateRulesFile({ filePath: file, schemaOnly: true })
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes('op "equals" no es válido'))).toBe(true)
  })

  it('schemaOnly mode: accepts a well-formed rule even when related_objects references unknown tables/sps', async () => {
    const file = writeYaml(`
metadata:
  domain: diferidos
  version: "1.0.0"
  created_at: "2026-06-15"
rules:
  - id: R-DIF-201
    type: rule
    summary: bien formada, referencias sin verificar
    applicability:
      evento: [alta]
    source_ref: page
    owner: team
    status: active
    risk_note: nota
    formal_rule:
      action: aprobar
      conditions:
        - field: saldo
          op: gte
          value: 0
    related_objects:
      tables: [tabla_que_no_existe]
      sps: [sp_que_no_existe]
`)
    const result = await validateRulesFile({ filePath: file, schemaOnly: true })
    expect(result.valid).toBe(true)
    // schemaOnly should not emit the "no related_objects" warning either.
    expect(result.warnings.every((w) => !w.includes('related_objects'))).toBe(true)
  })

  it('schemaOnly mode: rejects call without dbPath only when not in schemaOnly', async () => {
    const file = writeYaml(`
metadata:
  domain: diferidos
  version: "1.0.0"
  created_at: "2026-06-15"
rules: []
`)
    await expect(
      validateRulesFile({ filePath: file } as never)
    ).rejects.toThrow(/dbPath is required/)
  })

  it('accepts an exception that omits conditions (inherits from base)', async () => {
    const file = writeYaml(`
metadata:
  domain: diferidos
  version: "1.0.0"
  created_at: "2026-06-15"
rules:
  - id: E-DIF-001
    type: exception
    summary: excepción que hereda condiciones
    applicability:
      evento: [alta]
    source_ref: page
    owner: team
    status: active
    risk_note: nota
    formal_rule:
      action: rechazar
      overrides: R-DIF-001
`)
    const result = await validateRulesFile({ dbPath, filePath: file, autoRegister: true })
    expect(result.valid).toBe(true)
    expect(result.warnings.every((w) => !w.includes('no es verificable automáticamente'))).toBe(true)
  })
})
