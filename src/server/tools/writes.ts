import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { EntityRepo } from '../../repos/EntityRepo.js'
import type { EdgeRepo } from '../../repos/EdgeRepo.js'

/**
 * Write tools. Disabled by default — opt-in via the env var KB_ALLOW_WRITES=1
 * passed to the server. Rationale: markdown is the canonical source of truth
 * for most knowledge bases; allowing agents to write directly bypasses git
 * review. Enable writes when you want the agent to propose new relations or
 * provisional entities that the ingestion pipeline can later ratify.
 */
export function registerWriteTools(
  server: McpServer,
  entities: EntityRepo,
  edges: EdgeRepo
): void {
  server.registerTool(
    'kb_add_entity',
    {
      title: 'Insert or update an entity',
      description:
        'Upsert an entity. Use sparingly — markdown is typically the canonical source. ' +
        'Setting metadata.provisional=true is the convention for "agent-proposed, not yet ratified."',
      inputSchema: {
        id: z.string().min(1).describe('Stable ID, e.g. "rule:diferidos".'),
        type: z.string().min(1).describe('Entity type. Defined per-project.'),
        name: z.string().min(1).describe('Display name.'),
        body: z.string().optional().describe('Full markdown body.'),
        metadata: z
          .record(z.unknown())
          .optional()
          .describe('JSON metadata. Prefer metadata.provisional=true for agent-added entities.'),
        sourcePath: z.string().optional().describe('Source markdown path, if applicable.'),
      },
    },
    (args) => {
      entities.upsert({
        id: args.id,
        type: args.type,
        name: args.name,
        body: args.body ?? null,
        metadata: args.metadata,
        sourcePath: args.sourcePath ?? null,
      })
      return {
        content: [
          { type: 'text', text: JSON.stringify({ upserted: true, id: args.id }, null, 2) },
        ],
      }
    }
  )

  server.registerTool(
    'kb_add_edge',
    {
      title: 'Insert or update an edge',
      description:
        'Upsert an edge (src, dst, relation). Both src and dst must already exist as entities. ' +
        'Re-asserting the same edge updates its metadata.',
      inputSchema: {
        src: z.string().min(1).describe('Source entity ID.'),
        dst: z.string().min(1).describe('Destination entity ID.'),
        relation: z
          .string()
          .min(1)
          .describe('Relation type (e.g. "depends_on", "supersedes", "cites").'),
        metadata: z.record(z.unknown()).optional().describe('JSON metadata for the edge.'),
      },
    },
    (args) => {
      // Defensive: verify both endpoints exist so we return a clear error
      // instead of letting FK constraint failures bubble as opaque sqlite errors.
      const srcExists = entities.getById(args.src) !== null
      const dstExists = entities.getById(args.dst) !== null
      if (!srcExists || !dstExists) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  error: 'missing_endpoint',
                  srcExists,
                  dstExists,
                  hint: 'Both src and dst must be inserted as entities first via kb_add_entity.',
                },
                null,
                2
              ),
            },
          ],
          isError: true,
        }
      }
      edges.upsert({
        src: args.src,
        dst: args.dst,
        relation: args.relation,
        metadata: args.metadata,
      })
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              { upserted: true, src: args.src, dst: args.dst, relation: args.relation },
              null,
              2
            ),
          },
        ],
      }
    }
  )
}
