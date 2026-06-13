import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { SearchRepo } from '../../repos/SearchRepo.js'

/**
 * kb_find — Full-text search over the knowledge graph (FTS5 / BM25).
 *
 * Use this when:
 *   * The user query is free-form ("how do we handle deferred payments?").
 *   * The agent needs the most relevant entities ranked by content match.
 *
 * NOT for:
 *   * Exact keyword/tag lookup → use kb_by_term.
 *   * Direct ID lookup → use kb_get.
 */
export function registerFindTool(server: McpServer, search: SearchRepo): void {
  server.registerTool(
    'kb_find',
    {
      title: 'Search the knowledge graph (FTS)',
      description:
        'Full-text search over entity name + body using SQLite FTS5 (BM25 ranking). ' +
        'Supports FTS5 query syntax: "exact phrase", term*, AND, OR, NEAR. ' +
        'Returns ranked hits with a highlighted snippet (matches wrapped in << >>). ' +
        'Use kb_get(id) to fetch the full body of a hit.',
      inputSchema: {
        query: z
          .string()
          .min(1)
          .describe('FTS5 query string. Examples: "diferidos", "promo*", "\\"meses sin intereses\\""'),
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
      },
    },
    (args) => {
      const hits = search.fullText(args.query, { type: args.type, limit: args.limit })
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ count: hits.length, hits }, null, 2),
          },
        ],
      }
    }
  )
}
