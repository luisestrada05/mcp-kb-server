/**
 * Component catalog — `catalogo/**.yaml`: which repos make up the system and
 * where each object a rule touches lives (`sp:DIVVAL` → repo + path).
 *
 * Rules already say which objects they use; the catalog closes the chain so
 * an agent can go read the object and confirm the rule against the code
 * instead of trusting the rule alone. Paths are relative to the repo: each
 * developer clones somewhere else, so local paths never enter the KB.
 *
 * A file may hold `repos:`, `componentes:` or both.
 */
import { readFileSync } from 'node:fs'
import yaml from 'js-yaml'
import type { CheckResult } from './notes.js'
import { findYamlFiles, layerErrors } from './standards.js'

export const REPO_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/
/** `<kind>:<name>` — the same ids rules create (`sp:DIVVAL`, `table:DIF`, `code:path::Symbol`). */
export const OBJECT_ID_PATTERN = /^[a-z_]+:.+$/
export const REPO_REQUIRED = ['id', 'layer', 'url'] as const
export const COMPONENT_REQUIRED = ['objeto', 'repo', 'ruta'] as const

export interface CatalogRepo {
  id?: string
  layer?: string
  url?: string
  contiene?: string
  [key: string]: unknown
}

export interface CatalogComponent {
  /** Entity id of the object, e.g. `sp:DIVVAL`. */
  objeto?: string
  repo?: string
  /** Path inside the repo. */
  ruta?: string
  descripcion?: string
  [key: string]: unknown
}

export interface CatalogFile {
  file: string
  layer: string | null
  repos: CatalogRepo[]
  components: CatalogComponent[]
}

/** Throws on unparseable YAML so the caller reports it instead of skipping silently. */
export function loadCatalog(dir: string): CatalogFile[] {
  return findYamlFiles(dir).map((file) => {
    const doc = (yaml.load(readFileSync(file, 'utf-8')) ?? {}) as {
      metadata?: { layer?: string }
      repos?: unknown
      componentes?: unknown
    }
    return {
      file,
      layer: doc.metadata?.layer ?? null,
      repos: Array.isArray(doc.repos) ? (doc.repos as CatalogRepo[]) : [],
      components: Array.isArray(doc.componentes) ? (doc.componentes as CatalogComponent[]) : [],
    }
  })
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || path.startsWith('~') || /^[A-Za-z]:[\\/]/.test(path)
}

export function validateCatalog(
  files: CatalogFile[],
  opts: { layers?: readonly string[] } = {}
): CheckResult {
  const errors: string[] = []
  const repoIds = new Set<string>()
  const objects = new Set<string>()

  for (const { file, repos } of files) {
    repos.forEach((repo, i) => {
      const label = `${file}: ${repo.id ?? `repos[${i}]`}`
      for (const field of REPO_REQUIRED) {
        if (!repo[field]) errors.push(`${label}: falta campo obligatorio "${field}"`)
      }
      if (repo.id) {
        if (!REPO_ID_PATTERN.test(repo.id)) {
          errors.push(`${label}: id de repo en minúsculas, sin espacios`)
        }
        if (repoIds.has(repo.id)) errors.push(`${label}: repo duplicado`)
        repoIds.add(repo.id)
      }
      if (repo.layer) errors.push(...layerErrors(repo.layer, opts.layers, label))
    })
  }

  for (const { file, layer, repos, components } of files) {
    if (repos.length === 0 && components.length === 0) {
      errors.push(`${file}: no tiene lista "repos" ni "componentes"`)
    }
    if (components.length > 0) errors.push(...layerErrors(layer, opts.layers, file))
    components.forEach((comp, i) => {
      const label = `${file}: ${comp.objeto ?? `componentes[${i}]`}`
      for (const field of COMPONENT_REQUIRED) {
        if (!comp[field]) errors.push(`${label}: falta campo obligatorio "${field}"`)
      }
      if (comp.objeto) {
        if (!OBJECT_ID_PATTERN.test(comp.objeto)) {
          errors.push(`${label}: "objeto" debe ser <tipo>:<nombre> (sp:DIVVAL, table:DIF…)`)
        }
        if (objects.has(comp.objeto)) errors.push(`${label}: objeto mapeado dos veces`)
        objects.add(comp.objeto)
      }
      if (comp.repo && !repoIds.has(comp.repo)) {
        errors.push(`${label}: repo "${comp.repo}" no está en el catálogo`)
      }
      if (comp.ruta && isAbsolutePath(comp.ruta)) {
        errors.push(`${label}: "ruta" debe ser relativa al repo, no una ruta de esta máquina`)
      }
    })
  }
  return { errors, warnings: [] }
}
