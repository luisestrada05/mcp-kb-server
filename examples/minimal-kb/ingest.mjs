/**
 * Example ingestion plugin — reads markdown files with YAML-ish frontmatter
 * and translates them into KB entities + edges + terms.
 *
 * This plugin is intentionally dependency-free (no yaml/gray-matter package)
 * to keep the example minimal. Real projects can use whatever parser they
 * prefer — the contract just requires that you populate ctx.entities,
 * ctx.edges, and ctx.search by the time your `run` returns.
 *
 * Frontmatter format (subset of YAML):
 *
 *   ---
 *   id: <stable-id>
 *   type: <entity-type>
 *   name: <display name>
 *   terms: [array, of, keywords]
 *   depends_on: [other-id]
 *   cites: [other-id]
 *   ... other fields become metadata ...
 *   ---
 *
 * Edge relations supported in this example: `depends_on`, `cites`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

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
    if (v.startsWith('[') && v.endsWith(']')) {
      frontmatter[key] = v
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    } else {
      frontmatter[key] = v
    }
  }
  return { frontmatter, body: body.trim() }
}

const EDGE_KEYS = ['depends_on', 'cites', 'supersedes', 'applies_to']

export default {
  name: 'minimal-kb-ingest',
  description: 'Walks `docs/**/*.md`, parses frontmatter, populates the KB.',

  async run(ctx) {
    const root = ctx.options.root
      ? String(ctx.options.root)
      : join(fileURLToPath(new URL('.', import.meta.url)), 'docs')

    ctx.log(`scanning ${root}`)

    const files = walk(root)
    const entities = []
    const edges = []
    const termsByEntity = new Map()

    for (const file of files) {
      const source = readFileSync(file, 'utf-8')
      const { frontmatter, body } = parseFrontmatter(source)
      const id = frontmatter.id
      if (!id) {
        ctx.log(`skip ${file} — no id in frontmatter`)
        continue
      }
      const type = frontmatter.type ?? 'note'
      const name = frontmatter.name ?? id

      // Strip the structured fields out of metadata so they don't duplicate.
      const metadata = { ...frontmatter }
      for (const k of ['id', 'type', 'name', 'terms', ...EDGE_KEYS]) delete metadata[k]

      entities.push({ id, type, name, body, metadata, sourcePath: file })

      const terms = Array.isArray(frontmatter.terms) ? frontmatter.terms : []
      if (terms.length > 0) termsByEntity.set(id, terms)

      for (const relation of EDGE_KEYS) {
        const targets = Array.isArray(frontmatter[relation]) ? frontmatter[relation] : []
        for (const target of targets) {
          edges.push({ src: id, dst: target, relation })
        }
      }
    }

    ctx.entities.upsertMany(entities)
    ctx.edges.upsertMany(edges)
    for (const [id, terms] of termsByEntity) {
      ctx.search.clearTerms(id) // re-ingest cleanly
      ctx.search.addTerms(id, terms)
    }

    ctx.log(
      `loaded ${entities.length} entities, ${edges.length} edges, ${termsByEntity.size} term sets`
    )
  },
}
