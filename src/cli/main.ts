#!/usr/bin/env node
/**
 * `kb-ingest` CLI — companion to the MCP server. Handles DB lifecycle
 * (init, ingest, status, query). The MCP server itself does NOT mutate the
 * DB by default; ingestion is a separate offline step driven by this CLI
 * and a per-project plugin.
 */
import { Command } from 'commander'
import { Database } from '../db/Database.js'
import { runMigrations, listAppliedMigrations } from '../db/migrations.js'
import { EntityRepo } from '../repos/EntityRepo.js'
import { EdgeRepo } from '../repos/EdgeRepo.js'
import { SearchRepo } from '../repos/SearchRepo.js'
import { runIngest } from './runIngest.js'

const program = new Command()
  .name('kb-ingest')
  .description('Ingestion + diagnostics CLI for @kb/mcp-server.')
  .version('0.1.0')

program
  .command('init')
  .description('Create (if missing) the SQLite DB and apply pending migrations.')
  .requiredOption('--db <path>', 'Path to the SQLite file.')
  .action((opts: { db: string }) => {
    const db = new Database({ path: opts.db })
    try {
      runMigrations(db)
      const applied = listAppliedMigrations(db)
      process.stdout.write(
        `[kb-ingest] initialized ${opts.db} — ${applied.length} migration(s) applied.\n`
      )
    } finally {
      db.close()
    }
  })

program
  .command('ingest')
  .description('Run a per-project ingestion plugin.')
  .requiredOption('--db <path>', 'Path to the SQLite file (created if missing).')
  .requiredOption('--plugin <path>', 'Path to the plugin module (ESM .js or .mjs).')
  .option(
    '--opt <key=value...>',
    'Plugin-specific options forwarded as ctx.options. Can be passed multiple times.'
  )
  .action(async (opts: { db: string; plugin: string; opt?: string[] }) => {
    const pluginOptions: Record<string, string | boolean | number> = {}
    for (const kv of opts.opt ?? []) {
      const eq = kv.indexOf('=')
      if (eq < 0) {
        pluginOptions[kv] = true
        continue
      }
      const key = kv.slice(0, eq)
      const rawValue = kv.slice(eq + 1)
      // Coerce simple values; everything else stays as string. Plugins can
      // re-coerce if they need richer parsing.
      if (rawValue === 'true') pluginOptions[key] = true
      else if (rawValue === 'false') pluginOptions[key] = false
      else if (/^-?\d+$/.test(rawValue)) pluginOptions[key] = Number(rawValue)
      else pluginOptions[key] = rawValue
    }
    const result = await runIngest({
      dbPath: opts.db,
      pluginPath: opts.plugin,
      pluginOptions,
    })
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  })

program
  .command('status')
  .description('Print DB stats: applied migrations, entity counts per type.')
  .requiredOption('--db <path>', 'Path to the SQLite file.')
  .action((opts: { db: string }) => {
    const db = new Database({ path: opts.db, readonly: true })
    try {
      const applied = listAppliedMigrations(db)
      const byType = db.raw
        .prepare('SELECT type, COUNT(*) c FROM entities GROUP BY type ORDER BY type')
        .all() as Array<{ type: string; c: number }>
      const edgeCount = (db.raw.prepare('SELECT COUNT(*) c FROM edges').get() as { c: number }).c
      const termCount = (db.raw.prepare('SELECT COUNT(*) c FROM terms').get() as { c: number }).c

      process.stdout.write(
        JSON.stringify(
          {
            db: opts.db,
            migrations: applied,
            entities: { total: byType.reduce((acc, r) => acc + r.c, 0), byType },
            edges: edgeCount,
            terms: termCount,
          },
          null,
          2
        ) + '\n'
      )
    } finally {
      db.close()
    }
  })

// Compact debug queries from the CLI — handy when developing a plugin.
const query = program.command('query').description('Ad-hoc read queries against the KB.')

query
  .command('find <text...>')
  .description('FTS search (joins multi-word args into one query).')
  .requiredOption('--db <path>', 'Path to the SQLite file.')
  .option('--type <type>', 'Filter by entity type.')
  .option('--limit <n>', 'Max hits (default 20).', '20')
  .action((text: string[], opts: { db: string; type?: string; limit: string }) => {
    const db = new Database({ path: opts.db, readonly: true })
    try {
      const search = new SearchRepo(db)
      const hits = search.fullText(text.join(' '), {
        type: opts.type,
        limit: Number(opts.limit),
      })
      process.stdout.write(JSON.stringify({ count: hits.length, hits }, null, 2) + '\n')
    } finally {
      db.close()
    }
  })

query
  .command('term <term>')
  .description('Keyword (term-index) lookup.')
  .requiredOption('--db <path>', 'Path to the SQLite file.')
  .option('--type <type>', 'Filter by entity type.')
  .action((term: string, opts: { db: string; type?: string }) => {
    const db = new Database({ path: opts.db, readonly: true })
    try {
      const search = new SearchRepo(db)
      const hits = search.byTerm(term, { type: opts.type })
      process.stdout.write(JSON.stringify({ term, count: hits.length, hits }, null, 2) + '\n')
    } finally {
      db.close()
    }
  })

query
  .command('get <id>')
  .description('Full entity by ID.')
  .requiredOption('--db <path>', 'Path to the SQLite file.')
  .action((id: string, opts: { db: string }) => {
    const db = new Database({ path: opts.db, readonly: true })
    try {
      const entities = new EntityRepo(db)
      const entity = entities.getById(id)
      process.stdout.write(
        JSON.stringify(entity ? { found: true, entity } : { found: false, id }, null, 2) + '\n'
      )
    } finally {
      db.close()
    }
  })

query
  .command('related <id>')
  .description('Edges in both directions for an entity.')
  .requiredOption('--db <path>', 'Path to the SQLite file.')
  .action((id: string, opts: { db: string }) => {
    const db = new Database({ path: opts.db, readonly: true })
    try {
      const edges = new EdgeRepo(db)
      const r = edges.related(id)
      process.stdout.write(JSON.stringify({ id, ...r }, null, 2) + '\n')
    } finally {
      db.close()
    }
  })

program.parseAsync(process.argv).catch((err: unknown) => {
  process.stderr.write(`[kb-ingest] FATAL: ${String(err)}\n`)
  process.exit(1)
})
