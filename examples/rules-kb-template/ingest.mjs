/**
 * Rules + Tech KB ingestion plugin — starter template.
 *
 * Two source roots, each serving a DevFlow phase:
 *
 *   docs/**\/*.md       (narrative)  — rules, decisions, glossary terms.
 *                                       Used by /devflow:specify to ground
 *                                       the spec in business reality.
 *   manifests/**\/*.json (declarative) — components, endpoints, modules,
 *                                        services. Used by /devflow:plan to
 *                                        identify "where the change lives."
 *
 * Both stream into the SAME graph, so cross-domain edges (e.g. component
 * `implements` rule, endpoint `applies` rule) connect "what we must respect"
 * (specify) with "where we touch it" (plan).
 *
 * Copy this folder into your project's `tools/kb-ingest/`, then adapt the
 * pieces marked with `[PROJECT]`. The defaults are dependency-free.
 *
 * Default taxonomy:
 *   Entity types:    rule | decision | term | component | endpoint | module | service
 *   Relations:       cites | defines | supersedes
 *                    implements | applies | exposes | consumes
 *                    depends_on | tested_by
 *
 * Markdown frontmatter contract (for docs/):
 *
 *   ---
 *   id: rule:tasa-interes           # REQUIRED, stable ID
 *   type: rule                       # rule | decision | term
 *   name: Tasa de interés ordinaria  # REQUIRED, display name
 *   terms: [tasa, interés]           # OPTIONAL, keyword index entries
 *   status: active                   # OPTIONAL, free-form
 *   cites: [rule:plazos]             # OPTIONAL, edge targets
 *   ---
 *   <markdown body — FTS-indexed>
 *
 * JSON manifest contract (for manifests/): array of objects. Each object is
 * an entity. Edge-relation keys behave the same as in frontmatter.
 *
 *   [
 *     {
 *       "id": "component:FormSelectField",
 *       "type": "component",
 *       "name": "FormSelectField",
 *       "path": "src/shared/components/app/form-select-field.tsx",
 *       "body": "Wrapper de Select integrado con React Hook Form.",
 *       "terms": ["select", "form"],
 *       "implements": ["rule:reuso-shadcn-form"]
 *     }
 *   ]
 *
 * Why JSON manifests instead of YAML: keeps the template dep-free. Swap in
 * `js-yaml` or `gray-matter` once your manifests outgrow JSON's ergonomics.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// ─────────────────────────────────────────────────────────────────────────────
// [PROJECT] Adjust if your taxonomy differs.
//
// VALID_TYPES gates the values of `type:` in any source. The plugin REJECTS
// entries whose type is outside the allowlist. Group conceptually:
//
//   Narrative (typically from docs/*.md, used by /devflow:specify):
//     - rule       business / regulatory / operational rule
//     - decision   ADR-style decision with context + consequences
//     - term       canonical definition (glossary entry)
//
//   Technical (typically from manifests/*.json, used by /devflow:plan):
//     - component  UI / library component a feature reuses
//     - endpoint   HTTP route exposed by the BFF or external API
//     - module     top-level domain module (modules/credits, modules/auth)
//     - service    callable service / domain function with a contract
//
// Add or remove freely. Each new type is just a string — no code change
// elsewhere is required.
const VALID_TYPES = new Set([
  'rule',
  'decision',
  'term',
  'component',
  'endpoint',
  'module',
  'service',
])

// EDGE_RELATIONS maps a frontmatter/manifest key to a graph relation. Each
// key becomes an outgoing edge from the current entity to every ID in its
// value. Format: { source_key: relation_name }
//
// Conceptual groups:
//   Narrative-only:
//     cites        I reference this in my body
//     defines      I authoritatively define this term
//     supersedes   I replace this older entity
//
//   Cross-domain (bridge narrative ↔ technical — high-value for DevFlow):
//     implements   component/service IMPLEMENTS a rule
//     applies      endpoint APPLIES a rule when handling a request
//     tested_by    entity is verified by another entity (typically a test
//                  spec file or scenario doc)
//
//   Technical-only:
//     exposes      module EXPOSES a public endpoint or service
//     consumes     entity CONSUMES (calls) another endpoint/service
//     depends_on   generic dependency (use sparingly — prefer specific
//                  relations above when applicable)
const EDGE_RELATIONS = {
  // narrative
  cites: 'cites',
  defines: 'defines',
  supersedes: 'supersedes',
  // cross-domain (rule ↔ technical)
  implements: 'implements',
  applies: 'applies',
  tested_by: 'tested_by',
  // technical
  exposes: 'exposes',
  consumes: 'consumes',
  depends_on: 'depends_on',
}
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Recursive walk that filters by extension. Silently returns [] for a missing
 * directory so the plugin works in projects that only populate `docs/` or
 * only `manifests/`.
 */
function walk(dir, extension) {
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
      results.push(...walk(full, extension))
    } else if (entry.endsWith(extension)) {
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

/**
 * Yield normalized entries (one per entity to be ingested) from `root`.
 *
 * Pulls from TWO source layouts:
 *   <root>/docs/**\/*.md         — markdown + frontmatter (narrative entities)
 *   <root>/manifests/**\/*.json  — array-of-objects per file (declarative entities)
 *
 * Each yielded entry is shape-compatible regardless of source:
 *   { id, type, name, body, terms, <edge_keys>, <metadata_keys>, sourcePath }
 *
 * Missing source roots are silently skipped so a project that only uses one
 * layout doesn't need to create empty directories.
 */
function* loadEntries(root) {
  // Markdown sources — body is the markdown body, fields come from frontmatter.
  for (const file of walk(join(root, 'docs'), '.md')) {
    const { frontmatter, body } = parseFrontmatter(readFileSync(file, 'utf-8'))
    yield { ...frontmatter, body, sourcePath: file, _source: 'docs' }
  }
  // Manifest sources — each JSON file is an array of entity objects.
  for (const file of walk(join(root, 'manifests'), '.json')) {
    let parsed
    try {
      parsed = JSON.parse(readFileSync(file, 'utf-8'))
    } catch (err) {
      yield { _parseError: String(err), sourcePath: file, _source: 'manifests' }
      continue
    }
    if (!Array.isArray(parsed)) {
      yield {
        _parseError: 'manifest file must contain a top-level JSON array',
        sourcePath: file,
        _source: 'manifests',
      }
      continue
    }
    for (const obj of parsed) {
      yield { ...obj, sourcePath: file, _source: 'manifests' }
    }
  }
}

export default {
  name: 'rules-kb-template',
  description:
    'Starter ingestion: walks docs/**/*.md (narrative) and manifests/**/*.json (declarative), emits a unified knowledge graph for DevFlow specify/plan phases.',

  async run(ctx) {
    // [PROJECT] Default root: <plugin-dir>. Override from the CLI with
    //   kb-ingest ingest --db ./kb.db --plugin ./ingest.mjs --opt root=/abs/path
    // The plugin then expects <root>/docs/ and/or <root>/manifests/ under it.
    const root = ctx.options.root
      ? String(ctx.options.root)
      : fileURLToPath(new URL('.', import.meta.url))

    ctx.log(`scanning ${root}`)

    const entities = []
    const edges = []
    const termsByEntity = new Map()
    const rejected = []

    for (const entry of loadEntries(root)) {
      const sourcePath = entry.sourcePath
      if (entry._parseError) {
        rejected.push({ file: sourcePath, reason: entry._parseError })
        continue
      }
      const id = entry.id
      if (!id) {
        rejected.push({ file: sourcePath, reason: 'missing id' })
        continue
      }
      const type = entry.type
      if (!type || !VALID_TYPES.has(type)) {
        rejected.push({
          file: sourcePath,
          reason: `invalid type "${String(type)}" (valid: ${[...VALID_TYPES].join(', ')})`,
        })
        continue
      }
      const name = entry.name ?? id
      const body = entry.body ?? null

      // Everything not consumed structurally goes into metadata so queries can
      // filter on it (e.g. `WHERE json_extract(metadata, '$.status') = 'active'`).
      const reserved = new Set([
        'id',
        'type',
        'name',
        'body',
        'terms',
        'sourcePath',
        '_source',
        '_parseError',
        ...Object.keys(EDGE_RELATIONS),
      ])
      const metadata = {}
      for (const k of Object.keys(entry)) {
        if (!reserved.has(k)) metadata[k] = entry[k]
      }

      entities.push({ id, type, name, body, metadata, sourcePath })

      const terms = asArray(entry.terms)
      if (terms.length > 0) termsByEntity.set(id, terms)

      for (const [srcKey, relation] of Object.entries(EDGE_RELATIONS)) {
        for (const target of asArray(entry[srcKey])) {
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
