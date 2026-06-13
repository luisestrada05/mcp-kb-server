import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { SearchRepo } from '../../repos/SearchRepo.js'

/**
 * kb_by_term — Exact keyword lookup against the curated term index.
 *
 * This is the "word → rules" pattern. The ingestion plugin extracts a list
 * of canonical terms per entity (typically from frontmatter or domain-specific
 * keywords), and this tool resolves any of those terms to the entities tagged
 * with it.
 *
 * Use this when:
 *   * The agent saw a specific term in the user's request (e.g. "diferidos")
 *     and wants the rules tagged with that exact term.
 *   * Faster + more precise than FTS for known-vocabulary lookups.
 *
 * Case-insensitive — the index stores lowercased terms.
 */
export function registerByTermTool(server: McpServer, search: SearchRepo): void {
  server.registerTool(
    'kb_by_term',
    {
      title: 'Lookup entities by exact term/keyword',
      description:
        'Exact match against the term index (case-insensitive). Use when the agent ' +
        'spots a domain keyword in a user request and needs the entities tagged with it. ' +
        'For free-form / fuzzy search, use kb_find instead. Returns up to `limit` entities ' +
        'ordered by recency.',
      inputSchema: {
        term: z.string().min(1).describe('Exact term to look up. Case-insensitive.'),
        type: z.string().optional().describe('Optional entity-type filter.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('Max hits (default 20, max 100).'),
      },
    },
    (args) => {
      const hits = search.byTerm(args.term, { type: args.type, limit: args.limit })
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ term: args.term, count: hits.length, hits }, null, 2),
          },
        ],
      }
    }
  )
}
