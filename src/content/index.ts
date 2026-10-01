/**
 * `@kb/mcp-server/content` — helpers for content repos (one per business):
 * loading and validating decision notes and technical standards. Plugins and
 * validation scripts import these instead of each repo carrying its own copy.
 */
export {
  normalizeHeading,
  findMarkdownFiles,
  parseNote,
  loadNotes,
  pickSection,
  validateNotes,
  findDanglingDecisionRefs,
} from './notes.js'
export type { Note, NoteSection, NoteRules, CheckResult } from './notes.js'
export {
  STANDARD_ID_PATTERN,
  STANDARD_LEVELS,
  STANDARD_STATUSES,
  STANDARD_REQUIRED,
  findYamlFiles,
  loadStandards,
  validateStandards,
} from './standards.js'
export type { Standard, StandardFile } from './standards.js'
export {
  LESSON_ID_PATTERN,
  LESSON_STATUSES,
  GUARD_STATES,
  LESSON_REQUIRED,
  loadLessons,
  validateLessons,
} from './lessons.js'
export type { Lesson, LessonFile } from './lessons.js'
export {
  ingestDecisionNotes,
  ingestRuleFiles,
  ingestStandardFiles,
  ingestLessonFiles,
} from './ingest.js'
export type { DecisionSummary, Summarize } from './ingest.js'
