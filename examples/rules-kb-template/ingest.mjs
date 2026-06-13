/**
 * Rules KB ingestion plugin — starter template.
 *
 * Copy this folder into your project's `tools/kb-ingest/`, then adapt the
 * pieces marked with `[PROJECT]` comments. The defaults work for projects
 * whose canonical sources are markdown files with YAML-ish frontmatter.
 *
 * Default taxonomy:
 *   Entity types:    rule | decision | term
 *   Relations:       cites | defines | supersedes
 *
 * Frontmatter contract:
 *
 *   ---
 *   id: rule:tasa-interes           # REQUIRED, stable ID
 *   type: rule                       # rule | decision | term
 *   name: Tasa de interés ordinaria  # REQUIRED, display name
 *   terms: [tasa, interés]           # OPTIONAL, keyword index entries
 *   status: active                   # OPTIONAL, free-form (active/deprecated/draft)
 *   owner: producto                  # OPTIONAL, team owner
 *
 *   # Relations — arrays of target IDs
 *   cites: [rule:plazos, decision:adr-0001]
 *   defines: [tasa-ordinaria]
 *   supersedes: rule:tasa-vieja
 *   ---
 *
 *   <markdown body — this becomes the entity body and is FTS-indexed>
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// ─────────────────────────────────────────────────────────────────────────────
// [PROJECT] Adjust if your taxonomy differs.
//
// VALID_TYPES gates the values of `type:` in frontmatter. The plugin REJECTS
// files whose type is outside the allowlist. Add your project-specific types
// here (e.g. 'feature', 'policy', 'invariant') if they apply.
const VALID_TYPES = new Set(['rule', 'decision', 'term'])

// EDGE_RELATIONS maps frontmatter keys to graph relations. Each key becomes an
// outgoing edge from the current entity to every ID listed in its value.
// Format: { frontmatter_key: relation_name }
// Add or remove rows to fit your domain (e.g. 'applies_to', 'mitigates').
const EDGE_RELATIONS = {
  cites: 'cites',
  defines: 'defines',
  supersedes: 'supersedes',
}
// ─────────────────────────────────────────────────────────────────────────────

function walk(dir) {
  const results = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      results.push(...walk(full))
    } else if (entry.endsWith('.md')) {
      results.push(full)
    }
  }
  return results
}

/**
 * Minimal YAML subset parser. Handles:
 *   key: scalar
 *   key: [a, b, c]
 *   key: single-id (treated as 1-element list for EDGE_RELATIONS keys)
 *
 * Does NOT handle nested objects or block-scalar (|). Swap for `gray-matter`
 * or `js-yaml` if your frontmatter uses richer YAML.
 */
function parseFrontmatter(source) {
  const match = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/.exec(source)
  if (!match) {
    return { frontmatter: {}, body: source }
  }
  const [, raw, body] = match
  const frontmatter = {}
  for (const line of raw.split(/\r?\n/)) {
    const kv = /^([\w.-]+):\s*(.*)$/.exec(line)
    if (!kv) continue
    const [, key, rawValue] = kv
    const v = rawValue.trim()
    if (v === '') {
      frontmatter[key] = ''
      continue
    }
    if (v.startsWith('[') && v.endsWith(']')) {
      frontmatter[key] = v
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean)
    } else {
      frontmatter[key] = v.replace(/^["']|["']$/g, '')
    }
  }
  return { frontmatter, body: body.trim() }
}

/**
 * Coerce a possibly-scalar field into an array. Edge relations may be
 * declared as either `supersedes: rule:foo` or `supersedes: [rule:foo, rule:bar]`
 * — we accept both for ergonomics.
 */
function asArray(v) {
  if (v === undefined || v === null || v === '') return []
  if (Array.isArray(v)) return v
  return [String(v)]
}

export default {
  name: 'rules-kb-template',
  description:
    'Starter ingestion: walks docs/**/*.md, parses frontmatter, emits rule/decision/term entities + cites/defines/supersedes edges.',

  async run(ctx) {
    // [PROJECT] Default root: <plugin-dir>/docs. Override from the CLI with
    //   kb-ingest ingest --db ./kb.db --plugin ./ingest.mjs --opt root=/abs/path
    // Useful when your docs live elsewhere in the repo.
    const root = ctx.options.root
      ? String(ctx.options.root)
      : join(fileURLToPath(new URL('.', import.meta.url)), 'docs')

    ctx.log(`scanning ${root}`)

    const files = walk(root)
    const entities = []
    const edges = []
    const termsByEntity = new Map()
    const rejected = []

    for (const file of files) {
      const source = readFileSync(file, 'utf-8')
      const { frontmatter, body } = parseFrontmatter(source)

      const id = frontmatter.id
      if (!id) {
        rejected.push({ file, reason: 'missing id in frontmatter' })
        continue
      }
      const type = frontmatter.type
      if (!type || !VALID_TYPES.has(type)) {
        rejected.push({
          file,
          reason: `invalid type "${String(type)}" (valid: ${[...VALID_TYPES].join(', ')})`,
        })
        continue
      }
      const name = frontmatter.name ?? id

      // Everything not consumed structurally goes into metadata so queries can
      // filter on it (e.g. `WHERE json_extract(metadata, '$.status') = 'active'`).
      const reserved = new Set(['id', 'type', 'name', 'terms', ...Object.keys(EDGE_RELATIONS)])
      const metadata = {}
      for (const k of Object.keys(frontmatter)) {
        if (!reserved.has(k)) metadata[k] = frontmatter[k]
      }

      entities.push({ id, type, name, body, metadata, sourcePath: file })

      const terms = asArray(frontmatter.terms)
      if (terms.length > 0) termsByEntity.set(id, terms)

      for (const [fmKey, relation] of Object.entries(EDGE_RELATIONS)) {
        for (const target of asArray(frontmatter[fmKey])) {
          edges.push({ src: id, dst: target, relation })
        }
      }
    }

    // Two-pass write: entities first so edges have valid endpoints. Edges
    // referencing unknown IDs are dropped with a warning rather than crashing
    // the ingest — this lets you migrate in pieces.
    ctx.entities.upsertMany(entities)

    const known = new Set(entities.map((e) => e.id))
    const droppedEdges = []
    const liveEdges = []
    for (const edge of edges) {
      if (!known.has(edge.dst) && !ctx.entities.getById(edge.dst)) {
        droppedEdges.push(edge)
      } else {
        liveEdges.push(edge)
      }
    }
    ctx.edges.upsertMany(liveEdges)

    for (const [id, terms] of termsByEntity) {
      ctx.search.clearTerms(id) // re-ingest cleanly so removed terms disappear
      ctx.search.addTerms(id, terms)
    }

    ctx.log(
      `loaded ${entities.length} entities, ${liveEdges.length} edges, ${termsByEntity.size} term sets`
    )
    if (rejected.length > 0) {
      ctx.log(`rejected ${rejected.length} file(s):`)
      for (const r of rejected) ctx.log(`  - ${r.file}: ${r.reason}`)
    }
    if (droppedEdges.length > 0) {
      ctx.log(`dropped ${droppedEdges.length} edge(s) pointing to unknown entities:`)
      for (const e of droppedEdges) ctx.log(`  - ${e.src} --${e.relation}--> ${e.dst}`)
    }
  },
}
