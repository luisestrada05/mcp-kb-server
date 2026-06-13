/**
 * Server tools — tested at the boundary between tool registration and the
 * underlying repos. We register tools against an MCP server connected to a
 * pair of in-memory transports, then drive it from a test Client. This proves
 * the tools serialize/deserialize through the protocol exactly as a real
 * agent client would, without needing to spawn a subprocess.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Database } from '../../../src/db/Database.js'
import { runMigrations } from '../../../src/db/migrations.js'
import { EntityRepo } from '../../../src/repos/EntityRepo.js'
import { EdgeRepo } from '../../../src/repos/EdgeRepo.js'
import { SearchRepo } from '../../../src/repos/SearchRepo.js'
import { registerTools } from '../../../src/server/registerTools.js'

interface ToolHits {
  count?: number
  hits?: Array<{ id: string; type: string; name: string; snippet: string }>
  term?: string
}

async function bootKb(allowWrites: boolean): Promise<{
  client: Client
  server: McpServer
  db: Database
  entities: EntityRepo
  edges: EdgeRepo
  search: SearchRepo
}> {
  const db = new Database({ path: ':memory:' })
  runMigrations(db)
  const entities = new EntityRepo(db)
  const edges = new EdgeRepo(db)
  const search = new SearchRepo(db)

  const server = new McpServer({ name: 'test-kb', version: '0.0.0' })
  registerTools(server, { entities, edges, search }, { allowWrites })

  const client = new Client({ name: 'test-client', version: '0.0.0' })
  const [clientT, serverT] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverT), client.connect(clientT)])

  return { client, server, db, entities, edges, search }
}

async function callJson<T>(client: Client, name: string, args: Record<string, unknown>): Promise<T> {
  const result = await client.callTool({ name, arguments: args })
  const content = result.content as Array<{ type: string; text: string }>
  const text = content[0]?.text
  if (!text) {
    throw new Error(`Tool ${name} returned no text content`)
  }
  return JSON.parse(text) as T
}

describe('MCP tools', () => {
  let bootstrap: Awaited<ReturnType<typeof bootKb>>

  beforeEach(async () => {
    bootstrap = await bootKb(false)
    bootstrap.entities.upsertMany([
      {
        id: 'r:diferidos',
        type: 'rule',
        name: 'Reglas de diferidos',
        body: 'Los pagos diferidos no devengan interés bajo promoción vigente.',
        metadata: { severity: 'critical' },
      },
      {
        id: 'r:promos',
        type: 'rule',
        name: 'Promociones bancarias',
        body: 'Promociones MSI requieren autorización del comité.',
      },
      {
        id: 'f:calc',
        type: 'feature',
        name: 'Calculadora de diferidos',
        body: 'Componente para visualizar pagos diferidos por periodo.',
      },
    ])
    bootstrap.edges.upsert({ src: 'f:calc', dst: 'r:diferidos', relation: 'depends_on' })
    bootstrap.edges.upsert({ src: 'r:diferidos', dst: 'r:promos', relation: 'cites' })
    bootstrap.search.addTerms('r:diferidos', ['diferidos', 'msi'])
    bootstrap.search.addTerms('f:calc', ['diferidos'])
  })

  afterEach(() => {
    bootstrap.db.close()
  })

  it('exposes the 5 read tools (no writes by default)', async () => {
    const { tools } = await bootstrap.client.listTools()
    const names = tools.map((t) => t.name).sort()
    expect(names).toEqual(['kb_by_term', 'kb_find', 'kb_get', 'kb_related', 'kb_traverse'])
  })

  it('kb_find runs FTS and returns ranked hits', async () => {
    const result = await callJson<ToolHits>(bootstrap.client, 'kb_find', { query: 'diferidos' })
    expect(result.count).toBe(2)
    const ids = result.hits?.map((h) => h.id).sort()
    expect(ids).toEqual(['f:calc', 'r:diferidos'])
  })

  it('kb_find respects type filter', async () => {
    const result = await callJson<ToolHits>(bootstrap.client, 'kb_find', {
      query: 'diferidos',
      type: 'rule',
    })
    expect(result.hits?.map((h) => h.id)).toEqual(['r:diferidos'])
  })

  it('kb_get returns full body on hit', async () => {
    const result = await callJson<{
      found: boolean
      entity: { name: string; body: string; metadata: Record<string, unknown> }
    }>(bootstrap.client, 'kb_get', { id: 'r:diferidos' })
    expect(result.found).toBe(true)
    expect(result.entity.body).toContain('promoción vigente')
    expect(result.entity.metadata).toEqual({ severity: 'critical' })
  })

  it('kb_get returns found=false for unknown ID', async () => {
    const result = await callJson<{ found: boolean; id: string }>(bootstrap.client, 'kb_get', {
      id: 'ghost',
    })
    expect(result.found).toBe(false)
    expect(result.id).toBe('ghost')
  })

  it('kb_by_term resolves a keyword to tagged entities', async () => {
    const result = await callJson<ToolHits>(bootstrap.client, 'kb_by_term', { term: 'diferidos' })
    expect(result.count).toBe(2)
    expect(result.term).toBe('diferidos')
  })

  it('kb_traverse BFSs from a start node with default depth=1', async () => {
    const result = await callJson<{
      count: number
      results: Array<{ entity: { id: string }; depth: number; relation: string | null }>
    }>(bootstrap.client, 'kb_traverse', { id: 'f:calc' })
    expect(result.count).toBe(2) // start + 1 neighbor at depth 1
    expect(result.results[0]?.entity.id).toBe('f:calc')
    expect(result.results[1]?.entity.id).toBe('r:diferidos')
    expect(result.results[1]?.relation).toBe('depends_on')
  })

  it('kb_traverse with relation filter and deeper maxDepth', async () => {
    const result = await callJson<{
      count: number
      results: Array<{ entity: { id: string }; depth: number }>
    }>(bootstrap.client, 'kb_traverse', { id: 'r:diferidos', relation: 'cites', maxDepth: 3 })
    expect(result.count).toBe(2)
    expect(result.results.map((r) => r.entity.id)).toEqual(['r:diferidos', 'r:promos'])
  })

  it('kb_related returns both directions', async () => {
    const result = await callJson<{
      outgoingCount: number
      incomingCount: number
      outgoing: Array<{ dst: string }>
      incoming: Array<{ src: string }>
    }>(bootstrap.client, 'kb_related', { id: 'r:diferidos' })
    expect(result.outgoingCount).toBe(1)
    expect(result.incomingCount).toBe(1)
    expect(result.outgoing[0]?.dst).toBe('r:promos')
    expect(result.incoming[0]?.src).toBe('f:calc')
  })

  it('input validation surfaces empty-string args as isError', async () => {
    const findResult = await bootstrap.client.callTool({
      name: 'kb_find',
      arguments: { query: '' },
    })
    expect(findResult.isError).toBe(true)

    const getResult = await bootstrap.client.callTool({
      name: 'kb_get',
      arguments: { id: '' },
    })
    expect(getResult.isError).toBe(true)
  })
})

describe('MCP write tools', () => {
  it('write tools are NOT registered by default', async () => {
    const b = await bootKb(false)
    try {
      const { tools } = await b.client.listTools()
      expect(tools.find((t) => t.name === 'kb_add_entity')).toBeUndefined()
      expect(tools.find((t) => t.name === 'kb_add_edge')).toBeUndefined()
    } finally {
      b.db.close()
    }
  })

  it('kb_add_entity upserts and kb_add_edge wires when allowWrites=true', async () => {
    const b = await bootKb(true)
    try {
      const { tools } = await b.client.listTools()
      expect(tools.map((t) => t.name).sort()).toContain('kb_add_entity')
      expect(tools.map((t) => t.name).sort()).toContain('kb_add_edge')

      const add1 = await callJson<{ upserted: boolean }>(b.client, 'kb_add_entity', {
        id: 'x:1',
        type: 'note',
        name: 'first',
        body: 'hello',
      })
      expect(add1.upserted).toBe(true)
      expect(b.entities.getById('x:1')?.name).toBe('first')

      // Edge with missing endpoint returns isError and a structured hint.
      const bad = await b.client.callTool({
        name: 'kb_add_edge',
        arguments: { src: 'x:1', dst: 'ghost', relation: 'cites' },
      })
      expect(bad.isError).toBe(true)

      await callJson(b.client, 'kb_add_entity', { id: 'x:2', type: 'note', name: 'second' })
      const good = await callJson<{ upserted: boolean }>(b.client, 'kb_add_edge', {
        src: 'x:1',
        dst: 'x:2',
        relation: 'cites',
      })
      expect(good.upserted).toBe(true)
    } finally {
      b.db.close()
    }
  })
})
