import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { EdgeRepo } from '../../repos/EdgeRepo.js'

/**
 * kb_traverse — Walk the graph outwards from a starting node.
 *
 * Use this to answer questions like:
 *   * "What does rule X depend on?" → relation="depends_on", maxDepth=N
 *   * "What follows from decision Y?" → relation="drove"/"implements"
 *   * "Map the neighborhood of this concept" → no relation filter
 *
 * Results are BFS — start node at depth 0, direct neighbors at depth 1, etc.
 * Each result includes the relation that led to it so callers can render
 * the path. Cycles are de-duplicated via a visited set.
 */
export function registerTraverseTool(server: McpServer, edges: EdgeRepo): void {
  server.registerTool(
    'kb_traverse',
    {
      title: 'Graph walk from a starting entity',
      description:
        'BFS from `id` following outgoing edges, optionally filtered by `relation`. ' +
        'Returns the start node (depth 0) plus every reachable entity up to `maxDepth` (default 1). ' +
        'Each result has { entity, depth, relation } — relation is null for the start node. ' +
        'Cycles are de-duplicated.',
      inputSchema: {
        id: z.string().min(1).describe('Starting entity ID.'),
        relation: z
          .string()
          .optional()
          .describe(
            'Optional relation filter. Only edges with this relation are followed (e.g. "depends_on"). ' +
              'Omit to follow ALL outgoing edges.'
          ),
        maxDepth: z
          .number()
          .int()
          .min(0)
          .max(10)
          .optional()
          .describe('Max BFS depth (default 1, max 10).'),
      },
    },
    (args) => {
      const results = edges.traverse(args.id, {
        relation: args.relation,
        maxDepth: args.maxDepth,
      })
      if (results.length === 0) {
        return {
          content: [
            { type: 'text', text: JSON.stringify({ found: false, id: args.id }, null, 2) },
          ],
        }
      }
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ count: results.length, results }, null, 2),
          },
        ],
      }
    }
  )
}
