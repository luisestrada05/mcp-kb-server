import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadStandards, validateStandards } from '../../../src/content/standards.js'

const VALID = `
metadata:
  technology: sybase
  version: "0.1.0"
standards:
  - id: STD-SYB-001
    category: naming
    summary: Prefijo de módulo en SPs
    level: must
    rationale: heredado, sin documentar
    owner: equipo
    status: active
`

describe('content/standards', () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kb-standards-'))
    mkdirSync(join(tmp, 'sybase'))
    mkdirSync(join(tmp, '_plantillas'))
    writeFileSync(join(tmp, '_plantillas', 'standard.yaml'), 'standards: [{ id: nope }]')
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('loads per-technology files and skips templates', () => {
    writeFileSync(join(tmp, 'sybase', 'naming.yaml'), VALID)
    const files = loadStandards(tmp)
    expect(files).toHaveLength(1)
    expect(files[0]?.technology).toBe('sybase')
    expect(validateStandards(files).errors).toEqual([])
  })

  it('reports format, enum, duplicate and dangling decision errors', () => {
    writeFileSync(
      join(tmp, 'sybase', 'naming.yaml'),
      VALID +
        `  - id: STD-SYB-001
    category: naming
    summary: duplicado
    level: obligatorio
    rationale: x
    owner: equipo
    status: vigente
    decision: DEC-SYB-404
  - id: STD-SYB-1
    summary: incompleto
`
    )
    const { errors } = validateStandards(loadStandards(tmp), { knownDecisions: new Set() })
    const all = errors.join('\n')
    expect(all).toMatch(/ID duplicado/)
    expect(all).toMatch(/level "obligatorio"/)
    expect(all).toMatch(/status "vigente"/)
    expect(all).toMatch(/cita DEC-SYB-404/)
    expect(all).toMatch(/STD-SYB-1: ID no cumple/)
    expect(all).toMatch(/STD-SYB-1: falta campo obligatorio "level"/)
  })
})
