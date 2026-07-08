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

interface FormalRuleCondition {
  field?: unknown
  op?: unknown
  value?: unknown
}

interface FormalRule {
  action?: unknown
  conditions?: unknown
  overrides?: unknown
}

interface RuleEntry {
  id?: string
  type?: string
  summary?: string
  applicability?: { evento?: string[]; actor?: string[] }
  source_ref?: string
  owner?: string
  status?: string
  risk_note?: string
  related_objects?: { tables?: string[]; sps?: string[] }
  formal_rule?: FormalRule
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
  /** Path to the SQLite KB. Required unless `schemaOnly` is true. */
  dbPath?: string
  filePath: string
  autoRegister?: boolean
  /**
   * Skip everything that needs the DB: reference checks against `table:*`/`sp:*`
   * entities and domain discovery. Intended for pre-commit hooks that can run
   * on a fresh clone without a KB built.
   */
  schemaOnly?: boolean
  /** Optional list of known domains. If omitted, discovers them from DB metadata. */
  knownDomains?: string[]
}

// ── Constants ───────────────────────────────────────────────────────────────

const ID_PATTERN = /^(R|E|G|S)-[A-Z]{2,5}-\d{3,4}$/
const VALID_TYPES = new Set(['rule', 'exception', 'gap', 'sla'])
const VALID_STATUSES = new Set(['active', 'deprecated', 'draft'])
const REQUIRED_FIELDS = ['id', 'type', 'summary', 'applicability', 'source_ref', 'owner', 'status']
// Starter operator set for formal_rule.conditions[].op. Extend as new comparison
// styles show up in rule YAMLs (e.g. "between", "regex"). Enforcing an enum
// catches typos ("equals" vs "eq") that would silently pass otherwise.
const VALID_OPS = new Set([
  'eq', 'neq', 'gt', 'gte', 'lt', 'lte',
  'in', 'not_in',
  'exists', 'not_exists',
  'matches',
])

// ID prefix must match type — a rule R-* labelled type: exception is almost
// always a copy-paste mistake. The spec ties the prefix to the type explicitly.
const PREFIX_TO_TYPE: Record<string, string> = {
  R: 'rule',
  E: 'exception',
  G: 'gap',
  S: 'sla',
}

/** Discover known domains from entity metadata in the DB. */
function discoverDomains(db: Database): Set<string> {
  const rows = db.raw.prepare(
    `SELECT DISTINCT json_extract(metadata, '$.domain') as domain FROM entities WHERE json_extract(metadata, '$.domain') IS NOT NULL`
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

  if (rule.id && rule.type && ID_PATTERN.test(rule.id)) {
    const prefix = rule.id.charAt(0)
    const expectedType = PREFIX_TO_TYPE[prefix]
    if (expectedType && rule.type !== expectedType) {
      errors.push(
        `${label}: ID prefix "${prefix}-" implica type="${expectedType}" pero se declaró type="${rule.type}"`
      )
    }
  }

  if (rule.status && !VALID_STATUSES.has(rule.status)) {
    errors.push(
      `${label}: status "${rule.status}" no es válido (${[...VALID_STATUSES].join(', ')})`
    )
  }

  if (rule.applicability) {
    const evento = rule.applicability.evento
    if (!Array.isArray(evento) || evento.length === 0) {
      errors.push(`${label}: applicability.evento debe ser un array no vacío`)
    }
  }

  if (!rule.risk_note) {
    errors.push(`${label}: falta "risk_note" — toda regla debe documentar su riesgo`)
  }

  return errors
}

// ── Formal rule validation ──────────────────────────────────────────────────

// formal_rule is what makes a rule auditable against code. Without action +
// well-formed conditions there is nothing structured for a downstream auditor
// (LLM or otherwise) to compare against the SP body.
function validateFormalRule(rule: RuleEntry, index: number): { errors: string[]; warnings: string[] } {
  const errors: string[] = []
  const warnings: string[] = []
  const label = rule.id || `rules[${index}]`
  const fr = rule.formal_rule

  if (!fr || typeof fr !== 'object') {
    errors.push(`${label}: falta "formal_rule" — toda regla debe declarar su lógica (action + conditions)`)
    return { errors, warnings }
  }

  if (typeof fr.action !== 'string' || fr.action.trim() === '') {
    errors.push(`${label}: falta "formal_rule.action" (string no vacío)`)
  }

  if (fr.conditions === undefined) {
    // Exceptions with `overrides` inherit the base rule's conditions, so it's
    // legitimate for them to omit their own. For everything else, no conditions
    // means the rule can't be auto-verified — warn but don't fail.
    if (rule.type !== 'exception') {
      warnings.push(`${label}: no tiene "formal_rule.conditions" — la regla no es verificable automáticamente`)
    }
  } else if (!Array.isArray(fr.conditions)) {
    errors.push(`${label}: "formal_rule.conditions" debe ser un array`)
  } else {
    if (fr.conditions.length === 0 && rule.type !== 'exception') {
      warnings.push(`${label}: "formal_rule.conditions" está vacío — la regla no es verificable automáticamente`)
    }
    for (let j = 0; j < fr.conditions.length; j++) {
      const c = fr.conditions[j] as FormalRuleCondition
      const cLabel = `${label}.formal_rule.conditions[${j}]`
      if (typeof c.field !== 'string' || c.field.trim() === '') {
        errors.push(`${cLabel}: falta "field" (string no vacío)`)
      }
      if (typeof c.op !== 'string' || c.op.trim() === '') {
        errors.push(`${cLabel}: falta "op" (string no vacío)`)
      } else if (!VALID_OPS.has(c.op)) {
        errors.push(`${cLabel}: op "${c.op}" no es válido (${[...VALID_OPS].join(', ')})`)
      }
      if (c.value === undefined) {
        errors.push(`${cLabel}: falta "value"`)
      }
    }
  }

  return { errors, warnings }
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
  const { dbPath, filePath, autoRegister = false, schemaOnly = false, knownDomains } = opts

  if (!schemaOnly && !dbPath) {
    throw new Error('validateRulesFile: dbPath is required unless schemaOnly is true')
  }

  // schemaOnly runs without opening the DB — the pre-commit path can execute
  // on a fresh clone with no KB built. Reference/domain checks are only
  // available with a DB, so they're skipped in that mode.
  const db = schemaOnly ? null : new Database({ path: dbPath! })
  if (db) runMigrations(db)
  const entityRepo = db ? new EntityRepo(db) : null
  const searchRepo = db ? new SearchRepo(db) : null

  const validDomains = knownDomains
    ? new Set(knownDomains)
    : db
    ? discoverDomains(db)
    : new Set<string>()

  // Parse YAML
  const raw = readFileSync(filePath, 'utf-8')
  let doc: RuleDoc
  try {
    doc = yaml.load(raw) as RuleDoc
  } catch (err: unknown) {
    if (db) db.close()
    const msg = err instanceof Error ? err.message : String(err)
    return { valid: false, errors: [`Error parsing YAML: ${msg}`], warnings: [], stats: { totalRules: 0, domain: 'unknown', newObjectsRegistered: 0, referencesRejected: 0 } }
  }

  if (!doc || !doc.rules || !Array.isArray(doc.rules)) {
    if (db) db.close()
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

    const formal = validateFormalRule(rule, i)
    errors.push(...formal.errors)
    warnings.push(...formal.warnings)

    if (schemaOnly) {
      // Skip reference / handleMissing entirely. Schema-only cannot validate
      // that referenced tables/SPs exist in the KB, so we don't emit the
      // "no related_objects" warning either — it would be noise at commit time.
    } else if (rule.related_objects) {
      const missing = validateReferences(rule, entityRepo!)
      const hasMissing = missing.tables.length > 0 || missing.sps.length > 0

      if (hasMissing) {
        const { registered, rejected } = await handleMissing(
          missing, rule, entityRepo!, searchRepo!, autoRegister, domain
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

  if (db) db.close()

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
