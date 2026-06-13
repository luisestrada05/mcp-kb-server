# Rules KB — starter template

Starter ingestion template for projects with a corpus of **rules + decisions + glossary terms** as markdown files. Copy this folder into your project, adapt the marked extension points, and you have a working KB.

## Default taxonomy

| Entity type | Purpose | Example |
|---|---|---|
| `rule` | Operational / business rule | `rule:tasa-interes` |
| `decision` | ADR-style decisions with context + consequences | `decision:adr-0001` |
| `term` | Glossary entry / canonical definition | `term:tasa-ordinaria` |

| Relation | Meaning | Direction |
|---|---|---|
| `cites` | "I reference this in my body" | `src → dst` |
| `defines` | "I authoritatively define this term" | `src → dst` |
| `supersedes` | "I replace this older entity" | `src → dst` |

## Frontmatter contract

```yaml
---
id: rule:tasa-interes              # REQUIRED, stable ID. Convention: <type>:<slug>
type: rule                          # rule | decision | term  (gated by VALID_TYPES)
name: Tasa de interés ordinaria     # REQUIRED, display name

# Keyword index — populate with the canonical terms that should resolve here
terms: [tasa, interés, ordinario]

# Free-form metadata (anything not consumed structurally lands in JSON metadata)
status: active                      # active | deprecated | draft
owner: producto
date: 2025-09-15

# Edges — arrays of target IDs. Scalars are also accepted (1-element list).
cites: [rule:plazos, term:tasa-ordinaria]
defines: [tasa-ordinaria]
supersedes: rule:tasa-vieja-base-365
---

<markdown body — indexed by FTS5 / BM25>
```

## How to adopt in your project

1. **Copy this folder into your project repo**:

   ```bash
   cp -r examples/rules-kb-template /path/to/your-project/tools/kb-ingest
   ```

2. **Move your markdown** into `tools/kb-ingest/docs/` (or override with `--opt root=/your/path`).

3. **Adapt `ingest.mjs`** — search for `[PROJECT]` comments:
   - `VALID_TYPES` — add your project's entity types (e.g. `'feature'`, `'invariant'`).
   - `EDGE_RELATIONS` — add your relations (e.g. `applies_to`, `mitigates`).
   - Default `root` — point at where your markdown actually lives.

4. **Init and ingest**:

   ```bash
   cd /path/to/your-project/tools/kb-ingest
   kb-ingest init --db ./kb.db
   kb-ingest ingest --db ./kb.db --plugin ./ingest.mjs
   kb-ingest status --db ./kb.db
   ```

5. **Wire to your MCP client** — copy `.mcp.json` to your project root (next to your existing `.mcp.json`, or merge it in). Adjust `KB_DB_PATH` to an absolute path or use the `${workspaceFolder}` substitution your client supports.

6. **Re-ingest after each edit** (or wire a file-watcher in your build pipeline):

   ```bash
   kb-ingest ingest --db ./kb.db --plugin ./ingest.mjs
   ```

   Re-ingestion is idempotent (upsert + cleared term re-add), safe to run repeatedly.

## Sample output of this template

After ingestion (`docs/{rules,decisions,terms}/*.md` → `kb.db`):

```bash
$ kb-ingest status --db ./kb.db
{
  "entities": {
    "total": 4,
    "byType": [
      { "type": "decision", "c": 1 },
      { "type": "rule",     "c": 2 },
      { "type": "term",     "c": 1 }
    ]
  },
  "edges": 4,
  "terms": 12
}
```

> **Note:** the sample also contains a deliberate `supersedes` reference to a non-existent entity (`rule:tasa-vieja-base-365`). The ingestion plugin detects orphan edges and **drops them with a warning** rather than crashing — this lets you migrate corpora in pieces. Add that entity later and re-ingest; the edge will materialize automatically.

Sample queries:

```bash
$ kb-ingest query term tasa --db ./kb.db
# → rule:tasa-interes (tagged with 'tasa')

$ kb-ingest query find "base 360" --db ./kb.db
# → decision:adr-0001 (top hit), rule:tasa-interes (cited)

$ kb-ingest query related decision:adr-0001 --db ./kb.db
# → outgoing: supersedes rule:tasa-vieja-base-365,
#             defines term:tasa-ordinaria,
#             cites rule:tasa-interes
```

## What the agent sees

Once the MCP server is connected, your agent can call:

- `kb_by_term(term="diferidos")` — exact tag lookup
- `kb_find(query="...")` — FTS over name + body
- `kb_get(id="...")` — full entity content
- `kb_traverse(id, relation="cites", maxDepth=2)` — graph walk
- `kb_related(id)` — neighborhood

…all without re-reading the markdown files token-by-token.

## When this template doesn't fit

You probably want to **swap the frontmatter parser** if:

- Your frontmatter uses real YAML features (nested objects, block scalars, multi-line strings) → replace `parseFrontmatter` with `gray-matter` or `js-yaml`.
- Your source isn't markdown (JSON, CSV, an API) → the `walk` + parse stages get replaced; the entity/edge population stays the same.

You probably want to **add more entity types** if:

- Your project has a clear concept that doesn't fit `rule`/`decision`/`term` (e.g. `risk`, `capability`, `endpoint`). Add to `VALID_TYPES` and document the convention.

Either case is normal — the template is a starting point, not a contract.
