/**
 * Precedents — `precedentes/<area>/*.yaml`: how something was already solved,
 * so the next implementation follows it instead of inventing a new way.
 *
 * A precedent points (objects, tickets, PRs) instead of copying code: the code
 * moves and a copy goes stale. Its key field is `traza`: `confirmada` means
 * someone read the objects in `verificado_en` and saw the solution there;
 * `posible` means it was matched by text only (e.g. an old ticket with no PR
 * linked) and must be confirmed in the code before anyone follows it.
 */
import { readFileSync } from 'node:fs'
import yaml from 'js-yaml'
import type { CheckResult } from './notes.js'
import { findYamlFiles, layerErrors } from './standards.js'
import { stringListErrors } from './lists.js'
import { OBJECT_ID_PATTERN } from './catalog.js'

export const PRECEDENT_ID_PATTERN = /^P-[A-Z]{2,5}-\d{3,4}$/
export const PRECEDENT_STATUSES = ['active', 'obsolete'] as const
export const TRACE_STATES = ['confirmada', 'posible'] as const
export const PRECEDENT_REQUIRED = [
  'id',
  'titulo',
  'que_se_pidio',
  'como_se_resolvio',
  'capas',
  'traza',
  'status',
] as const

export interface Precedent {
  id?: string
  titulo?: string
  que_se_pidio?: string
  como_se_resolvio?: string
  capas?: string[]
  traza?: string
  /** Objects (`sp:DIVVAL`) where the solution was read in the code. */
  verificado_en?: string[]
  reglas?: string[]
  decision?: string
  /** Tickets, PRs — optional: legacy work often has none. */
  evidencia?: string[]
  fecha?: string
  terminos?: string[]
  status?: string
  [key: string]: unknown
}

export interface PrecedentFile {
  file: string
  area: string | null
  precedents: Precedent[]
}

/** Throws on unparseable YAML so the caller reports it instead of skipping silently. */
export function loadPrecedents(dir: string): PrecedentFile[] {
  return findYamlFiles(dir).map((file) => {
    const doc = (yaml.load(readFileSync(file, 'utf-8'), { schema: yaml.JSON_SCHEMA }) ?? {}) as {
      metadata?: { area?: string }
      precedentes?: unknown
    }
    return {
      file,
      area: doc.metadata?.area ?? null,
      precedents: Array.isArray(doc.precedentes) ? (doc.precedentes as Precedent[]) : [],
    }
  })
}

export function validatePrecedents(
  files: PrecedentFile[],
  opts: { knownDecisions?: Set<string>; layers?: readonly string[] } = {}
): CheckResult {
  const errors: string[] = []
  const warnings: string[] = []
  const seen = new Set<string>()

  for (const { file, area, precedents } of files) {
    if (!area) errors.push(`${file}: falta metadata.area`)
    if (precedents.length === 0) errors.push(`${file}: no tiene lista "precedentes"`)
    precedents.forEach((p, i) => {
      const label = `${file}: ${p.id ?? `precedentes[${i}]`}`
      for (const field of PRECEDENT_REQUIRED) {
        if (!p[field]) errors.push(`${label}: falta campo obligatorio "${field}"`)
      }
      if (p.id) {
        if (!PRECEDENT_ID_PATTERN.test(p.id)) {
          errors.push(`${label}: ID no cumple formato P-XXX-NNN`)
        }
        if (seen.has(p.id)) errors.push(`${label}: ID duplicado`)
        seen.add(p.id)
      }
      if (p.status && !(PRECEDENT_STATUSES as readonly string[]).includes(p.status)) {
        errors.push(
          `${label}: status "${p.status}" no es válido (${PRECEDENT_STATUSES.join(', ')})`
        )
      }
      for (const field of ['capas', 'verificado_en', 'reglas', 'evidencia', 'terminos'] as const) {
        errors.push(...stringListErrors(p[field], label, field))
      }
      if (Array.isArray(p.capas)) {
        if (p.capas.length === 0) errors.push(`${label}: "capas" está vacía`)
        for (const capa of p.capas) {
          if (typeof capa === 'string') errors.push(...layerErrors(capa, opts.layers, label))
        }
      }
      for (const obj of Array.isArray(p.verificado_en) ? p.verificado_en : []) {
        if (typeof obj === 'string' && !OBJECT_ID_PATTERN.test(obj)) {
          errors.push(`${label}: verificado_en "${obj}" debe ser <tipo>:<nombre> (sp:DIVVAL…)`)
        }
      }
      if (p.traza) {
        if (!(TRACE_STATES as readonly string[]).includes(p.traza)) {
          errors.push(`${label}: traza "${p.traza}" no es válida (${TRACE_STATES.join(', ')})`)
        } else if (p.traza === 'confirmada' && !p.verificado_en?.length) {
          errors.push(
            `${label}: traza confirmada sin "verificado_en" — di en qué objeto se leyó la solución`
          )
        } else if (p.traza === 'posible') {
          warnings.push(`${label}: traza posible — confirmarla en el código antes de seguirla`)
        }
      }
      if (p.decision && opts.knownDecisions && !opts.knownDecisions.has(p.decision)) {
        errors.push(`${label}: cita ${p.decision} pero no existe`)
      }
    })
  }
  return { errors, warnings }
}
