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
`)
    const result = await validateRulesFile({ dbPath, filePath: file, autoRegister: true })
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes('applicability.evento debe ser un array'))).toBe(true)
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
`)
    const result = await validateRulesFile({ dbPath, filePath: file, autoRegister: true })
    expect(result.valid).toBe(true)
    expect(result.errors).toEqual([])
    expect(result.warnings.some((w) => w.includes('no tiene "related_objects"'))).toBe(true)
  })
})
