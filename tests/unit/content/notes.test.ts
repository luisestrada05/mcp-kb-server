import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseNote,
  loadNotes,
  pickSection,
  validateNotes,
  findDanglingDecisionRefs,
  type NoteRules,
} from '../../../src/content/notes.js'

const DEC_RULES: NoteRules = {
  idPattern: /^DEC-[A-Z]{2,5}-\d{3,4}$/,
  statuses: ['proposed', 'accepted', 'superseded'],
  requiredSections: ['intencion', 'no significa'],
  supersededStatus: 'superseded',
  pendingMarker: 'POR COMPLETAR',
}

const DEC_NOTE = `---
id: DEC-DIF-001
status: proposed
---
# DEC-DIF-001 — Validación previa

## Intención

Que nada inconsistente llegue al cobro.

## No significa

- ❌ Que aplique a pre-aprobados
- ⚠️ POR COMPLETAR: timeout
`

describe('content/notes', () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kb-notes-'))
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  function write(name: string, body: string): string {
    const file = join(tmp, name)
    writeFileSync(file, body)
    return file
  }

  it('parses frontmatter, title and sections keyed without accents', () => {
    const note = parseNote(write('DEC-DIF-001.md', DEC_NOTE))
    expect(note.id).toBe('DEC-DIF-001')
    expect(note.title).toBe('DEC-DIF-001 — Validación previa')
    expect(note.sections['intencion']?.heading).toBe('Intención')
    expect(note.sections['no significa']?.items).toEqual([
      '❌ Que aplique a pre-aprobados',
      '⚠️ POR COMPLETAR: timeout',
    ])
  })

  it('pickSection returns the first variant present', () => {
    const note = parseNote(
      write('ADR-001.md', '---\nid: ADR-001\n---\n## Alternativa descartada\n\nX\n')
    )
    expect(pickSection(note, 'Alternativas descartadas', 'Alternativa descartada')?.text).toBe('X')
    expect(pickSection(note, 'Consecuencias')).toBeNull()
  })

  it('loadNotes skips templates, notes without id, and filtered notes', () => {
    write('DEC-DIF-001.md', DEC_NOTE)
    write('Índice.md', '---\ntipo: indice\n---\n# Índice\n')
    mkdirSync(join(tmp, '_plantillas'))
    write('_plantillas/decision.md', '---\nid: DEC-XXX-NNN\n---\n')
    write('DEC-DIF-002.md', '---\nid: DEC-DIF-002\ntipo: borrador\n---\n')

    const notes = loadNotes(tmp, { filter: (n) => n.frontmatter.tipo !== 'borrador' })
    expect([...notes.keys()]).toEqual(['DEC-DIF-001'])
  })

  it('validates a well-formed note, warning on pending markers', () => {
    write('DEC-DIF-001.md', DEC_NOTE)
    const result = validateNotes(loadNotes(tmp), DEC_RULES)
    expect(result.errors).toEqual([])
    expect(result.warnings).toHaveLength(1)
  })

  it('accepts a file name that starts with the id (ADR style)', () => {
    write('ADR-001 — Append-only por trigger.md', '---\nid: ADR-001\nestado: aceptada\n---\n')
    const result = validateNotes(loadNotes(tmp), {
      idPattern: /^ADR-\d{3}$/,
      statuses: ['aceptada'],
      statusField: 'estado',
      requiredSections: [],
    })
    expect(result.errors).toEqual([])
  })

  it('reports bad id, wrong file name, bad status, missing sections and dangling successor', () => {
    write(
      'otra-cosa.md',
      '---\nid: DEC-1\nstatus: superseded\nsuperseded_by: DEC-DIF-404\n---\n## Intención\n\nx\n'
    )
    const { errors } = validateNotes(loadNotes(tmp), DEC_RULES)
    expect(errors.join('\n')).toMatch(/no cumple el formato/)
    expect(errors.join('\n')).toMatch(/debe empezar con DEC-1/)
    expect(errors.join('\n')).toMatch(/requiere superseded_by/)
    expect(errors.join('\n')).toMatch(/"no significa"/)
  })

  it('findDanglingDecisionRefs flags rules citing unknown notes', () => {
    const rules = write(
      'rules.yaml',
      'rules:\n  - id: R-DIF-001\n    decision: DEC-DIF-001\n  - id: R-DIF-002\n    decision: DEC-DIF-999\n'
    )
    expect(findDanglingDecisionRefs([rules], new Set(['DEC-DIF-001']))).toEqual([
      `${rules}: R-DIF-002 cita DEC-DIF-999 pero no existe`,
    ])
  })
})
