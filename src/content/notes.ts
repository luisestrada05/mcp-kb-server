/**
 * Markdown notes with YAML frontmatter (Obsidian-compatible) — the shape
 * decision records take in a content repo's vault.
 *
 * Domain-agnostic on purpose: the parser only splits frontmatter and `## `
 * sections. Which ID pattern, statuses and sections a note must have is the
 * content repo's call, passed in as `NoteRules` — one business writes
 * `DEC-XXX-NNN` with "Intención / No significa", another `ADR-NNN` with
 * "Contexto / Decisión".
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import yaml from 'js-yaml'

export interface NoteSection {
  /** Heading as written, e.g. "No significa". */
  heading: string
  /** Section body, trimmed. */
  text: string
  /** Top-level `- ` bullet items, without the marker. */
  items: string[]
}

export interface Note {
  file: string
  frontmatter: Record<string, unknown>
  /** `frontmatter.id` as a string, or null when absent. */
  id: string | null
  /** First `# ` heading, falling back to the id or file name. */
  title: string
  /** Everything after the frontmatter, trimmed. */
  content: string
  /** Keyed by `normalizeHeading(heading)`. */
  sections: Record<string, NoteSection>
}

export interface NoteRules {
  idPattern: RegExp
  statuses: readonly string[]
  /** Normalized headings every note must have with a non-empty body. */
  requiredSections: readonly string[]
  /** Frontmatter field holding the status. Default `status`. */
  statusField?: string
  /** Status value meaning "replaced"; such notes must name their successor. */
  supersededStatus?: string
  /** Frontmatter field naming the successor. Default `superseded_by`. */
  supersededByField?: string
  /** Text that marks a placeholder still to be filled. Reported as a warning. */
  pendingMarker?: string
}

export interface CheckResult {
  errors: string[]
  warnings: string[]
}

/** Lowercase, accents stripped, trimmed — "Intención" and "intencion" match. */
export function normalizeHeading(heading: string): string {
  return heading.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()
}

/** Recursive `.md` listing. Skips entries starting with `_` or `.` (templates, Obsidian config). */
export function findMarkdownFiles(dir: string): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  const results: string[] = []
  for (const entry of entries) {
    if (entry.startsWith('_') || entry.startsWith('.')) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) results.push(...findMarkdownFiles(full))
    else if (entry.endsWith('.md')) results.push(full)
  }
  return results
}

export function parseNote(file: string): Note {
  const raw = readFileSync(file, 'utf-8')
  const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  const loaded = fm ? yaml.load(fm[1] ?? '') : null
  const frontmatter =
    loaded && typeof loaded === 'object' ? (loaded as Record<string, unknown>) : {}
  const content = (fm ? raw.slice(fm[0].length) : raw).trim()
  const id = frontmatter.id == null ? null : String(frontmatter.id)
  const title = content.match(/^# (.+)$/m)?.[1]?.trim() || id || basename(file, '.md')

  const sections: Record<string, NoteSection> = {}
  // split with a capture group: [before, heading1, body1, heading2, body2, ...]
  const parts = content.split(/^## (.+)$/m)
  for (let i = 1; i < parts.length; i += 2) {
    const heading = (parts[i] ?? '').trim()
    const text = (parts[i + 1] ?? '').trim()
    const items = text
      .split('\n')
      .filter((line) => /^- /.test(line))
      .map((line) => line.slice(2).trim())
    sections[normalizeHeading(heading)] = { heading, text, items }
  }

  return { file, frontmatter, id, title, content, sections }
}

/**
 * Loads every note under `dir` that has an `id`, keyed by it. `filter` drops
 * notes that share the folder but are not records (indexes, open questions).
 */
export function loadNotes(
  dir: string,
  opts: { filter?: (note: Note) => boolean } = {}
): Map<string, Note> {
  const byId = new Map<string, Note>()
  for (const file of findMarkdownFiles(dir)) {
    const note = parseNote(file)
    if (!note.id) continue
    if (opts.filter && !opts.filter(note)) continue
    byId.set(note.id, note)
  }
  return byId
}

/** First section present among `keys` (normalized headings) — for heading variants. */
export function pickSection(note: Note, ...keys: string[]): NoteSection | null {
  for (const key of keys) {
    const section = note.sections[normalizeHeading(key)]
    if (section?.text) return section
  }
  return null
}

export function validateNotes(notes: Map<string, Note>, rules: NoteRules): CheckResult {
  const errors: string[] = []
  const warnings: string[] = []
  const statusField = rules.statusField ?? 'status'
  const supersededByField = rules.supersededByField ?? 'superseded_by'

  for (const note of notes.values()) {
    const label = note.file
    const id = note.id ?? ''
    if (!rules.idPattern.test(id)) {
      errors.push(`${label}: id "${id}" no cumple el formato ${rules.idPattern}`)
    }
    // Startswith, not equality: "ADR-001 — Título.md" is as valid as "DEC-DIF-001.md".
    if (!basename(note.file, '.md').startsWith(id)) {
      errors.push(`${label}: el nombre del archivo debe empezar con ${id}`)
    }
    const status = String(note.frontmatter[statusField] ?? '')
    if (!rules.statuses.includes(status)) {
      errors.push(
        `${label}: ${statusField} "${status}" no es válido (${rules.statuses.join(', ')})`
      )
    }
    if (rules.supersededStatus && status === rules.supersededStatus) {
      const successor = String(note.frontmatter[supersededByField] ?? '')
      if (!notes.has(successor)) {
        errors.push(
          `${label}: ${statusField} ${status} requiere ${supersededByField} apuntando a una nota existente`
        )
      }
    }
    for (const key of rules.requiredSections) {
      if (!note.sections[key]?.text) errors.push(`${label}: falta la sección obligatoria "${key}"`)
    }
    if (rules.pendingMarker && note.content.includes(rules.pendingMarker)) {
      warnings.push(`${label}: tiene partes "${rules.pendingMarker}"`)
    }
  }
  return { errors, warnings }
}

/**
 * Rule YAMLs may cite a note with `decision: <id>`. Returns one error per
 * citation that does not resolve.
 */
export function findDanglingDecisionRefs(ruleFiles: string[], known: Set<string>): string[] {
  const errors: string[] = []
  for (const file of ruleFiles) {
    const doc = yaml.load(readFileSync(file, 'utf-8')) as { rules?: unknown } | null
    const rules = Array.isArray(doc?.rules) ? (doc.rules as Record<string, unknown>[]) : []
    for (const rule of rules) {
      if (rule.decision && !known.has(String(rule.decision))) {
        errors.push(`${file}: ${String(rule.id)} cita ${String(rule.decision)} pero no existe`)
      }
    }
  }
  return errors
}
