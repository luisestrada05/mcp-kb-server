/**
 * Integration test for the `rules-kb-template` example.
 *
 * Runs the real example plugin against a temp DB, then asserts the dual
 * source contract (docs/ markdown + manifests/ JSON) produces the cross-
 * domain graph that DevFlow specify/plan rely on.
 *
 * Doubles as a regression guard: any change to the template plugin that
 * breaks the rule↔component bridge fails CI before it reaches consumers.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, copyFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Database } from '../../src/db/Database.js'
import { runMigrations } from '../../src/db/migrations.js'
import { EntityRepo } from '../../src/repos/EntityRepo.js'
import { EdgeRepo } from '../../src/repos/EdgeRepo.js'
import { SearchRepo } from '../../src/repos/SearchRepo.js'
import { runIngest } from '../../src/cli/runIngest.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const REPO_ROOT = join(__dirname, '..', '..')
const TEMPLATE_DIR = join(REPO_ROOT, 'examples', 'rules-kb-template')

describe('integration: rules-kb-template', () => {
  let tmp: string
  let dbPath: string
  let db: Database
  let entities: EntityRepo
  let edges: EdgeRepo
  let search: SearchRepo

  beforeAll(async () => {
    // Mirror the template into a temp dir so the test never writes to the
    // checked-in example folder. Copy both docs/ and manifests/.
    tmp = mkdtempSync(join(tmpdir(), 'kb-tmpl-'))
    mkdirSync(join(tmp, 'docs', 'rules'), { recursive: true })
    mkdirSync(join(tmp, 'docs', 'decisions'), { recursive: true })
    mkdirSync(join(tmp, 'docs', 'terms'), { recursive: true })
    mkdirSync(join(tmp, 'manifests'), { recursive: true })

    copyFileSync(
      join(TEMPLATE_DIR, 'docs', 'rules', 'tasa-interes.md'),
      join(tmp, 'docs', 'rules', 'tasa-interes.md')
    )
    copyFileSync(
      join(TEMPLATE_DIR, 'docs', 'rules', 'plazos.md'),
      join(tmp, 'docs', 'rules', 'plazos.md')
    )
    copyFileSync(
      join(TEMPLATE_DIR, 'docs', 'decisions', '0001-tasa-base-360.md'),
      join(tmp, 'docs', 'decisions', '0001-tasa-base-360.md')
    )
    copyFileSync(
      join(TEMPLATE_DIR, 'docs', 'terms', 'tasa-ordinaria.md'),
      join(tmp, 'docs', 'terms', 'tasa-ordinaria.md')
    )
    copyFileSync(
      join(TEMPLATE_DIR, 'manifests', 'components.json'),
      join(tmp, 'manifests', 'components.json')
    )
    copyFileSync(
      join(TEMPLATE_DIR, 'manifests', 'endpoints.json'),
      join(tmp, 'manifests', 'endpoints.json')
    )
    copyFileSync(
      join(TEMPLATE_DIR, 'manifests', 'modules.json'),
      join(tmp, 'manifests', 'modules.json')
    )

    dbPath = join(tmp, 'kb.db')

    const result = await runIngest({
      dbPath,
      pluginPath: join(TEMPLATE_DIR, 'ingest.mjs'),
      pluginOptions: { root: tmp },
      logger: () => undefined,
    })

    // Sanity: 3 components + 2 endpoints + 1 module + 2 rules + 1 decision + 1 term = 10
    expect(result.entitiesAfter).toBe(10)
    expect(result.edgesAfter).toBeGreaterThan(10)

    db = new Database({ path: dbPath })
    runMigrations(db)
    entities = new EntityRepo(db)
    edges = new EdgeRepo(db)
    search = new SearchRepo(db)
  })

  afterAll(() => {
    db.close()
    rmSync(tmp, { recursive: true, force: true })
  })

  it('produces all 7 entity types from the dual source', () => {
    expect(entities.count('rule')).toBe(2)
    expect(entities.count('decision')).toBe(1)
    expect(entities.count('term')).toBe(1)
    expect(entities.count('component')).toBe(3)
    expect(entities.count('endpoint')).toBe(2)
    expect(entities.count('module')).toBe(1)
  })

  it('exposes manifest metadata (e.g. path) on technical entities', () => {
    const c = entities.getById('component:InterestRateInput')
    expect(c).not.toBeNull()
    expect(c?.type).toBe('component')
    expect(c?.metadata.path).toBe(
      'src/features/credits/components/InterestRateInput.tsx'
    )
    expect(c?.metadata.owner).toBe('frontend')
  })

  describe('cross-domain bridge (the DevFlow specify ↔ plan value)', () => {
    it('rule:tasa-interes has incoming edges from components AND endpoints', () => {
      const r = edges.related('rule:tasa-interes')
      const incomingSrcs = r.incoming.map((e) => e.src).sort()
      // The rule is implemented by InterestRateInput, applied by CreditCalculator
      // (component) and credits.calculate (endpoint), and cited by adr-0001.
      expect(incomingSrcs).toContain('component:InterestRateInput')
      expect(incomingSrcs).toContain('component:CreditCalculator')
      expect(incomingSrcs).toContain('endpoint:credits.calculate')
      expect(incomingSrcs).toContain('decision:adr-0001')
    })

    it('"implements" relation only fires from component → rule', () => {
      const implementsEdges = edges
        .incoming('rule:tasa-interes', 'implements')
        .map((e) => e.src)
      expect(implementsEdges).toEqual(['component:InterestRateInput'])
    })

    it('"applies" can fire from either component or endpoint → rule', () => {
      const appliesEdges = edges
        .incoming('rule:tasa-interes', 'applies')
        .map((e) => e.src)
        .sort()
      expect(appliesEdges).toEqual([
        'component:CreditCalculator',
        'endpoint:credits.calculate',
      ])
    })

    it('module exposes endpoints (the technical-only bridge)', () => {
      const moduleExposes = edges.outgoing('module:credits', 'exposes').map((e) => e.dst).sort()
      expect(moduleExposes).toEqual(['endpoint:credits.calculate', 'endpoint:credits.create'])
    })
  })

  describe('term index spans both sources', () => {
    it('a markdown-sourced term ("tasa") resolves to its entities', () => {
      const hits = search.byTerm('tasa').map((h) => h.id)
      expect(hits).toContain('rule:tasa-interes')
    })

    it('a manifest-sourced term ("input") resolves to its component', () => {
      const hits = search.byTerm('input').map((h) => h.id)
      expect(hits).toContain('component:InterestRateInput')
    })

    it('term lookup is case-insensitive across sources', () => {
      const lower = search.byTerm('input').length
      const upper = search.byTerm('INPUT').length
      expect(lower).toBe(upper)
      expect(lower).toBeGreaterThan(0)
    })
  })

  describe('FTS spans both narrative bodies and manifest descriptions', () => {
    it('finds a manifest body match (component description)', () => {
      const hits = search.fullText('amortización')
      const ids = hits.map((h) => h.id)
      expect(ids).toContain('component:CreditCalculator')
    })

    it('finds across rule body and decision body in one query', () => {
      const hits = search.fullText('base 360')
      const ids = hits.map((h) => h.id).sort()
      expect(ids).toContain('decision:adr-0001')
      expect(ids).toContain('rule:tasa-interes')
    })
  })

  describe('orphan-edge resilience', () => {
    it('drops the deliberate supersedes-to-nowhere edge silently', () => {
      // The ADR frontmatter says `supersedes: rule:tasa-vieja-base-365` but that
      // entity is not in the corpus. The plugin must drop the edge instead of
      // crashing or creating a dangling reference.
      const out = edges.outgoing('decision:adr-0001').map((e) => e.dst).sort()
      expect(out).not.toContain('rule:tasa-vieja-base-365')
      // …but the live edges from that ADR are preserved:
      expect(out).toContain('rule:tasa-interes')
      expect(out).toContain('term:tasa-ordinaria')
    })
  })

  describe('docs-only or manifests-only projects also work', () => {
    it('ingests cleanly when only docs/ is present', async () => {
      const tmp2 = mkdtempSync(join(tmpdir(), 'kb-docs-only-'))
      try {
        mkdirSync(join(tmp2, 'docs', 'rules'), { recursive: true })
        copyFileSync(
          join(TEMPLATE_DIR, 'docs', 'rules', 'plazos.md'),
          join(tmp2, 'docs', 'rules', 'plazos.md')
        )
        const dbOnly = join(tmp2, 'kb.db')
        const r = await runIngest({
          dbPath: dbOnly,
          pluginPath: join(TEMPLATE_DIR, 'ingest.mjs'),
          pluginOptions: { root: tmp2 },
          logger: () => undefined,
        })
        expect(r.entitiesAfter).toBe(1)
      } finally {
        rmSync(tmp2, { recursive: true, force: true })
      }
    })

    it('ingests cleanly when only manifests/ is present', async () => {
      const tmp3 = mkdtempSync(join(tmpdir(), 'kb-manifests-only-'))
      try {
        mkdirSync(join(tmp3, 'manifests'), { recursive: true })
        copyFileSync(
          join(TEMPLATE_DIR, 'manifests', 'modules.json'),
          join(tmp3, 'manifests', 'modules.json')
        )
        const dbOnly = join(tmp3, 'kb.db')
        const r = await runIngest({
          dbPath: dbOnly,
          pluginPath: join(TEMPLATE_DIR, 'ingest.mjs'),
          pluginOptions: { root: tmp3 },
          logger: () => undefined,
        })
        expect(r.entitiesAfter).toBe(1)
        // The module's `exposes` edges point at endpoints that aren't in this
        // smaller corpus, so they should be dropped — but the module itself
        // lands cleanly.
      } finally {
        rmSync(tmp3, { recursive: true, force: true })
      }
    })
  })
})
