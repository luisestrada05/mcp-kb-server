/**
 * Ingestion of a content repo's sources into the graph: business rule YAMLs,
 * decision notes, technical standards and lessons. Each business's plugin
 * only supplies its conventions (where the notes live, how to summarize one)
 * and calls these.
 *
 *   Entity types: rule | exception | gap | sla | decision | standard | lesson
 *                 | precedent | repo
 *                 + table | stored_procedure | code  (objects a rule touches)
 *   Relations:    overrides | justified_by | uses_table | uses_sp | uses_code
 *                 | resolved_by | concerns_rule | involves_code  (lessons)
 *                 | located_in  (catalog: object → repo)
 *                 | verified_in | applies_rule  (precedents)
 *
 * The point of embedding a decision's summary INTO the rule (body + metadata)
 * is that `kb_get rule:X` answers "why" and "what it does not mean" without
 * the agent having to remember a second lookup.
 */
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import yaml from 'js-yaml'
import type { IngestionContext } from '../cli/plugin.js'
import type { Note } from './notes.js'
import type { StandardFile } from './standards.js'
import type { LessonFile } from './lessons.js'
import type { CatalogFile } from './catalog.js'
import type { PrecedentFile } from './precedents.js'

/** What travels inside a rule or standard that cites a decision. */
export interface DecisionSummary {
  id: string
  status: string | null
  /** One-paragraph reason; the business's own wording. */
  why: string | null
  /** Known misreadings — the part that stops a newcomer repeating an error. */
  noSignifica: string[]
  validatedBy: string | null
}

export type Summarize = (note: Note) => DecisionSummary

interface RuleCondition {
  field?: string
  op?: string
  value?: unknown
}

interface RuleEntry {
  id?: string
  type?: string
  subdomain?: string
  summary?: string
  applicability?: { evento?: string[]; actor?: string[] }
  formal_rule?: { conditions?: RuleCondition[]; action?: string; overrides?: string }
  source_ref?: string
  owner?: string
  status?: string
  risk_note?: string
  decision?: string
  /** Misreadings recorded on the rule itself, for rules with no decision note. */
  no_significa?: string[]
  related_objects?: { tables?: string[]; sps?: string[]; code?: string[] }
}

const relationTypes = {
  tables: { prefix: 'table', type: 'table', relation: 'uses_table', label: 'Tabla' },
  sps: { prefix: 'sp', type: 'stored_procedure', relation: 'uses_sp', label: 'Stored procedure' },
  code: { prefix: 'code', type: 'code', relation: 'uses_code', label: 'Código' },
} as const

function buildRuleBody(rule: RuleEntry, why: DecisionSummary | null): string {
  const parts = [rule.summary ?? '']
  if (why?.why) parts.push(`Por qué: ${why.why}`)
  for (const item of [...(why?.noSignifica ?? []), ...(rule.no_significa ?? [])]) {
    parts.push(`No significa: ${item}`)
  }
  if (rule.risk_note) parts.push(`Riesgo: ${rule.risk_note}`)
  if (rule.formal_rule?.action) parts.push(`Acción: ${rule.formal_rule.action}`)
  for (const c of rule.formal_rule?.conditions ?? []) {
    parts.push(`${c.field} ${c.op} ${JSON.stringify(c.value)}`)
  }
  if (rule.source_ref) parts.push(`Fuente: ${rule.source_ref}`)
  if (why) parts.push(`Decisión: ${why.id} (${why.status ?? 'sin estado'})`)
  return parts.join('\n')
}

/**
 * The decision as metadata carries only its identity: its why and its
 * "No significa" are already in the body, and repeating them in metadata
 * doubled what every `kb_get` cost in tokens.
 */
function decisionRef(
  why: DecisionSummary | null
): Pick<DecisionSummary, 'id' | 'status' | 'validatedBy'> | null {
  return why ? { id: why.id, status: why.status, validatedBy: why.validatedBy } : null
}

/**
 * `path/file.py::Symbol` → ["symbol", "file", "file.py", "path/file.py",
 * "path/file.py::symbol"], so a lookup by the symbol, the module, the file name
 * or the path an agent is editing all hit.
 */
function codeTerms(ref: string): string[] {
  const [file, symbol] = ref.split('::')
  const terms: string[] = []
  if (symbol) terms.push(symbol.toLowerCase())
  if (file) {
    const name = basename(file).toLowerCase()
    terms.push(name.replace(/\.[^.]+$/, ''), name, file.toLowerCase())
  }
  if (file && symbol) terms.push(`${file}::${symbol}`.toLowerCase())
  return [...new Set(terms)]
}

function ruleTerms(rule: RuleEntry, domain: string): string[] {
  const terms = new Set<string>([domain])
  if (rule.subdomain) terms.add(rule.subdomain)
  if (rule.id) terms.add(rule.id.toLowerCase())
  if (rule.decision) terms.add(rule.decision.toLowerCase())
  for (const e of rule.applicability?.evento ?? []) terms.add(e)
  for (const t of rule.related_objects?.tables ?? []) terms.add(t.toLowerCase())
  for (const sp of rule.related_objects?.sps ?? []) terms.add(sp.toLowerCase())
  for (const ref of rule.related_objects?.code ?? []) {
    for (const term of codeTerms(ref)) terms.add(term)
  }
  for (const word of (rule.summary ?? '').toLowerCase().split(/[\s—,;:()]+/)) {
    if (word.length > 4) terms.add(word)
  }
  return [...terms].filter(Boolean)
}

/** Decision notes become `decision:<id>` entities. Returns how many. */
export function ingestDecisionNotes(
  ctx: IngestionContext,
  notes: Map<string, Note>,
  opts: { summarize: Summarize; domain?: (note: Note) => string | null }
): number {
  for (const note of notes.values()) {
    const summary = opts.summarize(note)
    const entityId = `decision:${summary.id}`
    const domain = opts.domain?.(note) ?? (note.frontmatter.domain as string | undefined) ?? null
    ctx.entities.upsert({
      id: entityId,
      type: 'decision',
      name: note.title.startsWith(summary.id) ? note.title : `[${summary.id}] ${note.title}`,
      body: note.content,
      // Metadata stays short and structured: the body already carries the full text.
      metadata: { ...note.frontmatter, domain },
      sourcePath: note.file,
    })
    ctx.search.clearTerms(entityId)
    ctx.search.addTerms(
      entityId,
      [summary.id.toLowerCase(), domain, 'decision'].filter((t): t is string => !!t)
    )
  }
  return notes.size
}

/**
 * Rule YAMLs (`metadata` + `rules: [...]`) become rule/exception/gap/sla
 * entities, with edges to the objects they touch and to their decision.
 *
 * Edges carry foreign keys: run `ingestDecisionNotes` with the same
 * `decisions` first, and list a file's overridden rules before its exceptions.
 */
export function ingestRuleFiles(
  ctx: IngestionContext,
  files: string[],
  opts: { decisions?: Map<string, Note>; summarize?: Summarize } = {}
): { rules: number; edges: number } {
  let rules = 0
  let edges = 0

  for (const file of files) {
    let doc: { metadata?: Record<string, unknown>; rules?: unknown } | null
    try {
      doc = yaml.load(readFileSync(file, 'utf-8')) as typeof doc
    } catch (err) {
      ctx.log(`WARN: failed to parse ${file}: ${(err as Error).message}`)
      continue
    }
    if (!doc || !Array.isArray(doc.rules)) {
      ctx.log(`SKIP: no rules array in ${file}`)
      continue
    }
    const domain = String(
      doc.metadata?.domain ?? basename(file, '.yaml').replace('seed-', '').replace('-rules', '')
    )

    for (const rule of doc.rules as RuleEntry[]) {
      if (!rule.id) continue
      const type = rule.type ?? 'rule'
      const entityId = `${type}:${rule.id}`
      const note = rule.decision ? opts.decisions?.get(rule.decision) : undefined
      if (rule.decision && !note) ctx.log(`WARN: ${rule.id} cita ${rule.decision} pero no existe`)
      const why = note && opts.summarize ? opts.summarize(note) : null

      ctx.entities.upsert({
        id: entityId,
        type,
        name: `[${rule.id}] ${rule.summary ?? 'Sin resumen'}`,
        body: buildRuleBody(rule, why),
        metadata: {
          domain,
          domainVersion: doc.metadata?.version ?? null,
          domainCreatedAt: doc.metadata?.created_at ?? null,
          subdomain: rule.subdomain ?? null,
          status: rule.status ?? 'active',
          owner: rule.owner ?? null,
          eventos: rule.applicability?.evento ?? [],
          actors: rule.applicability?.actor ?? [],
          relatedTables: rule.related_objects?.tables ?? [],
          relatedSps: rule.related_objects?.sps ?? [],
          relatedCode: rule.related_objects?.code ?? [],
          sourceRef: rule.source_ref ?? null,
          formalRule: rule.formal_rule ?? null,
          decision: decisionRef(why),
        },
        sourcePath: file,
      })
      rules++

      ctx.search.clearTerms(entityId)
      ctx.search.addTerms(entityId, ruleTerms(rule, domain))

      if (type === 'exception' && rule.formal_rule?.overrides) {
        ctx.edges.upsert({
          src: entityId,
          dst: `rule:${rule.formal_rule.overrides}`,
          relation: 'overrides',
        })
        edges++
      }
      if (why) {
        ctx.edges.upsert({ src: entityId, dst: `decision:${why.id}`, relation: 'justified_by' })
        edges++
      }
      for (const [key, kind] of Object.entries(relationTypes)) {
        for (const name of rule.related_objects?.[key as keyof typeof relationTypes] ?? []) {
          const objectId = `${kind.prefix}:${name}`
          ctx.entities.upsert({
            id: objectId,
            type: kind.type,
            name,
            body: `${kind.label}: ${name}`,
            metadata: { domain },
          })
          ctx.edges.upsert({ src: entityId, dst: objectId, relation: kind.relation })
          edges++
        }
      }
    }
  }
  return { rules, edges }
}

/** Standards become `standard:<id>` entities, searchable by technology and category. */
export function ingestStandardFiles(
  ctx: IngestionContext,
  files: StandardFile[],
  opts: { decisions?: Map<string, Note>; summarize?: Summarize } = {}
): { standards: number; edges: number } {
  let standards = 0
  let edges = 0
  for (const { file, technology, layer, version, standards: list } of files) {
    for (const std of list) {
      if (!std.id) continue
      const entityId = `standard:${std.id}`
      const note = std.decision ? opts.decisions?.get(std.decision) : undefined
      const why = note && opts.summarize ? opts.summarize(note) : null
      const parts = [std.summary ?? '', `Nivel: ${std.level}`]
      if (std.rationale) parts.push(`Por qué: ${std.rationale}`)
      if (std.good_example) parts.push(`Cumple:\n${std.good_example.trim()}`)
      if (std.bad_example) parts.push(`No cumple:\n${std.bad_example.trim()}`)

      ctx.entities.upsert({
        id: entityId,
        type: 'standard',
        name: `[${std.id}] ${std.summary ?? 'Sin resumen'}`,
        body: parts.join('\n'),
        metadata: {
          technology,
          layer,
          technologyVersion: version,
          category: std.category ?? null,
          level: std.level ?? null,
          appliesTo: std.applies_to ?? [],
          status: std.status ?? 'active',
          owner: std.owner ?? null,
          decision: decisionRef(why),
        },
        sourcePath: file,
      })
      standards++

      ctx.search.clearTerms(entityId)
      ctx.search.addTerms(
        entityId,
        [
          technology,
          layer,
          std.category,
          std.id.toLowerCase(),
          'estandar',
          ...(std.applies_to ?? []),
        ]
          .filter((t): t is string => !!t)
          .map((t) => t.toLowerCase())
      )
      if (why) {
        ctx.edges.upsert({ src: entityId, dst: `decision:${why.id}`, relation: 'justified_by' })
        edges++
      }
    }
  }
  return { standards, edges }
}

/**
 * Lessons become `lesson:<id>` entities, findable by the code they involve,
 * their evidence (tickets, tasks) and their area — so touching that code
 * surfaces "this already broke".
 *
 * Run after rules and decisions: edges to them are only created when the
 * target entity exists, since edges carry foreign keys.
 */
export function ingestLessonFiles(
  ctx: IngestionContext,
  files: LessonFile[]
): { lessons: number; edges: number } {
  let lessons = 0
  let edges = 0
  const linkIfExists = (src: string, dst: string, relation: string): void => {
    if (!ctx.entities.getById(dst)) {
      ctx.log(`WARN: ${src} apunta a ${dst}, que no está en la KB`)
      return
    }
    ctx.edges.upsert({ src, dst, relation })
    edges++
  }

  for (const { file, area, lessons: list } of files) {
    for (const lesson of list) {
      if (!lesson.id) continue
      const entityId = `lesson:${lesson.id}`
      const guard = lesson.guarda ?? {}
      const parts = [lesson.titulo ?? '']
      if (lesson.que_paso) parts.push(`Qué pasó: ${lesson.que_paso}`)
      if (lesson.costo) parts.push(`Costo: ${lesson.costo}`)
      if (lesson.causa_raiz) parts.push(`Causa raíz: ${lesson.causa_raiz}`)
      if (lesson.no_hagas) parts.push(`No hagas: ${lesson.no_hagas}`)
      if (lesson.haz_en_cambio) parts.push(`Haz en cambio: ${lesson.haz_en_cambio}`)
      parts.push(`Guarda (${guard.estado ?? 'sin dato'}): ${guard.detalle ?? '—'}`)
      if (lesson.evidencia?.length) parts.push(`Evidencia: ${lesson.evidencia.join(' · ')}`)

      ctx.entities.upsert({
        id: entityId,
        type: 'lesson',
        name: `[${lesson.id}] ${lesson.titulo ?? 'Sin título'}`,
        body: parts.join('\n'),
        metadata: {
          area,
          status: lesson.status ?? 'active',
          guard: guard.estado ?? null,
          evidence: lesson.evidencia ?? [],
          decision: lesson.decision ?? null,
          rules: lesson.reglas ?? [],
          code: lesson.codigo ?? [],
        },
        sourcePath: file,
      })
      lessons++

      const terms = new Set<string>(['leccion', lesson.id.toLowerCase()])
      if (area) terms.add(area.toLowerCase())
      for (const ev of lesson.evidencia ?? []) terms.add(ev.toLowerCase())
      for (const t of lesson.terminos ?? []) terms.add(t.toLowerCase())
      for (const ref of lesson.codigo ?? []) for (const t of codeTerms(ref)) terms.add(t)
      for (const r of lesson.reglas ?? []) terms.add(r.toLowerCase())
      if (lesson.decision) terms.add(lesson.decision.toLowerCase())
      ctx.search.clearTerms(entityId)
      ctx.search.addTerms(entityId, [...terms])

      if (lesson.decision) linkIfExists(entityId, `decision:${lesson.decision}`, 'resolved_by')
      for (const r of lesson.reglas ?? []) linkIfExists(entityId, `rule:${r}`, 'concerns_rule')
      for (const ref of lesson.codigo ?? []) {
        const codeId = `code:${ref}`
        ctx.entities.upsert({
          id: codeId,
          type: 'code',
          name: ref,
          body: `Código: ${ref}`,
          metadata: { area },
        })
        ctx.edges.upsert({ src: entityId, dst: codeId, relation: 'involves_code' })
        edges++
      }
    }
  }
  return { lessons, edges }
}

const objectKinds: Record<string, { type: string; label: string }> = {
  sp: { type: 'stored_procedure', label: 'Stored procedure' },
  table: { type: 'table', label: 'Tabla' },
  code: { type: 'code', label: 'Código' },
}

/** `sp:DIVVAL` → its entity shape when nothing has created it yet. */
function objectEntity(objectId: string): { type: string; name: string; body: string } {
  const sep = objectId.indexOf(':')
  const prefix = objectId.slice(0, sep)
  const name = objectId.slice(sep + 1)
  const kind = objectKinds[prefix] ?? { type: prefix, label: prefix }
  return { type: kind.type, name, body: `${kind.label}: ${name}` }
}

/** Search terms for an object id: `sp:DIVVAL` → ["divval", "sp:divval"]. */
function objectTerms(objectId: string): string[] {
  const name = objectId.slice(objectId.indexOf(':') + 1)
  const terms = objectId.startsWith('code:') ? codeTerms(name) : [name.toLowerCase()]
  return [...new Set([...terms, objectId.toLowerCase()])]
}

/**
 * Repos become `repo:<id>` entities; each component adds its location (repo,
 * path, layer) to the object's entity and a `located_in` edge, so
 * `kb_get sp:DIVVAL` says where to go read it.
 *
 * Run after rules and lessons: they upsert the same object entities with
 * their own metadata, which would drop the location.
 */
export function ingestCatalog(
  ctx: IngestionContext,
  files: CatalogFile[]
): { repos: number; components: number; edges: number } {
  let repos = 0
  let components = 0
  let edges = 0
  const repoLayers = new Map<string, string | null>()

  for (const { file, repos: list } of files) {
    for (const repo of list) {
      if (!repo.id) continue
      const entityId = `repo:${repo.id}`
      repoLayers.set(repo.id, repo.layer ?? null)
      const parts = [`Repositorio ${repo.id}`]
      if (repo.contiene) parts.push(`Contiene: ${repo.contiene}`)
      if (repo.url) parts.push(`URL: ${repo.url}`)
      ctx.entities.upsert({
        id: entityId,
        type: 'repo',
        name: repo.id,
        body: parts.join('\n'),
        metadata: { layer: repo.layer ?? null, url: repo.url ?? null },
        sourcePath: file,
      })
      ctx.search.clearTerms(entityId)
      ctx.search.addTerms(
        entityId,
        ['repo', repo.id, repo.layer].filter((t): t is string => !!t).map((t) => t.toLowerCase())
      )
      repos++
    }
  }

  for (const { file, layer, components: list } of files) {
    for (const comp of list) {
      if (!comp.objeto || !comp.repo || !comp.ruta) continue
      const existing = ctx.entities.getById(comp.objeto)
      const fresh = objectEntity(comp.objeto)
      const location = {
        repo: comp.repo,
        path: comp.ruta,
        layer: layer ?? repoLayers.get(comp.repo) ?? null,
      }
      const body = [existing?.body ?? fresh.body, `Ubicación: ${comp.repo}/${comp.ruta}`]
      if (comp.descripcion) body.push(comp.descripcion)
      ctx.entities.upsert({
        id: comp.objeto,
        type: existing?.type ?? fresh.type,
        name: existing?.name ?? fresh.name,
        body: body.join('\n'),
        metadata: { ...(existing?.metadata ?? {}), location },
        sourcePath: existing?.sourcePath ?? file,
      })
      components++
      ctx.search.addTerms(comp.objeto, [...objectTerms(comp.objeto), ...codeTerms(comp.ruta)])
      if (ctx.entities.getById(`repo:${comp.repo}`)) {
        ctx.edges.upsert({ src: comp.objeto, dst: `repo:${comp.repo}`, relation: 'located_in' })
        edges++
      }
    }
  }
  return { repos, components, edges }
}

/** Rule ids carry their kind in the entity id (`rule:`, `exception:`…); find the one that exists. */
function findRuleEntity(ctx: IngestionContext, ruleId: string): string | null {
  for (const kind of ['rule', 'exception', 'gap', 'sla']) {
    if (ctx.entities.getById(`${kind}:${ruleId}`)) return `${kind}:${ruleId}`
  }
  return null
}

/**
 * Precedents become `precedent:<id>` entities, findable by meaning (embedded
 * like everything else), by the objects they touched and by their tickets.
 *
 * Run after rules, decisions and the catalog: edges to rules and decisions
 * are only created when they exist, and objects a precedent was verified in
 * are created only if nothing else created them.
 */
export function ingestPrecedentFiles(
  ctx: IngestionContext,
  files: PrecedentFile[]
): { precedents: number; edges: number } {
  let precedents = 0
  let edges = 0

  for (const { file, area, precedents: list } of files) {
    for (const p of list) {
      if (!p.id) continue
      const entityId = `precedent:${p.id}`
      const verified = p.verificado_en ?? []
      const parts = [p.titulo ?? '']
      if (p.que_se_pidio) parts.push(`Qué se pidió: ${p.que_se_pidio}`)
      if (p.como_se_resolvio) parts.push(`Cómo se resolvió: ${p.como_se_resolvio}`)
      parts.push(
        p.traza === 'confirmada'
          ? `Traza: confirmada en ${verified.join(', ')}`
          : 'Traza: posible — sin confirmar en el código'
      )
      if (p.evidencia?.length) parts.push(`Evidencia: ${p.evidencia.join(' · ')}`)

      ctx.entities.upsert({
        id: entityId,
        type: 'precedent',
        name: `[${p.id}] ${p.titulo ?? 'Sin título'}`,
        body: parts.join('\n'),
        metadata: {
          area,
          layers: p.capas ?? [],
          trace: p.traza ?? null,
          verifiedIn: verified,
          rules: p.reglas ?? [],
          decision: p.decision ?? null,
          evidence: p.evidencia ?? [],
          date: p.fecha ?? null,
          status: p.status ?? 'active',
        },
        sourcePath: file,
      })
      precedents++

      const terms = new Set<string>(['precedente', p.id.toLowerCase()])
      if (area) terms.add(area.toLowerCase())
      for (const t of [...(p.capas ?? []), ...(p.evidencia ?? []), ...(p.terminos ?? [])]) {
        terms.add(t.toLowerCase())
      }
      for (const r of p.reglas ?? []) terms.add(r.toLowerCase())
      if (p.decision) terms.add(p.decision.toLowerCase())
      for (const obj of verified) for (const t of objectTerms(obj)) terms.add(t)
      ctx.search.clearTerms(entityId)
      ctx.search.addTerms(entityId, [...terms])

      if (p.decision) {
        if (ctx.entities.getById(`decision:${p.decision}`)) {
          ctx.edges.upsert({
            src: entityId,
            dst: `decision:${p.decision}`,
            relation: 'resolved_by',
          })
          edges++
        } else ctx.log(`WARN: ${entityId} apunta a decision:${p.decision}, que no está en la KB`)
      }
      for (const r of p.reglas ?? []) {
        const ruleEntity = findRuleEntity(ctx, r)
        if (!ruleEntity) {
          ctx.log(`WARN: ${entityId} apunta a la regla ${r}, que no está en la KB`)
          continue
        }
        ctx.edges.upsert({ src: entityId, dst: ruleEntity, relation: 'applies_rule' })
        edges++
      }
      for (const obj of verified) {
        if (!ctx.entities.getById(obj)) {
          ctx.entities.upsert({ id: obj, ...objectEntity(obj), metadata: { area } })
        }
        ctx.edges.upsert({ src: entityId, dst: obj, relation: 'verified_in' })
        edges++
      }
    }
  }
  return { precedents, edges }
}
