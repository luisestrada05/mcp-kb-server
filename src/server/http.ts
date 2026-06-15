#!/usr/bin/env node
/**
 * HTTP-based MCP server entry point — centralized mode.
 *
 * Unlike the stdio transport (1 process per client), this serves multiple
 * concurrent clients over Streamable HTTP. Each client gets its own MCP
 * session backed by the same shared SQLite database.
 *
 * Config via env vars:
 *   KB_DB_PATH         (required) absolute path to the SQLite file
 *   KB_ALLOW_WRITES    (optional) "1" to enable kb_add_entity / kb_add_edge
 *   KB_MIGRATIONS_DIR  (optional) override the bundled migrations dir
 *   KB_PORT            (optional) HTTP port, defaults to 3001
 */
import { randomUUID } from 'node:crypto'
import type { Request, Response } from 'express'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { Database } from '../db/Database.js'
import { runMigrations } from '../db/migrations.js'
import { EntityRepo } from '../repos/EntityRepo.js'
import { EdgeRepo } from '../repos/EdgeRepo.js'
import { SearchRepo } from '../repos/SearchRepo.js'
import { registerTools } from './registerTools.js'

// ── config ──────────────────────────────────────────────────────────────────
const dbPath = process.env.KB_DB_PATH
if (!dbPath) {
  process.stderr.write(
    '[kb-mcp-http] FATAL: KB_DB_PATH env var is required. See README for setup.\n'
  )
  process.exit(1)
}

const allowWrites = process.env.KB_ALLOW_WRITES === '1'
const port = parseInt(process.env.KB_PORT ?? '3001', 10)

// ── database (shared across all sessions) ───────────────────────────────────
const db = new Database({ path: dbPath })
runMigrations(db, process.env.KB_MIGRATIONS_DIR)

const repos = {
  entities: new EntityRepo(db),
  edges: new EdgeRepo(db),
  search: new SearchRepo(db),
}

// ── per-session MCP server factory ──────────────────────────────────────────
function createSessionServer(): McpServer {
  const server = new McpServer({
    name: '@kb/mcp-server',
    version: '0.1.0',
  })
  registerTools(server, repos, { allowWrites })
  return server
}

// ── HTTP app ────────────────────────────────────────────────────────────────
const app = createMcpExpressApp()

// Active transports keyed by session ID
const transports: Record<string, StreamableHTTPServerTransport> = {}

// GET /health — liveness probe for container orchestrators. Intentionally
// trivial: confirms the process is up and the HTTP listener is responsive.
// A "deep" check that hits the DB would couple liveness to readiness and
// cause restart loops on transient SQLite contention.
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok' })
})

// POST /mcp — handles JSON-RPC requests (init + tool calls)
app.post('/mcp', async (req: Request, res: Response) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined

  try {
    let transport: StreamableHTTPServerTransport

    if (sessionId && transports[sessionId]) {
      // Existing session
      transport = transports[sessionId]
    } else if (!sessionId && isInitializeRequest(req.body)) {
      // New session
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid: string) => {
          transports[sid] = transport
          process.stderr.write(`[kb-mcp-http] session created: ${sid}\n`)
        },
      })

      transport.onclose = () => {
        const sid = transport.sessionId
        if (sid && transports[sid]) {
          delete transports[sid]
          process.stderr.write(`[kb-mcp-http] session closed: ${sid}\n`)
        }
      }

      const server = createSessionServer()
      await server.connect(transport)
      await transport.handleRequest(req, res, req.body)
      return
    } else {
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Bad Request: No valid session ID' },
        id: null,
      })
      return
    }

    await transport.handleRequest(req, res, req.body)
  } catch (error) {
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      })
    }
  }
})

// GET /mcp — SSE stream for server-initiated messages
app.get('/mcp', async (req: Request, res: Response) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined
  if (!sessionId || !transports[sessionId]) {
    res.status(400).send('Invalid or missing session ID')
    return
  }
  await transports[sessionId].handleRequest(req, res)
})

// DELETE /mcp — session termination
app.delete('/mcp', async (req: Request, res: Response) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined
  if (!sessionId || !transports[sessionId]) {
    res.status(400).send('Invalid or missing session ID')
    return
  }
  await transports[sessionId].handleRequest(req, res)
})

// ── start ───────────────────────────────────────────────────────────────────
app.listen(port, () => {
  process.stderr.write(
    `[kb-mcp-http] listening on http://0.0.0.0:${port}/mcp  (writes ${allowWrites ? 'ON' : 'OFF'})\n`
  )
})

// ── cleanup ─────────────────────────────────────────────────────────────────
const shutdown = async (): Promise<void> => {
  process.stderr.write('[kb-mcp-http] shutting down...\n')
  for (const sid of Object.keys(transports)) {
    try {
      await transports[sid]?.close()
    } catch { /* best effort */ }
    delete transports[sid]
  }
  db.close()
  process.exit(0)
}
process.on('SIGTERM', () => { void shutdown() })
process.on('SIGINT', () => { void shutdown() })
