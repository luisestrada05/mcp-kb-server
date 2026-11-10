import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { EntityRepo } from '../../repos/EntityRepo.js'
import type { EdgeRepo } from '../../repos/EdgeRepo.js'
import { jsonResult } from './output.js'

/**
 * kb_context — one call for "everything I need before acting on X": the full
 * entity plus its direct neighbors in both directions, summarized.
 *
 * Replaces the kb_get + kb_related (+ a kb_get per neighbor just to learn its
 * name) round trips. Each round trip re-sends the whole conversation to the
 * agent's LLM, so fewer calls is the bigger token saving.
 */
export function registerContextTool(
  server: McpServer,
  entities: EntityRepo,
  edges: EdgeRepo
): void {
  server.registerTool(
    'kb_context',
    {
      title: 'Entity plus its direct connections',
      description:
        'Returns the full entity (name, body, metadata, sourcePath) and its direct neighbors ' +
        'in BOTH directions as { relation, id, type, name }: outgoing (what it points at) and ' +
        'incoming (what points at it — exceptions, decisions, features that depend on it). ' +
        'Prefer this over kb_get + kb_related when you are about to act on an entity. ' +
        'Neighbors come without bodies; kb_get the ones you need.',
      inputSchema: {
        id: z.string().min(1).describe('Entity ID exactly as returned by another kb tool.'),
      },
    },
    (args) => {
      const entity = entities.getById(args.id)
      if (!entity) return jsonResult({ found: false, id: args.id })
      return jsonResult({ found: true, entity, ...edges.neighbors(args.id) })
    }
  )
}
