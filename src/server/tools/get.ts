import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { EntityRepo } from '../../repos/EntityRepo.js'

/**
 * kb_get — Fetch a full entity by ID.
 *
 * Use this after kb_find / kb_by_term / kb_traverse to drill into the full
 * body of a specific entity. The hits returned by search tools only carry
 * snippets — the agent should call kb_get when it needs the complete content.
 */
export function registerGetTool(server: McpServer, entities: EntityRepo): void {
  server.registerTool(
    'kb_get',
    {
      title: 'Fetch an entity by ID',
      description:
        'Returns the full entity (name, body, metadata, source_path) for the given ID, ' +
        'or an explicit not-found result. IDs come from search tools (kb_find, kb_by_term, ' +
        'kb_traverse, kb_related).',
      inputSchema: {
        id: z.string().min(1).describe('Entity ID exactly as returned by another kb tool.'),
      },
    },
    (args) => {
      const entity = entities.getById(args.id)
      if (!entity) {
        return {
          content: [
            { type: 'text', text: JSON.stringify({ found: false, id: args.id }, null, 2) },
          ],
        }
      }
      return {
        content: [{ type: 'text', text: JSON.stringify({ found: true, entity }, null, 2) }],
      }
    }
  )
}
