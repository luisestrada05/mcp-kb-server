# yaml-rules — ingestion plugin for business rules in YAML

Reference plugin that ingests rules described in a structured YAML format (multiple rules per file, grouped by domain). Use this as a starting point when bootstrapping a content repo like `kb-content`.

## YAML format

One YAML file per domain. The top-level shape:

```yaml
metadata:
  domain: diferidos          # required — business domain
  version: "1.0.0"           # required — semver of the domain manifest
  created_at: "2026-06-15"   # required — ISO date

rules:
  - id: R-DIF-001            # required — pattern (R|E|G|S)-XXX-NNN
    type: rule               # rule | exception | gap | sla
    subdomain: alta          # free-form group inside the domain
    summary: "Descripción corta"
    applicability:
      evento: [alta_diferido, diferir_compra]   # array of triggering events
      actor: [SISTEMA, BATCH]
    formal_rule:                                # optional structured logic
      conditions:
        - field: validacion_previa
          op: eq                                # eq | neq | gt | lt | in | not_in
          value: true
      action: "Qué debe hacer el sistema"
      overrides: R-DIF-XXX                      # only for exceptions
    source_ref: "confluence-page §sección #N"
    owner: "equipo"
    status: active                              # active | deprecated | draft
    risk_note: "Qué pasa si NO se cumple"
    related_objects:                             # required for reference validation
      tables: [DIF, LIN]
      sps: [DIVVAL, LINALT]
```

## ID prefix ↔ type

The validator enforces the convention:

| Prefix | type |
|---|---|
| `R-` | `rule` |
| `E-` | `exception` |
| `G-` | `gap` |
| `S-` | `sla` |

## What the ingest produces

- One entity per `rule` (`rule:R-DIF-001`, etc.)
- One entity per referenced `table:X` and `sp:Y` (auto-created)
- Edges: `exception --overrides--> rule`, `rule --uses_table--> table`, `rule --uses_sp--> sp`
- Search terms: domain, subdomain, ID, eventos, tables, sps, keywords from summary

## How to validate before ingest

```bash
kb-ingest validate --db ./kb.db --file ./rules/diferidos.yaml --auto-register
```

Exits non-zero if the file violates the schema. Designed for use in CI.

## How to run the ingest

```bash
kb-ingest init    --db ./kb.db
kb-ingest ingest  --db ./kb.db --plugin ./ingest.mjs --opt root=./rules
kb-ingest status  --db ./kb.db
```

The plugin walks `<root>/**/*.{yaml,yml}` recursively.
