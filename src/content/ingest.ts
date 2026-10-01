/**
 * Ingestion of a content repo's sources into the graph: business rule YAMLs,
 * decision notes, technical standards and lessons. Each business's plugin
 * only supplies its conventions (where the notes live, how to summarize one)
 * and calls these.
 *
 *   Entity types: rule | exception | gap | sla | decision | standard | lesson
 *                 + table | stored_procedure | code  (objects a rule touches)
 *   Relations:    overrides | justified_by | uses_table | uses_sp | uses_code
 *                 | resolved_by | concerns_rule | involves_code  (lessons)
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

/** `path/file.py::Symbol` → ["symbol", "file"], so lookups by either name hit. */
function codeTerms(ref: string): string[] {
  const [file, symbol] = ref.split('::')
  const terms: string[] = []
  if (symbol) terms.push(symbol.toLowerCase())
  if (file)
    terms.push(
      basename(file)
        .replace(/\.[^.]+$/, '')
        .toLowerCase()
    )
  return terms
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
      metadata: {
        ...note.frontmatter,
        domain,
        summary,
        sections: Object.fromEntries(
          Object.values(note.sections).map((s) => [s.heading, s.items.length ? s.items : s.text])
        ),
      },
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
          riskNote: rule.risk_note ?? null,
          eventos: rule.applicability?.evento ?? [],
          actors: rule.applicability?.actor ?? [],
          relatedTables: rule.related_objects?.tables ?? [],
          relatedSps: rule.related_objects?.sps ?? [],
          relatedCode: rule.related_objects?.code ?? [],
          sourceRef: rule.source_ref ?? null,
          formalRule: rule.formal_rule ?? null,
          noSignifica: rule.no_significa ?? [],
          decision: why,
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
  for (const { file, technology, version, standards: list } of files) {
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
          technologyVersion: version,
          category: std.category ?? null,
          level: std.level ?? null,
          appliesTo: std.applies_to ?? [],
          status: std.status ?? 'active',
          owner: std.owner ?? null,
          rationale: std.rationale ?? null,
          decision: why,
        },
        sourcePath: file,
      })
      standards++

      ctx.search.clearTerms(entityId)
      ctx.search.addTerms(
        entityId,
        [technology, std.category, std.id.toLowerCase(), 'estandar', ...(std.applies_to ?? [])]
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
          guardDetail: guard.detalle ?? null,
          cost: lesson.costo ?? null,
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
