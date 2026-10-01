/**
 * Technical standards per technology — `standards/<technology>/<topic>.yaml`.
 *
 * Kept apart from business rules: a rule says what must happen in the
 * domain, a standard says how code is written in a technology. The format is
 * the same for every content repo, so validation lives here.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import yaml from 'js-yaml'
import type { CheckResult } from './notes.js'

export const STANDARD_ID_PATTERN = /^STD-[A-Z]{2,5}-\d{3,4}$/
export const STANDARD_LEVELS = ['must', 'should', 'may'] as const
export const STANDARD_STATUSES = ['active', 'draft', 'deprecated'] as const
export const STANDARD_REQUIRED = [
  'id',
  'category',
  'summary',
  'level',
  'rationale',
  'owner',
  'status',
] as const

export interface Standard {
  id?: string
  category?: string
  summary?: string
  level?: string
  applies_to?: string[]
  rationale?: string
  good_example?: string
  bad_example?: string
  decision?: string
  owner?: string
  status?: string
  [key: string]: unknown
}

export interface StandardFile {
  file: string
  technology: string | null
  version: string | null
  standards: Standard[]
}

function findYamlFiles(dir: string): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  const results: string[] = []
  for (const entry of entries) {
    if (entry.startsWith('_') || entry.startsWith('.')) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) results.push(...findYamlFiles(full))
    else if (entry.endsWith('.yaml') || entry.endsWith('.yml')) results.push(full)
  }
  return results
}

/** Throws on unparseable YAML so the caller reports it instead of skipping silently. */
export function loadStandards(dir: string): StandardFile[] {
  return findYamlFiles(dir).map((file) => {
    const doc = (yaml.load(readFileSync(file, 'utf-8')) ?? {}) as {
      metadata?: { technology?: string; version?: string }
      standards?: unknown
    }
    return {
      file,
      technology: doc.metadata?.technology ?? null,
      version: doc.metadata?.version ?? null,
      standards: Array.isArray(doc.standards) ? (doc.standards as Standard[]) : [],
    }
  })
}

export function validateStandards(
  files: StandardFile[],
  opts: { knownDecisions?: Set<string> } = {}
): CheckResult {
  const errors: string[] = []
  const seen = new Set<string>()

  for (const { file, technology, standards } of files) {
    if (!technology) errors.push(`${file}: falta metadata.technology`)
    if (standards.length === 0) errors.push(`${file}: no tiene lista "standards"`)
    standards.forEach((std, i) => {
      const label = `${file}: ${std.id ?? `standards[${i}]`}`
      for (const field of STANDARD_REQUIRED) {
        if (!std[field]) errors.push(`${label}: falta campo obligatorio "${field}"`)
      }
      if (std.id) {
        if (!STANDARD_ID_PATTERN.test(std.id)) {
          errors.push(`${label}: ID no cumple formato STD-XXX-NNN`)
        }
        if (seen.has(std.id)) errors.push(`${label}: ID duplicado`)
        seen.add(std.id)
      }
      if (std.level && !(STANDARD_LEVELS as readonly string[]).includes(std.level)) {
        errors.push(`${label}: level "${std.level}" no es válido (${STANDARD_LEVELS.join(', ')})`)
      }
      if (std.status && !(STANDARD_STATUSES as readonly string[]).includes(std.status)) {
        errors.push(
          `${label}: status "${std.status}" no es válido (${STANDARD_STATUSES.join(', ')})`
        )
      }
      if (std.decision && opts.knownDecisions && !opts.knownDecisions.has(std.decision)) {
        errors.push(`${label}: cita ${std.decision} pero no existe`)
      }
    })
  }
  return { errors, warnings: [] }
}
