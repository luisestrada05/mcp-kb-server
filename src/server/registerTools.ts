import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { EntityRepo } from '../repos/EntityRepo.js'
import type { EdgeRepo } from '../repos/EdgeRepo.js'
import type { SearchRepo } from '../repos/SearchRepo.js'
import { registerFindTool } from './tools/find.js'
import { registerGetTool } from './tools/get.js'
import { registerTraverseTool } from './tools/traverse.js'
import { registerRelatedTool } from './tools/related.js'
import { registerByTermTool } from './tools/byTerm.js'
import { registerWriteTools } from './tools/writes.js'

export interface RegisterToolsOptions {
  /**
   * If true, registers the write tools (kb_add_entity, kb_add_edge). Off by
   * default. Read-only is the safer posture for KBs whose canonical source is
   * git-tracked markdown.
   */
  allowWrites?: boolean
}

export function registerTools(
  server: McpServer,
  repos: { entities: EntityRepo; edges: EdgeRepo; search: SearchRepo },
  opts: RegisterToolsOptions = {}
): void {
  registerFindTool(server, repos.search)
  registerGetTool(server, repos.entities)
  registerTraverseTool(server, repos.edges)
  registerRelatedTool(server, repos.edges)
  registerByTermTool(server, repos.search)
  if (opts.allowWrites) {
    registerWriteTools(server, repos.entities, repos.edges)
  }
}
