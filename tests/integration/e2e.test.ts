/**
 * End-to-end integration test.
 *
 * Exercises the full pipeline using the real `examples/minimal-kb/` markdown
 * + ingestion plugin:
 *
 *   1. Run the example plugin against a temp SQLite DB.
 *   2. Boot the MCP server pointed at that DB (in-process via InMemoryTransport).
 *   3. Connect an MCP client.
 *   4. Call every tool and verify the results match the markdown content.
 *
 * This is the only test that depends on the example assets — it doubles as a
 * regression test for the example whenever we touch the plugin contract.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, copyFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Database } from '../../src/db/Database.js'
import { runMigrations } from '../../src/db/migrations.js'
import { EntityRepo } from '../../src/repos/EntityRepo.js'
import { EdgeRepo } from '../../src/repos/EdgeRepo.js'
import { SearchRepo } from '../../src/repos/SearchRepo.js'
import { registerTools } from '../../src/server/registerTools.js'
import { runIngest } from '../../src/cli/runIngest.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const REPO_ROOT = join(__dirname, '..', '..')
const EXAMPLE_DIR = join(REPO_ROOT, 'examples', 'minimal-kb')

async function callJson<T>(client: Client, name: string, args: Record<string, unknown>): Promise<T> {
  const result = await client.callTool({ name, arguments: args })
  const content = result.content as Array<{ type: string; text: string }>
  return JSON.parse(content[0]!.text) as T
}

describe('integration: minimal-kb → MCP → tools', () => {
  let tmp: string
  let dbPath: string
  let client: Client
  let db: Database

  beforeAll(async () => {
    // 1. Copy the example markdown into a temp dir so the test is fully
    //    hermetic (won't pollute the repo example dir with kb.db).
    tmp = mkdtempSync(join(tmpdir(), 'kb-e2e-'))
    const docsDst = join(tmp, 'docs')
    mkdirSync(join(docsDst, 'rules'), { recursive: true })
    mkdirSync(join(docsDst, 'features'), { recursive: true })
    copyFileSync(join(EXAMPLE_DIR, 'docs', 'rules', 'diferidos.md'), join(docsDst, 'rules', 'diferidos.md'))
    copyFileSync(
      join(EXAMPLE_DIR, 'docs', 'rules', 'promociones.md'),
      join(docsDst, 'rules', 'promociones.md')
    )
    copyFileSync(
      join(EXAMPLE_DIR, 'docs', 'features', 'calculadora-diferidos.md'),
      join(docsDst, 'features', 'calculadora-diferidos.md')
    )
    dbPath = join(tmp, 'kb.db')

    // 2. Run the real example plugin against the temp DB.
    const result = await runIngest({
      dbPath,
      pluginPath: join(EXAMPLE_DIR, 'ingest.mjs'),
      pluginOptions: { root: docsDst },
      logger: () => undefined,
    })
    expect(result.entitiesAfter).toBe(3)
    expect(result.edgesAfter).toBeGreaterThan(0)

    // 3. Open the DB read-only and boot the in-process MCP server.
    db = new Database({ path: dbPath })
    runMigrations(db)
    const entities = new EntityRepo(db)
    const edges = new EdgeRepo(db)
    const search = new SearchRepo(db)

    const server = new McpServer({ name: 'e2e-kb', version: '0.0.0' })
    registerTools(server, { entities, edges, search }, { allowWrites: false })

    client = new Client({ name: 'e2e-client', version: '0.0.0' })
    const [clientT, serverT] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverT), client.connect(clientT)])
  })

  afterAll(() => {
    db.close()
    rmSync(tmp, { recursive: true, force: true })
  })

  it('ingestion seeded all 3 entities with the expected types', async () => {
    const diferidos = await callJson<{ found: boolean; entity: { type: string; metadata: Record<string, unknown> } }>(
      client,
      'kb_get',
      { id: 'rule:diferidos' }
    )
    expect(diferidos.found).toBe(true)
    expect(diferidos.entity.type).toBe('rule')
    expect(diferidos.entity.metadata.severity).toBe('critical')

    const feature = await callJson<{ found: boolean; entity: { type: string } }>(client, 'kb_get', {
      id: 'feature:calc-diferidos',
    })
    expect(feature.found).toBe(true)
    expect(feature.entity.type).toBe('feature')
  })

  it('kb_by_term resolves "diferidos" to both tagged entities', async () => {
    const r = await callJson<{ count: number; hits: Array<{ id: string }> }>(client, 'kb_by_term', {
      term: 'diferidos',
    })
    const ids = r.hits.map((h) => h.id).sort()
    // The rule and the feature both have `diferidos` in their `terms:` array.
    expect(ids).toContain('rule:diferidos')
    expect(ids).toContain('feature:calc-diferidos')
  })

  it('kb_by_term is case-insensitive', async () => {
    const lower = await callJson<{ count: number }>(client, 'kb_by_term', { term: 'diferidos' })
    const upper = await callJson<{ count: number }>(client, 'kb_by_term', { term: 'DIFERIDOS' })
    expect(lower.count).toBe(upper.count)
  })

  it('kb_find returns ranked hits with a snippet', async () => {
    const r = await callJson<{
      count: number
      hits: Array<{ id: string; rank?: number; snippet: string }>
    }>(client, 'kb_find', { query: 'comite OR comité' })
    // `comité` only appears in the promociones rule body.
    expect(r.hits.find((h) => h.id === 'rule:promociones')).toBeDefined()
  })

  it('kb_traverse from feature reaches both rules via depends_on', async () => {
    const r = await callJson<{
      count: number
      results: Array<{ entity: { id: string }; depth: number }>
    }>(client, 'kb_traverse', { id: 'feature:calc-diferidos', relation: 'depends_on', maxDepth: 2 })

    const ids = r.results.map((x) => x.entity.id)
    expect(ids).toContain('feature:calc-diferidos')
    expect(ids).toContain('rule:diferidos')
    expect(ids).toContain('rule:promociones')
  })

  it('kb_related shows incoming feature edge on rule:diferidos', async () => {
    const r = await callJson<{
      incoming: Array<{ src: string; relation: string }>
      outgoing: Array<{ dst: string; relation: string }>
    }>(client, 'kb_related', { id: 'rule:diferidos' })

    // Feature depends_on rule:diferidos → that shows up as incoming.
    expect(r.incoming.find((e) => e.src === 'feature:calc-diferidos' && e.relation === 'depends_on')).toBeDefined()
  })

  it('FTS5 phrase search works against the example body', async () => {
    const r = await callJson<{ hits: Array<{ id: string }> }>(client, 'kb_find', {
      query: '"meses sin intereses"',
    })
    // Both rules talk about MSI in their body.
    expect(r.hits.length).toBeGreaterThan(0)
  })
})
