#!/usr/bin/env node
/**
 * MCP server entry point. Run via stdio (the standard MCP transport).
 *
 * Config via env vars (consumed at startup):
 *   KB_DB_PATH         (required) absolute path to the SQLite file
 *   KB_ALLOW_WRITES    (optional) "1" to enable kb_add_entity / kb_add_edge
 *   KB_MIGRATIONS_DIR  (optional) override the bundled migrations dir
 *
 * Consumers wire this into `.mcp.json` like:
 *
 *   {
 *     "mcpServers": {
 *       "kb": {
 *         "command": "kb-mcp",
 *         "env": { "KB_DB_PATH": "/abs/path/to/kb.db" }
 *       }
 *     }
 *   }
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { Database } from '../db/Database.js'
import { runMigrations } from '../db/migrations.js'
import { EntityRepo } from '../repos/EntityRepo.js'
import { EdgeRepo } from '../repos/EdgeRepo.js'
import { SearchRepo } from '../repos/SearchRepo.js'
import { registerTools } from './registerTools.js'

async function main(): Promise<void> {
  const dbPath = process.env.KB_DB_PATH
  if (!dbPath) {
    process.stderr.write(
      '[kb-mcp] FATAL: KB_DB_PATH env var is required. See README for setup.\n'
    )
    process.exit(1)
  }

  const allowWrites = process.env.KB_ALLOW_WRITES === '1'

  const db = new Database({ path: dbPath })
  runMigrations(db, process.env.KB_MIGRATIONS_DIR)

  const repos = {
    entities: new EntityRepo(db),
    edges: new EdgeRepo(db),
    search: new SearchRepo(db),
  }

  const server = new McpServer({
    name: '@kb/mcp-server',
    version: '0.1.0',
  })

  registerTools(server, repos, { allowWrites })

  const transport = new StdioServerTransport()
  await server.connect(transport)

  // Best-effort cleanup on signals. The transport will already have closed
  // by the time we get SIGTERM/SIGINT, but the DB handle would otherwise leak.
  const shutdown = (): void => {
    db.close()
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

main().catch((err: unknown) => {
  process.stderr.write(`[kb-mcp] FATAL: ${String(err)}\n`)
  process.exit(1)
})
