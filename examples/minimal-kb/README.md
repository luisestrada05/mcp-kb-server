# Minimal KB example

End-to-end example: 3 markdown files with frontmatter → KB populated → queries.

## Layout

```
docs/
  rules/
    diferidos.md       (rule)
    promociones.md     (rule, cites: rule:diferidos)
  features/
    calculadora-diferidos.md   (feature, depends_on both rules)
ingest.mjs             ESM plugin that parses frontmatter
.mcp.json              Sample MCP server config
```

## Run it

Assuming you built `mcp-kb-server` (`npm run build` at the repo root) and
have `kb-ingest` available (either via `npm link` or `npx`):

```bash
# 1. Init + ingest
kb-ingest init --db ./kb.db
kb-ingest ingest --db ./kb.db --plugin ./ingest.mjs

# 2. Inspect
kb-ingest status --db ./kb.db
kb-ingest query find diferidos --db ./kb.db
kb-ingest query term diferidos --db ./kb.db
kb-ingest query related rule:diferidos --db ./kb.db

# 3. Start the MCP server (any MCP client can now connect via stdio)
KB_DB_PATH=./kb.db kb-mcp
```

## What the plugin does

`ingest.mjs` is the per-project glue. It:

1. Walks `docs/**/*.md`
2. Parses YAML-ish frontmatter (no external dep — small regex parser)
3. For each file:
   - Creates an `entity` with `id`, `type`, `name`, `body`, `metadata` (other frontmatter fields)
   - Adds `terms` (the `terms:` array in frontmatter) to the keyword index
   - Adds edges for any `depends_on`, `cites`, `supersedes`, `applies_to` lists
4. Logs progress via `ctx.log`

Real projects swap the parser, the source layout, the entity types, and the
relation set — that's all the plugin contract requires.

## What the MCP exposes

Once the server is running, an MCP client (Claude Code, Copilot, etc.) sees
these tools:

- `kb_find(query, type?, limit?)` — full-text search
- `kb_by_term(term, type?, limit?)` — exact keyword lookup
- `kb_get(id)` — full entity by ID
- `kb_traverse(id, relation?, maxDepth?)` — BFS graph walk
- `kb_related(id)` — outgoing + incoming edges

(Plus `kb_add_entity` / `kb_add_edge` if `KB_ALLOW_WRITES=1`.)
