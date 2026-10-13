import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { SearchRepo } from '../../repos/SearchRepo.js'
import type { HybridSearch, FindResult } from '../../search/HybridSearch.js'

/**
 * kb_find — Ranked search over the knowledge graph: FTS5 / BM25 keyword
 * matching fused with embedding similarity when the KB was built with
 * vectors (`kb-ingest embed`).
 *
 * Use this when:
 *   * The user query is free-form ("how do we handle deferred payments?").
 *   * The agent needs the most relevant entities ranked by content match.
 *
 * NOT for:
 *   * Exact keyword/tag lookup → use kb_by_term.
 *   * Direct ID lookup → use kb_get.
 */
export function registerFindTool(
  server: McpServer,
  search: SearchRepo,
  hybrid?: HybridSearch
): void {
  server.registerTool(
    'kb_find',
    {
      title: 'Search the knowledge graph',
      description:
        'Ranked search over entity name + body. Default mode "hybrid" combines keyword ' +
        'matching (SQLite FTS5, BM25) with semantic similarity (embeddings), so a question ' +
        'phrased with different words than the rule still finds it. Natural-language ' +
        'questions are fine; FTS5 syntax ("exact phrase", term*, AND, OR, NEAR) also works. ' +
        'Falls back to keyword-only when the KB has no embeddings — the response says so ' +
        'in "warning". Use kb_get(id) to fetch the full body of a hit.',
      inputSchema: {
        query: z
          .string()
          .min(1)
          .describe(
            'Question or keywords. Examples: "¿se puede diferir una compra a meses?", "promo*", "\\"meses sin intereses\\""'
          ),
        type: z
          .string()
          .optional()
          .describe('Optional filter on entity type (e.g. "rule", "feature", "decision").'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('Max hits to return (default 20, max 100).'),
        mode: z
          .enum(['hybrid', 'semantic', 'fts'])
          .optional()
          .describe(
            '"hybrid" (default): keywords + meaning. "semantic": meaning only. ' +
              '"fts": keywords only — best for exact IDs or codes.'
          ),
      },
    },
    async (args) => {
      const result: FindResult = hybrid
        ? await hybrid.find(args.query, { type: args.type, limit: args.limit, mode: args.mode })
        : {
            mode: 'fts',
            hits: search.fullTextLenient(args.query, { type: args.type, limit: args.limit }),
          }
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ count: result.hits.length, ...result }, null, 2),
          },
        ],
      }
    }
  )
}
