import type { EntityRepo } from '../repos/EntityRepo.js'
import type { EdgeRepo } from '../repos/EdgeRepo.js'
import type { SearchRepo } from '../repos/SearchRepo.js'
import type { Database } from '../db/Database.js'

/**
 * Context passed to a project's ingestion plugin. The plugin reads the
 * project's source of truth (markdown, JSON, API, etc.) and translates it
 * into entities + edges + terms via the provided repositories.
 *
 * Plugins are intentionally given direct repo access (not a higher-level
 * abstraction) so each project can implement whatever traversal/parsing
 * logic its source format requires without bumping against a one-size-fits-all
 * ingestion API.
 */
export interface IngestionContext {
  /** Direct DB handle for plugins that need raw SQL (rare). */
  db: Database
  entities: EntityRepo
  edges: EdgeRepo
  search: SearchRepo
  /** Project-specific options from the CLI (e.g. --root /path/to/docs). */
  options: Record<string, string | boolean | number | undefined>
  /** Append-only log surface — print progress here, not to stdout. */
  log: (msg: string) => void
}

/**
 * The contract every per-project ingestion plugin must satisfy.
 *
 * Plugin file is a TS/JS module that default-exports a plugin object, OR a
 * factory function returning one. The CLI loads it via `import()`.
 *
 * @example
 *   // my-project/ingest.mjs
 *   export default {
 *     name: 'my-project-rules',
 *     async run(ctx) {
 *       // 1. Read docs/rules/*.md
 *       // 2. Parse frontmatter for terms, body for content
 *       // 3. ctx.entities.upsertMany([...])
 *       // 4. ctx.edges.upsertMany([...])
 *       // 5. ctx.search.addTerms(...) for each entity
 *     }
 *   }
 */
export interface IngestionPlugin {
  /** Plugin name for logging. */
  name: string
  /** Optional schema description shown in `kb-ingest status`. */
  description?: string
  /** The actual ingestion logic. */
  run: (ctx: IngestionContext) => Promise<void> | void
}

export type IngestionPluginFactory = () => IngestionPlugin
export type LoadedPluginModule =
  | { default: IngestionPlugin }
  | { default: IngestionPluginFactory }

/**
 * Resolve a plugin module export — supports both default-exported plugin
 * objects and default-exported factories. Throws a clear error if the export
 * shape is wrong (plugins are easy to mis-write; the failure mode should be
 * obvious).
 */
export function resolvePlugin(mod: unknown): IngestionPlugin {
  if (mod === null || typeof mod !== 'object') {
    throw new Error(
      'Plugin module did not export anything. Expected `export default <plugin>` or factory.'
    )
  }
  const m = mod as { default?: unknown }
  if (m.default === undefined) {
    throw new Error('Plugin module has no `default` export.')
  }
  const value = m.default
  if (typeof value === 'function') {
    const result = (value as IngestionPluginFactory)()
    if (!isPlugin(result)) {
      throw new Error('Plugin factory did not return a valid IngestionPlugin.')
    }
    return result
  }
  if (!isPlugin(value)) {
    throw new Error('Default export is not a valid IngestionPlugin (missing `name` or `run`).')
  }
  return value
}

function isPlugin(v: unknown): v is IngestionPlugin {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as IngestionPlugin).name === 'string' &&
    typeof (v as IngestionPlugin).run === 'function'
  )
}
