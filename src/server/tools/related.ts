import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { EdgeRepo } from '../../repos/EdgeRepo.js'

/**
 * kb_related — All edges touching an entity, in both directions.
 *
 * Use this when the agent needs the IMMEDIATE neighborhood (depth=1, both
 * directions) without committing to a graph walk. Cheaper than kb_traverse
 * for "what is connected to X?" questions.
 *
 * Returns { outgoing, incoming } so the caller can distinguish "X depends on Y"
 * from "Z depends on X".
 */
export function registerRelatedTool(server: McpServer, edges: EdgeRepo): void {
  server.registerTool(
    'kb_related',
    {
      title: 'Edges in both directions for an entity',
      description:
        'Returns { outgoing: Edge[], incoming: Edge[] } for the given entity ID. ' +
        'Cheaper than kb_traverse for the common case "show me what is directly ' +
        'connected to X". Direction matters: outgoing edges have src=id, incoming ' +
        'have dst=id.',
      inputSchema: {
        id: z.string().min(1).describe('Entity ID to inspect.'),
      },
    },
    (args) => {
      const r = edges.related(args.id)
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                id: args.id,
                outgoingCount: r.outgoing.length,
                incomingCount: r.incoming.length,
                outgoing: r.outgoing,
                incoming: r.incoming,
              },
              null,
              2
            ),
          },
        ],
      }
    }
  )
}
