/**
 * Validates rule YAML files against the KB — ensures referenced tables/SPs exist.
 *
 * Flow:
 *   1. Parse YAML
 *   2. Schema validation (required fields, ID format)
 *   3. Reference validation (tables/SPs exist in KB)
 *   4. If missing: interactive prompt or auto-register
 *   5. Return structured report
 */
import { readFileSync } from 'node:fs'
import * as readline from 'node:readline'
import yaml from 'js-yaml'
import { Database } from '../db/Database.js'
import { EntityRepo } from '../repos/EntityRepo.js'
import { SearchRepo } from '../repos/SearchRepo.js'
import { runMigrations } from '../db/migrations.js'

// ── Types ───────────────────────────────────────────────────────────────────

interface RuleDoc {
  metadata?: { domain?: string; version?: string; created_at?: string }
  rules?: RuleEntry[]
}

interface RuleEntry {
  id?: string
  type?: string
  summary?: string
  applicability?: { evento?: string }
  source_ref?: string
  owner?: string
  status?: string
  risk_note?: string
  related_objects?: { tables?: string[]; sps?: string[] }
}

interface ValidateResult {
  valid: boolean
  errors: string[]
  warnings: string[]
  stats: {
    totalRules: number
    domain: string
    newObjectsRegistered: number
    referencesRejected: number
  }
}

export interface ValidateOptions {
  dbPath: string
  filePath: string
  autoRegister?: boolean
  /** Optional list of known domains. If omitted, discovers them from DB metadata. */
  knownDomains?: string[]
}

// ── Constants ───────────────────────────────────────────────────────────────

const ID_PATTERN = /^(R|E|G|S)-[A-Z]{2,5}-\d{3,4}$/
const VALID_TYPES = new Set(['rule', 'exception', 'gap', 'sla'])
const REQUIRED_FIELDS = ['id', 'type', 'summary', 'applicability', 'source_ref', 'owner', 'status']

/** Discover known domains from entity metadata in the DB. */
function discoverDomains(db: Database): Set<string> {
  const rows = db.raw.prepare(
    `SELECT DISTINCT json_extract(metadata, '$.domain') as domain FROM entities WHERE domain IS NOT NULL`
  ).all() as { domain: string | null }[]
  return new Set(rows.map(r => r.domain).filter((d): d is string => !!d))
}

// ── Schema validation ───────────────────────────────────────────────────────

function validateSchema(rule: RuleEntry, index: number): string[] {
  const errors: string[] = []
  const label = rule.id || `rules[${index}]`

  for (const field of REQUIRED_FIELDS) {
    if (!(rule as Record<string, unknown>)[field]) {
      errors.push(`${label}: falta campo obligatorio "${field}"`)
    }
  }

  if (rule.id && !ID_PATTERN.test(rule.id)) {
    errors.push(`${label}: ID "${rule.id}" no cumple formato (R|E|G|S)-XXX-NNN`)
  }

  if (rule.type && !VALID_TYPES.has(rule.type)) {
    errors.push(`${label}: type "${rule.type}" no es válido (${[...VALID_TYPES].join(', ')})`)
  }

  if (rule.applicability && !rule.applicability.evento) {
    errors.push(`${label}: applicability.evento es obligatorio`)
  }

  if (!rule.risk_note) {
    errors.push(`${label}: falta "risk_note" — toda regla debe documentar su riesgo`)
  }

  return errors
}

// ── Reference validation ────────────────────────────────────────────────────

function validateReferences(rule: RuleEntry, entityRepo: EntityRepo): { tables: string[]; sps: string[] } {
  const missing = { tables: [] as string[], sps: [] as string[] }
  const tables = rule.related_objects?.tables || []
  const sps = rule.related_objects?.sps || []

  for (const table of tables) {
    const entity = entityRepo.getById(`table:${table}`)
    if (!entity) missing.tables.push(table)
  }

  for (const sp of sps) {
    const entity = entityRepo.getById(`sp:${sp}`)
    if (!entity) missing.sps.push(sp)
  }

  return missing
}

// ── Interactive prompt ──────────────────────────────────────────────────────

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close()
      resolve(answer.trim().toLowerCase())
    })
  })
}

function registerTable(name: string, entityRepo: EntityRepo, searchRepo: SearchRepo, domain: string): void {
  entityRepo.upsert({
    id: `table:${name}`,
    type: 'table',
    name,
    body: 'Tabla nueva registrada durante validación de reglas',
    metadata: { domain, status: 'new' },
  })
  searchRepo.addTerms(`table:${name}`, [name.toLowerCase(), domain])
  process.stderr.write(`  ✅ Registrada tabla "${name}" en la KB\n`)
}

function registerSp(name: string, entityRepo: EntityRepo, searchRepo: SearchRepo, domain: string): void {
  entityRepo.upsert({
    id: `sp:${name}`,
    type: 'stored_procedure',
    name,
    body: 'SP nuevo registrado durante validación de reglas',
    metadata: { domain, status: 'new' },
  })
  searchRepo.addTerms(`sp:${name}`, [name.toLowerCase(), domain])
  process.stderr.write(`  ✅ Registrado SP "${name}" en la KB\n`)
}

async function handleMissing(
  missing: { tables: string[]; sps: string[] },
  rule: RuleEntry,
  entityRepo: EntityRepo,
  searchRepo: SearchRepo,
  autoRegister: boolean,
  domain: string,
): Promise<{ registered: string[]; rejected: string[] }> {
  const registered: string[] = []
  const rejected: string[] = []

  for (const table of missing.tables) {
    if (autoRegister) {
      registerTable(table, entityRepo, searchRepo, domain)
      registered.push(`table:${table}`)
      continue
    }
    const answer = await ask(
      `⚠️  [${rule.id}] La tabla "${table}" no existe en la KB. ¿Es una tabla NUEVA? (s/n): `
    )
    if (answer === 's' || answer === 'si' || answer === 'sí' || answer === 'y') {
      registerTable(table, entityRepo, searchRepo, domain)
      registered.push(`table:${table}`)
    } else {
      rejected.push(`table:${table}`)
    }
  }

  for (const sp of missing.sps) {
    if (autoRegister) {
      registerSp(sp, entityRepo, searchRepo, domain)
      registered.push(`sp:${sp}`)
      continue
    }
    const answer = await ask(
      `⚠️  [${rule.id}] El SP "${sp}" no existe en la KB. ¿Es un SP NUEVO? (s/n): `
    )
    if (answer === 's' || answer === 'si' || answer === 'sí' || answer === 'y') {
      registerSp(sp, entityRepo, searchRepo, domain)
      registered.push(`sp:${sp}`)
    } else {
      rejected.push(`sp:${sp}`)
    }
  }

  return { registered, rejected }
}

// ── Main export ─────────────────────────────────────────────────────────────

export async function validateRulesFile(opts: ValidateOptions): Promise<ValidateResult> {
  const { dbPath, filePath, autoRegister = false, knownDomains } = opts

  const db = new Database({ path: dbPath })
  runMigrations(db)
  const entityRepo = new EntityRepo(db)
  const searchRepo = new SearchRepo(db)

  // Build domain set: explicit list > discovered from DB
  const validDomains = knownDomains
    ? new Set(knownDomains)
    : discoverDomains(db)

  // Parse YAML
  const raw = readFileSync(filePath, 'utf-8')
  let doc: RuleDoc
  try {
    doc = yaml.load(raw) as RuleDoc
  } catch (err: unknown) {
    db.close()
    const msg = err instanceof Error ? err.message : String(err)
    return { valid: false, errors: [`Error parsing YAML: ${msg}`], warnings: [], stats: { totalRules: 0, domain: 'unknown', newObjectsRegistered: 0, referencesRejected: 0 } }
  }

  if (!doc || !doc.rules || !Array.isArray(doc.rules)) {
    db.close()
    return { valid: false, errors: ['El archivo no tiene un array "rules" válido'], warnings: [], stats: { totalRules: 0, domain: 'unknown', newObjectsRegistered: 0, referencesRejected: 0 } }
  }

  const errors: string[] = []
  const warnings: string[] = []
  const domain = doc.metadata?.domain || 'unknown'

  if (!doc.metadata?.domain) {
    errors.push('metadata.domain es obligatorio')
  } else if (validDomains.size > 0 && !validDomains.has(doc.metadata.domain)) {
    warnings.push(`metadata.domain "${doc.metadata.domain}" no está en la lista conocida — ¿dominio nuevo?`)
  }

  if (!doc.metadata?.version) {
    errors.push('metadata.version es obligatorio (formato: X.Y.Z)')
  }

  if (!doc.metadata?.created_at) {
    errors.push('metadata.created_at es obligatorio (formato: YYYY-MM-DD)')
  }

  let totalRegistered = 0
  let totalRejected = 0

  for (let i = 0; i < doc.rules.length; i++) {
    const rule = doc.rules[i]!

    const schemaErrors = validateSchema(rule, i)
    errors.push(...schemaErrors)

    if (rule.related_objects) {
      const missing = validateReferences(rule, entityRepo)
      const hasMissing = missing.tables.length > 0 || missing.sps.length > 0

      if (hasMissing) {
        const { registered, rejected } = await handleMissing(
          missing, rule, entityRepo, searchRepo, autoRegister, domain
        )
        totalRegistered += registered.length
        totalRejected += rejected.length

        for (const r of rejected) {
          errors.push(`${rule.id}: referencia a ${r} no existe en la KB y no fue registrado como nuevo`)
        }
      }
    } else {
      warnings.push(`${rule.id || `rules[${i}]`}: no tiene "related_objects" — la regla no está vinculada a ningún objeto DB`)
    }
  }

  db.close()

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    stats: {
      totalRules: doc.rules.length,
      domain,
      newObjectsRegistered: totalRegistered,
      referencesRejected: totalRejected,
    },
  }
}
