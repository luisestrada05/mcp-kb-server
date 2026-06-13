# Rules + Tech KB — starter template

Starter ingestion template that unifies **business knowledge** (rules, decisions, glossary terms) and **technical artifacts** (components, endpoints, modules, services) into a single knowledge graph. Designed for projects with a DevFlow-style pipeline where:

- **`/devflow:specify`** needs business rules grounded in real constraints
- **`/devflow:plan`** needs to know *where the rule already lives in code*

Both phases query the same graph; the value compounds because rules and code link via cross-domain edges (`implements`, `applies`, `tested_by`).

## Default taxonomy

### Narrative entities (from `docs/`)

| Entity type | Purpose | Source |
|---|---|---|
| `rule` | Business / regulatory / operational rule | `docs/rules/*.md` (markdown + frontmatter) |
| `decision` | ADR-style decision with context + consequences | `docs/decisions/*.md` |
| `term` | Glossary entry / canonical definition | `docs/terms/*.md` |

### Technical entities (from `manifests/`)

| Entity type | Purpose | Source |
|---|---|---|
| `component` | UI / library component (with path, props, usage) | `manifests/components.json` |
| `endpoint` | HTTP route (with method, path, contract) | `manifests/endpoints.json` |
| `module` | Top-level domain module | `manifests/modules.json` |
| `service` | Callable service / domain function | `manifests/services.json` |

### Relations

| Relation | From → To | Meaning |
|---|---|---|
| **Narrative-only** |  |  |
| `cites` | rule/decision → rule/decision/term | "I reference this in my body" |
| `defines` | decision/rule → term | "I authoritatively define this term" |
| `supersedes` | decision/rule → rule/decision | "I replace this older entity" |
| **Cross-domain (the high-value bridges)** |  |  |
| `implements` | component/service → rule | "I'm the production implementation of this rule" |
| `applies` | component/endpoint/service → rule | "I enforce this rule at runtime" |
| `tested_by` | rule/component → test/scenario | "My behavior is verified by this" |
| **Technical-only** |  |  |
| `exposes` | module → endpoint/service | "I make this surface available" |
| `consumes` | component/endpoint → endpoint/service | "I call this" |
| `depends_on` | component → component | "I composite this" (use sparingly) |

## Source layouts

Either or both layouts work — the plugin skips empty/missing directories silently.

```
tools/kb-ingest/
├─ ingest.mjs              the plugin (this file)
├─ docs/                   NARRATIVE (markdown + frontmatter)
│  ├─ rules/*.md
│  ├─ decisions/*.md
│  └─ terms/*.md
└─ manifests/              DECLARATIVE (JSON arrays)
   ├─ components.json
   ├─ endpoints.json
   ├─ modules.json
   └─ services.json
```

## Markdown frontmatter contract (for `docs/`)

```yaml
---
id: rule:tasa-interes              # REQUIRED, stable ID — convention: <type>:<slug>
type: rule                          # MUST match VALID_TYPES
name: Tasa de interés ordinaria     # REQUIRED, display name
terms: [tasa, interés, ordinario]   # OPTIONAL, keyword index entries
status: active                      # OPTIONAL, free-form metadata
owner: producto

# Edges
cites: [rule:plazos]
defines: [term:tasa-ordinaria]
supersedes: rule:tasa-vieja
---

<markdown body — indexed by FTS5/BM25>
```

## JSON manifest contract (for `manifests/`)

Each file is a **top-level JSON array** of entity objects. The keys map 1:1 to the same shape as frontmatter:

```json
[
  {
    "id": "component:InterestRateInput",
    "type": "component",
    "name": "InterestRateInput",
    "path": "src/features/credits/components/InterestRateInput.tsx",
    "body": "Input numérico para tasa de interés...",
    "terms": ["tasa", "interés", "input"],
    "implements": ["rule:tasa-interes"],
    "owner": "frontend",
    "stability": "stable"
  }
]
```

Keys not consumed structurally (`path`, `owner`, `stability`, etc.) fall into `metadata` and can be queried via SQLite JSON1 if needed.

> **Why JSON, not YAML?** The template stays dependency-free. Swap in `js-yaml` or `gray-matter` once your authoring ergonomics demand it — the entity shape is identical.

## How to adopt in your project

```bash
# 1. Copy into your project repo
cp -r examples/rules-kb-template /path/to/your-project/tools/kb-ingest

# 2. Move your sources into docs/ and/or manifests/

# 3. Adapt ingest.mjs (search for [PROJECT] comments):
#    - VALID_TYPES   — add or remove entity types
#    - EDGE_RELATIONS — add or remove relations

# 4. Init + ingest
cd /path/to/your-project/tools/kb-ingest
kb-ingest init --db ./kb.db
kb-ingest ingest --db ./kb.db --plugin ./ingest.mjs
kb-ingest status --db ./kb.db

# 5. Add .mcp.json (or merge into existing one) at your project root
```

## Sample output

After ingestion of the bundled example (`docs/{rules,decisions,terms}/*.md` + `manifests/{components,endpoints,modules}.json`):

```bash
$ kb-ingest status --db ./kb.db
{
  "entities": {
    "total": 10,
    "byType": [
      { "type": "component", "c": 3 },
      { "type": "decision",  "c": 1 },
      { "type": "endpoint",  "c": 2 },
      { "type": "module",    "c": 1 },
      { "type": "rule",      "c": 2 },
      { "type": "term",      "c": 1 }
    ]
  },
  "edges": 15,
  "terms": 33
}
```

> **Note:** the sample also contains a deliberate `supersedes` reference to a non-existent entity (`rule:tasa-vieja-base-365`). The plugin detects orphan edges and **drops them with a warning** rather than crashing — this lets you migrate corpora in pieces.

## DevFlow workflow

### `/devflow:specify` — "what we want"

Agent identifies keywords from the ticket and queries the KB for rules + decisions that ground the spec:

```bash
$ kb-ingest query term tasa --db ./kb.db
# → rule:tasa-interes

$ kb-ingest query find "base 360" --db ./kb.db
# → decision:adr-0001 (top hit), rule:tasa-interes

$ kb-ingest query related rule:tasa-interes --db ./kb.db
# → outgoing: cites rule:plazos, cites term:tasa-ordinaria
```

The spec then cites IDs (`rule:tasa-interes`, `decision:adr-0001`) instead of re-explaining the rule's content.

### `/devflow:plan` — "where it lives"

Agent reads the spec and asks "for each cited rule, where is it implemented today?":

```bash
$ kb-ingest query related rule:tasa-interes --db ./kb.db
# incoming:
#   component:InterestRateInput  --implements--> rule:tasa-interes
#   component:CreditCalculator   --applies-----> rule:tasa-interes
#   endpoint:credits.calculate   --applies-----> rule:tasa-interes
#   decision:adr-0001            --cites-------> rule:tasa-interes
```

The plan now lists concrete `file:line` references:

- `src/features/credits/components/InterestRateInput.tsx` (primary implementation)
- `src/features/credits/components/CreditCalculator.tsx` (composite that applies it)
- `src/app/api/credits/calculate/route.ts` (BFF endpoint that enforces it)
- (Review `decision:adr-0001` for historical context.)

No "TODO: find where this lives" — already found.

## Prompt snippets for your DevFlow skills

Two minimal changes wire the KB into the flow:

**`/devflow:specify`** prompt addition:

```markdown
Antes de redactar la spec, identifica términos clave del ticket y consulta:
- `kb_by_term(<término>)` para cada concepto del dominio
- `kb_find(<frase>)` si el ticket usa lenguaje libre
- `kb_traverse(<rule_id>, "cites", 2)` para reglas conectadas

Cita las reglas relevantes por ID (e.g. "Per `rule:diferidos`...") en lugar
de re-explicar su contenido.
```

**`/devflow:plan`** prompt addition:

```markdown
Por cada regla citada en spec.md, identifica su implementación actual:
- `kb_related(<rule_id>)` → revisa `incoming` para encontrar
  componentes/endpoints que `implements` o `applies` la regla
- `kb_get(<component_id>)` → revisa `metadata.path` para el archivo exacto

Anota archivo:línea concreto en el plan. No "TODO: encontrar X" — encuéntralo.
```

## Adoption checklist

- [ ] Copy `examples/rules-kb-template` → `tools/kb-ingest/` in your repo
- [ ] Populate `docs/rules/` from your existing rule documentation
- [ ] Populate `manifests/components.json` with 10-30 of your most-reused components
- [ ] Populate `manifests/endpoints.json` from your route file
- [ ] Adapt `VALID_TYPES` and `EDGE_RELATIONS` in `ingest.mjs` if your taxonomy differs
- [ ] Add `.mcp.json` config (or merge into your existing one)
- [ ] Add `tools/kb-ingest/kb.db` to your `.gitignore` (it's a build artifact, not source)
- [ ] Update prompts of `/devflow:specify` and `/devflow:plan` to query the KB
- [ ] Re-ingest after each docs/manifests update; idempotent and ~80ms for ~50 entities

## What this template doesn't do

- **No auto-discovery of components/endpoints from code.** The manifests are curated. Easier to start, easier to control, but it does mean adding a component takes a JSON edit. For auto-discovery, swap the `loadManifestEntries` step with a glob+parser of your codebase (see "Nivel 2" in the original design discussion).
- **No code-symbol resolution.** "Find every place that calls `parseCurrencyInput()`" should still go to ripgrep / LSP / your IDE — that's not what this KB optimizes for.
- **No watch mode** out of the box. Re-run `kb-ingest ingest ...` after each change, or wire it into your pre-commit / CI.
