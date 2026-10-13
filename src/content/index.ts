/**
 * `@kb/mcp-server/content` — helpers for content repos (one per business):
 * loading and validating decision notes, technical standards, lessons, the
 * component catalog and precedents. Plugins and
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
  layerErrors,
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
  REPO_ID_PATTERN,
  OBJECT_ID_PATTERN,
  REPO_REQUIRED,
  COMPONENT_REQUIRED,
  loadCatalog,
  validateCatalog,
} from './catalog.js'
export type { CatalogRepo, CatalogComponent, CatalogFile } from './catalog.js'
export {
  PRECEDENT_ID_PATTERN,
  PRECEDENT_STATUSES,
  TRACE_STATES,
  PRECEDENT_REQUIRED,
  loadPrecedents,
  validatePrecedents,
} from './precedents.js'
export type { Precedent, PrecedentFile } from './precedents.js'
export {
  ingestDecisionNotes,
  ingestRuleFiles,
  ingestStandardFiles,
  ingestLessonFiles,
  ingestCatalog,
  ingestPrecedentFiles,
} from './ingest.js'
export type { DecisionSummary, Summarize } from './ingest.js'
