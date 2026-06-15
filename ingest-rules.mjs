/**
 * Ingestion plugin — Generic YAML Rules
 *
 * Lee todos los YAML de reglas de negocio en un directorio (recursivo)
 * y los carga como entidades + aristas + terms en la KB.
 *
 * Taxonomía:
 *   Entity types: rule | exception | gap | sla
 *   Relations:    overrides | uses_table | uses_sp
 *
 * Uso:
 *   kb-ingest ingest --db ./kb.db --plugin ./ingest-rules.mjs --opt root=/path/to/rules
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'

// ── Config ──────────────────────────────────────────────────────────────────
const DEFAULT_RULES_DIR = join(fileURLToPath(import.meta.url), '..', 'rules')

// ── Helpers ─────────────────────────────────────────────────────────────────
function findYamlFiles(dir) {
  const results = []
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return results
  }
  for (const entry of entries) {
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      results.push(...findYamlFiles(full))
    } else if (entry.endsWith('.yaml') || entry.endsWith('.yml')) {
      results.push(full)
    }
  }
  return results
}

/**
 * Build a text body for full-text search from a rule object.
 */
function buildBody(rule) {
  const parts = [rule.summary || '']
  if (rule.risk_note) parts.push(`Riesgo: ${rule.risk_note}`)
  if (rule.formal_rule?.action) parts.push(`Acción: ${rule.formal_rule.action}`)
  if (rule.formal_rule?.conditions) {
    for (const c of rule.formal_rule.conditions) {
      parts.push(`${c.field} ${c.op} ${JSON.stringify(c.value)}`)
    }
  }
  if (rule.source_ref) parts.push(`Fuente: ${rule.source_ref}`)
  return parts.join('\n')
}

/**
 * Extract search terms from a rule.
 */
function extractTerms(rule, domain) {
  const terms = new Set()
  terms.add(domain)
  if (rule.subdomain) terms.add(rule.subdomain)
  if (rule.id) terms.add(rule.id.toLowerCase())

  // Events as terms
  const eventos = rule.applicability?.evento || []
  for (const e of eventos) terms.add(e)

  // Related tables/SPs as terms
  const tables = rule.related_objects?.tables || []
  const sps = rule.related_objects?.sps || []
  for (const t of tables) terms.add(t.toLowerCase())
  for (const sp of sps) terms.add(sp.toLowerCase())

  // Key words from summary
  const keywords = (rule.summary || '')
    .toLowerCase()
    .split(/[\s—,;:()]+/)
    .filter(w => w.length > 4)
  for (const kw of keywords) terms.add(kw)

  return [...terms].filter(Boolean)
}

export default {
  name: 'yaml-rules',
  description: 'Ingesta genérica de reglas de negocio desde archivos YAML (requiere --opt root=<dir>)',

  async run(ctx) {
    const rootDir = ctx.options?.root || DEFAULT_RULES_DIR
    if (!ctx.options?.root) {
      process.stderr.write('[ingest-rules] WARN: no --opt root=<dir> provided, using default\n')
    }
    const files = findYamlFiles(rootDir)

    let totalRules = 0
    let totalEdges = 0

    for (const file of files) {
      const raw = readFileSync(file, 'utf-8')
      let doc
      try {
        doc = yaml.load(raw)
      } catch (err) {
        process.stderr.write(`[ingest-rules] WARN: failed to parse ${file}: ${err.message}\n`)
        continue
      }

      if (!doc || !doc.rules || !Array.isArray(doc.rules)) {
        process.stderr.write(`[ingest-rules] SKIP: no rules array in ${file}\n`)
        continue
      }

      const domain = doc.metadata?.domain || basename(file, '.yaml').replace('seed-', '').replace('-rules', '')

      for (const rule of doc.rules) {
        if (!rule.id) continue

        const entityId = `${rule.type || 'rule'}:${rule.id}`
        const body = buildBody(rule)

        // Upsert entity
        ctx.entities.upsert({
          id: entityId,
          type: rule.type || 'rule',
          name: `[${rule.id}] ${rule.summary || 'Sin resumen'}`,
          body,
          metadata: {
            domain,
            subdomain: rule.subdomain || null,
            status: rule.status || 'active',
            owner: rule.owner || null,
            riskNote: rule.risk_note || null,
            eventos: rule.applicability?.evento || [],
            actors: rule.applicability?.actor || [],
            relatedTables: rule.related_objects?.tables || [],
            relatedSps: rule.related_objects?.sps || [],
            sourceRef: rule.source_ref || null,
          },
          sourcePath: file,
        })
        totalRules++

        // Add search terms
        const terms = extractTerms(rule, domain)
        ctx.search.addTerms(entityId, terms)

        // Edges: exception overrides rule
        if (rule.type === 'exception' && rule.formal_rule?.overrides) {
          const targetId = `rule:${rule.formal_rule.overrides}`
          ctx.edges.upsert({
            src: entityId,
            dst: targetId,
            relation: 'overrides',
          })
          totalEdges++
        }

        // Edges: related tables
        for (const table of (rule.related_objects?.tables || [])) {
          const tableId = `table:${table}`
          // Ensure table entity exists
          ctx.entities.upsert({
            id: tableId,
            type: 'table',
            name: table,
            body: `Tabla Sybase: ${table}`,
            metadata: { domain },
          })
          ctx.edges.upsert({ src: entityId, dst: tableId, relation: 'uses_table' })
          totalEdges++
        }

        // Edges: related SPs
        for (const sp of (rule.related_objects?.sps || [])) {
          const spId = `sp:${sp}`
          ctx.entities.upsert({
            id: spId,
            type: 'stored_procedure',
            name: sp,
            body: `Stored Procedure Sybase: ${sp}`,
            metadata: { domain },
          })
          ctx.edges.upsert({ src: entityId, dst: spId, relation: 'uses_sp' })
          totalEdges++
        }
      }
    }

    process.stderr.write(`[ingest-rules] ingested ${totalRules} rules, ${totalEdges} edges from ${files.length} files\n`)
  },
}
