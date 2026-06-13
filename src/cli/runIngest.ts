import { resolve, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Database } from '../db/Database.js'
import { runMigrations } from '../db/migrations.js'
import { EntityRepo } from '../repos/EntityRepo.js'
import { EdgeRepo } from '../repos/EdgeRepo.js'
import { SearchRepo } from '../repos/SearchRepo.js'
import { resolvePlugin, type IngestionContext, type IngestionPlugin } from './plugin.js'

export interface RunIngestOptions {
  dbPath: string
  pluginPath: string
  migrationsDir?: string
  pluginOptions?: Record<string, string | boolean | number | undefined>
  /** Where progress logs go. Defaults to process.stderr to keep stdout clean. */
  logger?: (msg: string) => void
}

export interface RunIngestResult {
  plugin: string
  entitiesBefore: number
  entitiesAfter: number
  edgesBefore: number
  edgesAfter: number
  durationMs: number
}

/**
 * Run a plugin against the DB at `dbPath`. Creates and migrates the DB if
 * needed. Used by both the CLI (`kb-ingest run ...`) and the integration tests.
 *
 * Returns counts before/after so callers can detect drift (e.g. a plugin that
 * didn't actually write anything).
 */
export async function runIngest(opts: RunIngestOptions): Promise<RunIngestResult> {
  const logger =
    opts.logger ??
    ((msg: string): void => {
      process.stderr.write(`[kb-ingest] ${msg}\n`)
    })
  const absPluginPath = isAbsolute(opts.pluginPath)
    ? opts.pluginPath
    : resolve(process.cwd(), opts.pluginPath)

  const db = new Database({ path: opts.dbPath })
  try {
    runMigrations(db, opts.migrationsDir)

    const entities = new EntityRepo(db)
    const edges = new EdgeRepo(db)
    const search = new SearchRepo(db)

    const entitiesBefore = entities.count()
    const edgesBefore = (db.raw.prepare('SELECT COUNT(*) c FROM edges').get() as { c: number }).c

    // pathToFileURL is essential for absolute paths on Windows AND for ESM
    // dynamic import in Node — `import("/abs/path")` is treated as a bare
    // specifier and fails. `import(pathToFileURL(p).href)` is the canonical form.
    const mod: unknown = await import(pathToFileURL(absPluginPath).href)
    const plugin: IngestionPlugin = resolvePlugin(mod)

    logger(`loading plugin "${plugin.name}" from ${absPluginPath}`)

    const ctx: IngestionContext = {
      db,
      entities,
      edges,
      search,
      options: opts.pluginOptions ?? {},
      log: logger,
    }

    const t0 = Date.now()
    await plugin.run(ctx)
    const durationMs = Date.now() - t0

    const entitiesAfter = entities.count()
    const edgesAfter = (db.raw.prepare('SELECT COUNT(*) c FROM edges').get() as { c: number }).c

    logger(
      `done in ${durationMs}ms — entities: ${entitiesBefore} → ${entitiesAfter}, edges: ${edgesBefore} → ${edgesAfter}`
    )

    return {
      plugin: plugin.name,
      entitiesBefore,
      entitiesAfter,
      edgesBefore,
      edgesAfter,
      durationMs,
    }
  } finally {
    db.close()
  }
}
