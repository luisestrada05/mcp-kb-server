# @kb/mcp-server

A **generic MCP server** that exposes a SQLite knowledge graph (entities + edges + FTS5) to AI agents. Domain-agnostic — each project provides its own ingestion plugin and its own taxonomy of entity types and relations.

Designed for projects where:

- Rules / decisions / features sprawl across many markdown files.
- Multiple devs (and multiple agents) need the same answers.
- "Word → relevant rules" is the recurring access pattern.

The server itself is **read-only by default** — writes flow through an offline ingestion step driven by a per-project plugin, keeping markdown as the source of truth.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  PER-PROJECT (what each team provides)                      │
│  ├─ markdown canonical source                               │
│  ├─ ingestion plugin (markdown → entities + edges + terms)  │
│  └─ .mcp.json with KB_DB_PATH                               │
└──────────────────┬──────────────────────────────────────────┘
                   ▼
              ┌─────────┐
              │ SQLite  │  generic schema:
              │         │  entities + edges + terms + FTS5
              └────┬────┘
                   ▼
┌─────────────────────────────────────────────────────────────┐
│  GENERIC MCP SERVER (this package)                          │
│  Tools exposed to Claude/Copilot/any MCP client:            │
│   kb_find   kb_by_term   kb_get   kb_traverse   kb_related  │
│   kb_add_entity   kb_add_edge   (opt-in via KB_ALLOW_WRITES)│
└─────────────────────────────────────────────────────────────┘
```

---

## Schema

Three concrete tables + one FTS virtual table. All free-form — `type` and `relation` are project-defined strings.

```sql
entities      (id PK, type, name, body, metadata JSON, source_path, updated_at)
edges         (src, dst, relation, metadata JSON, PRIMARY KEY(src, dst, relation))
terms         (term, entity_id, PRIMARY KEY(term, entity_id))
entities_fts  (FTS5: name + body, BM25, kept in sync via triggers)
embeddings    (entity_id PK, model, dims, content_hash, vector BLOB float32)   -- optional, see below
```

`metadata` columns are SQLite JSON1, queryable via `json_extract` if you need richer filters than entity type.

---

## Quickstart

### 1. Install

```bash
npm install -g @kb/mcp-server
# or use it as a local dep — both kb-mcp and kb-ingest end up on PATH via npm exec.
```

### 2. Init a DB + write an ingestion plugin

```bash
mkdir my-project-kb && cd $_
kb-ingest init --db ./kb.db
```

Create `ingest.mjs`:

```js
export default {
  name: 'my-project',
  async run(ctx) {
    // ctx.entities, ctx.edges, ctx.search — typed repos for population
    ctx.entities.upsert({
      id: 'rule:diferidos',
      type: 'rule',
      name: 'Reglas de diferidos',
      body: 'Markdown body...',
      metadata: { severity: 'critical' },
    })
    ctx.search.addTerms('rule:diferidos', ['diferidos', 'msi'])
  },
}
```

### 3. Ingest + verify

```bash
kb-ingest ingest --db ./kb.db --plugin ./ingest.mjs
kb-ingest status --db ./kb.db
kb-ingest query term diferidos --db ./kb.db
```

### 4. Wire to your MCP client

`.mcp.json`:

```json
{
  "mcpServers": {
    "kb": {
      "command": "kb-mcp",
      "env": { "KB_DB_PATH": "/abs/path/to/kb.db" }
    }
  }
}
```

The client now sees the `kb_*` tools.

---

## Tools

| Tool | Purpose | Args |
|---|---|---|
| `kb_find` | Ranked search over name + body: FTS5 keywords fused with semantic similarity | `query`, `type?`, `limit?`, `mode?` (`hybrid` \| `semantic` \| `fts`) |
| `kb_by_term` | Exact keyword lookup | `term`, `type?`, `limit?` |
| `kb_get` | Full entity by ID | `id` |
| `kb_traverse` | BFS graph walk | `id`, `relation?`, `maxDepth?` |
| `kb_related` | Outgoing + incoming edges | `id` |
| `kb_add_entity` (opt-in) | Upsert entity | `id`, `type`, `name`, `body?`, `metadata?`, `sourcePath?` |
| `kb_add_edge` (opt-in) | Upsert edge | `src`, `dst`, `relation`, `metadata?` |

Writes are off by default — set `KB_ALLOW_WRITES=1` in the server env to enable.

### When to use which

- Saw a domain keyword in the request → `kb_by_term`
- Free-form question ("how do we handle X?") → `kb_find`
- Already have an ID, need full content → `kb_get`
- "What does X depend on?" → `kb_traverse` with `relation` filter
- "What is connected to X?" (one hop, both directions) → `kb_related`

---

## Búsqueda semántica (embeddings)

`kb_find` combina dos búsquedas:

- **FTS5 / BM25**: coincidencia de palabras. Acierta con IDs, códigos y nombres exactos (`R-DIF-011`, `DIVVAL`).
- **Vectores**: cada entidad (`name + body`) se convierte en un vector de 384 números que representa su significado. Encuentra reglas escritas con otras palabras que la pregunta ("¿puedo pagar en mensualidades?" → "alta de diferido").

Las dos listas se combinan con *Reciprocal Rank Fusion*. La respuesta indica qué método encontró cada hit (`matchedBy`) y en qué modo corrió (`mode`).

Las preguntas en lenguaje natural funcionan aunque lleven `¿?`, guiones o comillas. Si FTS5 rechaza la sintaxis, o el AND implícito de todas las palabras no encuentra nada, se reintenta uniendo las palabras con OR. Esa versión quita palabras vacías como "qué", "pasa" o "puede" y mantiene juntos los IDs con guion.

### Generar los vectores

Se generan offline, después de `ingest`:

```bash
kb-ingest ingest --db ./kb.db --plugin ./ingest.mjs
kb-ingest embed  --db ./kb.db        # vectoriza todo lo que hay en la KB
kb-ingest status --db ./kb.db        # embeddings: { models, missing, stale, index }
```

- **Modelo local**: [`Xenova/multilingual-e5-small`](https://huggingface.co/Xenova/multilingual-e5-small). Es multilingüe (incluye español), pesa ~130 MB, corre en CPU y no necesita API key. Se descarga una vez al cache (`KB_EMBED_CACHE_DIR`). Para usar otro: `--model <id de Hugging Face>`.
- **Incremental**: solo re-vectoriza entidades cuyo texto cambió. Si se cambia de modelo, re-vectoriza todo, porque vectores de modelos distintos no son comparables.
- **El server usa el modelo registrado en la DB** para convertir las preguntas, así que nunca mezcla modelos.
- **Sin vectores, todo sigue funcionando**: si la DB no tiene vectores, o el modelo no se puede cargar, `kb_find` usa solo FTS y lo dice en `warning`. `KB_EMBEDDINGS=0` desactiva la búsqueda semántica.
- **Dependencias opcionales**: `@huggingface/transformers` y `sqlite-vec` son `optionalDependencies`. Sin la primera, el server sigue con FTS; sin la segunda, compara vectores en JS (ver abajo).

La imagen Docker del server ya trae el modelo descargado (`kb-ingest model-pull` en el build), así que funciona sin acceso a internet.

### Escalar a muchos documentos (`sqlite-vec`)

`embeddings` es una tabla normal: es la fuente de verdad y se lee sin extensiones. Encima de ella, `kb-ingest embed` construye un índice [`sqlite-vec`](https://github.com/asg017/sqlite-vec) (`embeddings_vec`, tabla `vec0`), y el server lo usa para la búsqueda vectorial. Medido con vectores de 384 dimensiones, misma respuesta en los tres casos:

| Vectores | Comparación en JS | `sqlite-vec` (`vec0`) |
|---|---|---|
| 10k | ~78 ms por consulta | ~7 ms |
| 100k | ~960 ms por consulta | ~70 ms |

- **Automático**: si `sqlite-vec` está instalado (viene por default, tiene binarios para Linux x64/arm64, macOS y Windows) y el índice está en sync con `embeddings`, se usa; si no, el server cae a la comparación en JS. Ambos son exactos y devuelven el mismo ranking.
- **Cuál se está usando**: `kb-ingest status` → `embeddings.index.engine` (`sqlite-vec` o `scan`, con el motivo), y el server lo escribe al arrancar: `vector search: sqlite-vec`.
- **El filtro `type`** de `kb_find` se aplica dentro de la búsqueda del índice (columna de metadata de `vec0`), no después.
- **Documentos largos**: el modelo solo lee los primeros ~512 tokens (~350–400 palabras) de cada entidad; el resto no entra en el vector. Para documentación extensa, que el plugin de ingesta parta cada documento en secciones (una entidad por sección, con una arista al documento padre). Eso pesa más en la calidad que el motor de búsqueda.

### Si el build tarda demasiado

Lo caro no es buscar sino **vectorizar**, y pasa en el build del repo de contenido (`kb-ingest embed`), no en el server. Medido en 4 vCPU (como un runner de GitHub Actions):

| Tamaño por entidad | Tiempo por entidad | 1,000 entidades | 10,000 entidades |
|---|---|---|---|
| ~80 palabras (una regla) | ~12 ms | ~12 s | ~2 min |
| ~400 palabras (una sección de documento) | ~150 ms | ~2.5 min | ~25 min |

Opciones, de más a menos efectiva:

1. **Reutilizar los vectores del build anterior**: `kb-ingest embed --reuse-from <db anterior>` copia el vector de toda entidad cuyo texto no cambió y solo vectoriza lo nuevo o editado. Con un `.db` que se reconstruye desde cero en cada build, esto convierte un build de 25 min en uno de segundos cuando cambian pocas cosas. La receta para tomar el `.db` de la imagen publicada anterior está en el README de `kb-content`.
2. **Subir `timeout-minutes`** del workflow que construye la imagen de datos (hoy 15) mientras se activa lo anterior.
3. **No cambiar de modelo sin necesidad**: cambiar `--model` invalida todos los vectores y obliga a re-vectorizar todo.

La imagen del **server** no depende del tamaño del contenido. Su build descarga `onnxruntime-node` (`npm ci`) y el modelo (~130 MB, `model-pull`), unos segundos cada uno en CI. Si aun así molesta, la capa de `model-pull` se puede mover a una etapa propia que no dependa de `src/`, para que el layer cache la conserve entre builds.

Test con el modelo real (descarga el modelo la primera vez):

```bash
KB_TEST_REAL_EMBEDDINGS=1 npx vitest run tests/integration/embeddings-real.test.ts
```

---

## Servidor HTTP centralizado (modo multi-usuario)

Además del modo stdio (1 proceso por dev), el server puede correr en **modo HTTP** para que todo el equipo comparta la misma KB en tiempo real.

### Encender el server

```bash
cd /Users/luis.estrada/Documents/banregio/mcp-kb-server
nvm use 20
KB_DB_PATH="$(pwd)/kb.db" KB_ALLOW_WRITES=1 node dist/server/http.js
```

Verás:
```
[kb-mcp-http] listening on http://0.0.0.0:3001/mcp  (writes ON)
```

> **Tip:** Para dejarlo corriendo en background usa `pm2`, `tmux`, o `nohup`:
> ```bash
> nohup env KB_DB_PATH="$(pwd)/kb.db" KB_ALLOW_WRITES=1 node dist/server/http.js > kb-server.log 2>&1 &
> echo $! > kb-server.pid
> ```

### Apagar el server

- Si corre en foreground: `Ctrl+C`
- Si usaste nohup/background:
  ```bash
  kill $(cat kb-server.pid)
  ```
- Si usaste pm2:
  ```bash
  pm2 stop kb-mcp-http
  ```

### Configuración de cada dev (`.mcp.json`)

```json
{
  "mcpServers": {
    "kb": {
      "url": "http://<IP_DEL_SERVER>:3001/mcp"
    }
  }
}
```

### Variables de entorno

| Variable | Requerida | Descripción |
|---|---|---|
| `KB_DB_PATH` | Sí | Ruta absoluta al archivo SQLite |
| `KB_ALLOW_WRITES` | No | `1` para habilitar escrituras desde los agentes |
| `KB_PORT` | No | Puerto HTTP (default: `3001`) |
| `KB_MIGRATIONS_DIR` | No | Override del directorio de migraciones |
| `KB_EMBED_CACHE_DIR` | No | Carpeta del modelo de embeddings (en la imagen Docker: `/app/models`) |
| `KB_EMBEDDINGS` | No | `0` para desactivar la búsqueda semántica (`kb_find` solo FTS) |

### Despliegue con Docker (recomendado para el equipo)

Arquitectura de dos imágenes que comparten un volumen:

```
ghcr.io/.../kb-content:main      ── one-shot init container
   contiene: kb.db ya ingestado      copia /kb.db → volumen kb-data
                                          │
                                          ▼
ghcr.io/.../mcp-kb-server:main   ── long-running HTTP server
   lee el .db del volumen kb-data       expone :3001/mcp
```

La separación significa que el **contenido** vive en su propio repo (`kb-content`) con su propio CI; el **servidor** es genérico y reutilizable.

**1. Autenticación (una sola vez por dev):**

Ambas imágenes son privadas. Cada miembro del equipo necesita un Personal Access Token con scope `read:packages` y un login:

```bash
echo $GH_PAT | docker login ghcr.io -u <github-username> --password-stdin
```

**2. Despliegue con `docker-compose`:**

Copia [`docker-compose.example.yml`](docker-compose.example.yml) a `docker-compose.yml` y levanta el stack:

```bash
docker compose pull
docker compose up -d
docker compose logs -f kb-mcp
```

El healthcheck (`GET /health`) confirma que el server está vivo:

```bash
curl http://localhost:3001/health
# {"status":"ok"}
```

**3. Refrescar reglas:**

Cuando un PR mergea a `main` en `kb-content`, su CI publica una nueva `ghcr.io/.../kb-content:main`. En el host:

```bash
docker compose pull
docker compose up -d --force-recreate
```

`--force-recreate` hace que el init-container (`kb-data-loader`) corra de nuevo y publique el `.db` fresco al volumen antes de que el server reinicie.

**4. Configurar a los devs:**

Sus `.mcp.json` apuntan al server desplegado:

```json
{ "mcpServers": { "kb": { "url": "http://<host>:3001/mcp" } } }
```

> **Modo standalone (sin `kb-content`):** si querés probar el server con un `.db` armado a mano, podés bind-mountar un directorio local en lugar del volumen y omitir el servicio `kb-data-loader`. Ver comentarios en `docker-compose.example.yml`.

---

## Ingestion plugin contract

A plugin is an ESM (`.mjs` or compiled `.js`) module that default-exports:

```ts
interface IngestionPlugin {
  name: string
  description?: string
  run(ctx: IngestionContext): Promise<void> | void
}

interface IngestionContext {
  db: Database
  entities: EntityRepo
  edges: EdgeRepo
  search: SearchRepo
  options: Record<string, string | boolean | number | undefined>
  log: (msg: string) => void
}
```

Or a factory:

```js
export default function makePlugin() {
  return { name: 'my-plugin', run(ctx) { ... } }
}
```

CLI options forward to `ctx.options`:

```bash
kb-ingest ingest --db ./kb.db --plugin ./ingest.mjs --opt root=/path --opt verbose=true
```

See [`examples/minimal-kb/`](examples/minimal-kb/) for a complete working plugin that walks markdown + frontmatter.

---

## CLI commands

```
kb-ingest init     --db <path>                           Create + migrate the SQLite file.
kb-ingest ingest   --db <path> --plugin <path> [--opt k=v ...]
                                                          Run a per-project plugin.
kb-ingest embed    --db <path> [--model ID] [--batch N] [--reuse-from <old.db>]
                                                          Embed entities for semantic search (incremental) and
                                                          rebuild the sqlite-vec index.
kb-ingest model-pull [--model ID]                         Download the embedding model into KB_EMBED_CACHE_DIR.
kb-ingest status   --db <path>                            Migrations, entity counts per type, embedding coverage.
kb-ingest query find <text...> --db <path> [--type T] [--limit N] [--mode hybrid|semantic|fts]
                                                          Same search as kb_find.
kb-ingest query term <term>    --db <path> [--type T]
                                                          Keyword lookup.
kb-ingest query get <id>       --db <path>                Full entity.
kb-ingest query related <id>   --db <path>                Both directions.

kb-mcp                                                    MCP server (stdio).
  Reads env: KB_DB_PATH (required), KB_ALLOW_WRITES (opt), KB_MIGRATIONS_DIR (opt),
             KB_EMBED_CACHE_DIR (opt), KB_EMBEDDINGS (opt).
```

---

## Development

```bash
npm install
npm run build
npm test           # 55+ tests across DB, repos, server tools, CLI ingestion
npm run verify     # lint + typecheck + tests (pre-commit chain)
```

---

## License

MIT.
