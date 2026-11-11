import type { SearchHit } from '../../types/kb.js'

/**
 * Shared shaping for tool responses. Every byte a tool returns is read by the
 * agent's LLM, so responses are compact JSON (no indentation) and search hits
 * carry only what the agent needs to pick an entity.
 */

/** Default hit count for kb_find / kb_by_term: agents rarely use more than the top few. */
export const DEFAULT_TOOL_LIMIT = 8

/** A tool result whose single text block is `value` as compact JSON. */
export function jsonResult(value: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] }
}

/**
 * Drops ranking internals (rank, score, similarity, matchedBy) from a hit.
 * Hits are already ordered best-first; the numbers only help when debugging
 * the search itself, so tools keep them behind `debug: true`.
 */
export function compactHit(hit: SearchHit): Pick<SearchHit, 'id' | 'type' | 'name' | 'snippet'> {
  return { id: hit.id, type: hit.type, name: hit.name, snippet: hit.snippet }
}

export function shapeHits(hits: SearchHit[], debug = false): SearchHit[] {
  return debug ? hits : hits.map(compactHit)
}
