import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from '../../../src/db/Database.js'
import { EntityRepo } from '../../../src/repos/EntityRepo.js'
import { SearchRepo } from '../../../src/repos/SearchRepo.js'
import { runIngest } from '../../../src/cli/runIngest.js'

/**
 * runIngest needs to dynamic-import a plugin from a real file on disk (the
 * whole point of the plugin contract is per-project files). We write the
 * plugin under a temp dir, then point runIngest at it.
 *
 * Plugins are emitted as plain ESM (.mjs) — no TS compile needed — so the
 * test stays close to what a real consumer would write.
 */
describe('runIngest', () => {
  let tmp: string
  let dbPath: string
  let logs: string[]

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kb-runingest-'))
    dbPath = join(tmp, 'kb.db')
    logs = []
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('runs a basic plugin that writes entities, edges, and terms', async () => {
    const pluginPath = join(tmp, 'plugin.mjs')
    writeFileSync(
      pluginPath,
      `
        export default {
          name: 'sample-ingestion',
          async run(ctx) {
            ctx.entities.upsertMany([
              { id: 'r:a', type: 'rule', name: 'Rule A', body: 'About diferidos.' },
              { id: 'r:b', type: 'rule', name: 'Rule B', body: 'About promociones.' },
              { id: 'f:1', type: 'feature', name: 'Feature 1' },
            ])
            ctx.edges.upsertMany([
              { src: 'f:1', dst: 'r:a', relation: 'depends_on' },
              { src: 'r:a', dst: 'r:b', relation: 'cites' },
            ])
            ctx.search.addTerms('r:a', ['diferidos'])
            ctx.search.addTerms('f:1', ['diferidos'])
            ctx.log('plugin done')
          },
        }
      `
    )

    const result = await runIngest({
      dbPath,
      pluginPath,
      logger: (msg) => logs.push(msg),
    })

    expect(result.plugin).toBe('sample-ingestion')
    expect(result.entitiesBefore).toBe(0)
    expect(result.entitiesAfter).toBe(3)
    expect(result.edgesBefore).toBe(0)
    expect(result.edgesAfter).toBe(2)
    expect(logs.some((m) => m.includes('plugin done'))).toBe(true)

    // Verify data persisted by re-opening the DB.
    const db = new Database({ path: dbPath, readonly: true })
    try {
      const entities = new EntityRepo(db)
      const search = new SearchRepo(db)
      expect(entities.count()).toBe(3)
      expect(search.byTerm('diferidos').map((h) => h.id).sort()).toEqual(['f:1', 'r:a'])
    } finally {
      db.close()
    }
  })

  it('forwards pluginOptions through ctx.options', async () => {
    const pluginPath = join(tmp, 'plugin.mjs')
    writeFileSync(
      pluginPath,
      `
        export default {
          name: 'options-plugin',
          run(ctx) {
            ctx.entities.upsert({
              id: 'cfg',
              type: 'config',
              name: 'opts',
              metadata: ctx.options,
            })
          },
        }
      `
    )

    await runIngest({
      dbPath,
      pluginPath,
      pluginOptions: { root: '/some/path', maxDepth: 3, dryRun: true },
      logger: (msg) => logs.push(msg),
    })

    const db = new Database({ path: dbPath, readonly: true })
    try {
      const entities = new EntityRepo(db)
      const cfg = entities.getById('cfg')
      expect(cfg?.metadata).toEqual({ root: '/some/path', maxDepth: 3, dryRun: true })
    } finally {
      db.close()
    }
  })

  it('accepts factory-style default export', async () => {
    const pluginPath = join(tmp, 'plugin.mjs')
    writeFileSync(
      pluginPath,
      `
        export default function makePlugin() {
          return {
            name: 'factory-style',
            run(ctx) { ctx.entities.upsert({ id: 'x', type: 't', name: 'X' }) },
          }
        }
      `
    )

    const result = await runIngest({
      dbPath,
      pluginPath,
      logger: (msg) => logs.push(msg),
    })
    expect(result.plugin).toBe('factory-style')
    expect(result.entitiesAfter).toBe(1)
  })

  it('propagates plugin errors and closes the DB', async () => {
    const pluginPath = join(tmp, 'plugin.mjs')
    writeFileSync(
      pluginPath,
      `
        export default {
          name: 'broken',
          run() { throw new Error('boom') },
        }
      `
    )

    await expect(
      runIngest({ dbPath, pluginPath, logger: (msg) => logs.push(msg) })
    ).rejects.toThrow(/boom/)

    // DB should still be re-openable (finally block closed the handle).
    const db = new Database({ path: dbPath, readonly: true })
    db.close()
  })

  it('rejects ingestion when plugin path does not exist', async () => {
    await expect(
      runIngest({
        dbPath,
        pluginPath: join(tmp, 'missing.mjs'),
        logger: (msg) => logs.push(msg),
      })
    ).rejects.toThrow()
  })

  it('re-running the same plugin is idempotent (upsert semantics)', async () => {
    const pluginPath = join(tmp, 'plugin.mjs')
    writeFileSync(
      pluginPath,
      `
        export default {
          name: 'idem',
          run(ctx) {
            ctx.entities.upsert({ id: 'r:1', type: 'rule', name: 'one' })
          },
        }
      `
    )
    const r1 = await runIngest({ dbPath, pluginPath, logger: () => undefined })
    const r2 = await runIngest({ dbPath, pluginPath, logger: () => undefined })
    expect(r1.entitiesAfter).toBe(1)
    expect(r2.entitiesAfter).toBe(1)
  })
})
