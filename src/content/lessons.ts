/**
 * Lessons — `lessons/<area>/*.yaml`: something that already went wrong, what
 * it cost, and what stops it from happening again.
 *
 * Rules say what must happen, decisions why, standards how code is written;
 * a lesson says what already broke. Its key field is `guarda`: a lesson with
 * no automated guard depends on someone reading it, and (as the lessons
 * themselves keep showing) written rules get repeated anyway. Validation
 * therefore warns on every lesson whose guard is not complete.
 */
import { readFileSync } from 'node:fs'
import yaml from 'js-yaml'
import type { CheckResult } from './notes.js'
import { findYamlFiles } from './standards.js'

export const LESSON_ID_PATTERN = /^L-[A-Z]{2,5}-\d{3,4}$/
export const LESSON_STATUSES = ['active', 'obsolete'] as const
export const GUARD_STATES = ['completa', 'parcial', 'ninguna'] as const
export const LESSON_REQUIRED = [
  'id',
  'titulo',
  'que_paso',
  'causa_raiz',
  'no_hagas',
  'haz_en_cambio',
  'guarda',
  'evidencia',
  'status',
] as const

export interface Lesson {
  id?: string
  titulo?: string
  que_paso?: string
  costo?: string
  causa_raiz?: string
  no_hagas?: string
  haz_en_cambio?: string
  /** What prevents a repeat today. `detalle` names the test/lint/hook/ruleset. */
  guarda?: { estado?: string; detalle?: string }
  /** Tickets, tasks, PRs, incidents — where the evidence lives. */
  evidencia?: string[]
  decision?: string
  reglas?: string[]
  /** `path::symbol` the lesson is about; surfaces it when that code is touched. */
  codigo?: string[]
  /** Free search tags for words that appear in no path (e.g. "alembic", "migración"). */
  terminos?: string[]
  status?: string
  [key: string]: unknown
}

export interface LessonFile {
  file: string
  area: string | null
  lessons: Lesson[]
}

/** Throws on unparseable YAML so the caller reports it instead of skipping silently. */
export function loadLessons(dir: string): LessonFile[] {
  return findYamlFiles(dir).map((file) => {
    const doc = (yaml.load(readFileSync(file, 'utf-8')) ?? {}) as {
      metadata?: { area?: string }
      lessons?: unknown
    }
    return {
      file,
      area: doc.metadata?.area ?? null,
      lessons: Array.isArray(doc.lessons) ? (doc.lessons as Lesson[]) : [],
    }
  })
}

export function validateLessons(
  files: LessonFile[],
  opts: { knownDecisions?: Set<string> } = {}
): CheckResult {
  const errors: string[] = []
  const warnings: string[] = []
  const seen = new Set<string>()

  for (const { file, area, lessons } of files) {
    if (!area) errors.push(`${file}: falta metadata.area`)
    if (lessons.length === 0) errors.push(`${file}: no tiene lista "lessons"`)
    lessons.forEach((lesson, i) => {
      const label = `${file}: ${lesson.id ?? `lessons[${i}]`}`
      for (const field of LESSON_REQUIRED) {
        if (!lesson[field]) errors.push(`${label}: falta campo obligatorio "${field}"`)
      }
      if (lesson.id) {
        if (!LESSON_ID_PATTERN.test(lesson.id)) {
          errors.push(`${label}: ID no cumple formato L-XXX-NNN`)
        }
        if (seen.has(lesson.id)) errors.push(`${label}: ID duplicado`)
        seen.add(lesson.id)
      }
      if (lesson.status && !(LESSON_STATUSES as readonly string[]).includes(lesson.status)) {
        errors.push(
          `${label}: status "${lesson.status}" no es válido (${LESSON_STATUSES.join(', ')})`
        )
      }
      if (lesson.evidencia !== undefined && !Array.isArray(lesson.evidencia)) {
        errors.push(`${label}: "evidencia" debe ser una lista`)
      } else if (Array.isArray(lesson.evidencia) && lesson.evidencia.length === 0) {
        errors.push(`${label}: "evidencia" está vacía — una lección sin evidencia es una opinión`)
      }
      const guard = lesson.guarda
      if (guard) {
        if (!(GUARD_STATES as readonly string[]).includes(guard.estado ?? '')) {
          errors.push(
            `${label}: guarda.estado "${guard.estado}" no es válido (${GUARD_STATES.join(', ')})`
          )
        } else if (guard.estado !== 'ninguna' && !guard.detalle) {
          errors.push(`${label}: guarda.detalle es obligatorio cuando hay guarda`)
        }
        if (guard.estado === 'parcial' || guard.estado === 'ninguna') {
          warnings.push(
            `${label}: guarda ${guard.estado} — repetirla depende de que alguien lea la lección`
          )
        }
      }
      if (lesson.decision && opts.knownDecisions && !opts.knownDecisions.has(lesson.decision)) {
        errors.push(`${label}: cita ${lesson.decision} pero no existe`)
      }
    })
  }
  return { errors, warnings }
}
