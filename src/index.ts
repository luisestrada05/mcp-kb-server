/**
 * @kb/mcp-server — public API surface.
 *
 * Two main entry points:
 * - The MCP server binary (`kb-mcp`) — run via stdio, exposes tools to AI agents.
 * - The ingestion CLI (`kb-ingest`) — runs project-specific plugins to populate the DB.
 *
 * Library consumers can also import the DB and repository primitives directly
 * if they want to embed knowledge-graph access in their own tooling.
 */

export { Database } from './db/Database.js'
export { runMigrations } from './db/migrations.js'
export { EntityRepo } from './repos/EntityRepo.js'
export { EdgeRepo } from './repos/EdgeRepo.js'
export { SearchRepo } from './repos/SearchRepo.js'
export type { Entity, Edge, EntityInput, EdgeInput, SearchHit } from './types/kb.js'
export { VectorRepo } from './repos/VectorRepo.js'
export { HybridSearch } from './search/HybridSearch.js'
export type { FindMode, FindResult } from './search/HybridSearch.js'
export { TransformersEmbedder, DEFAULT_EMBED_MODEL } from './embeddings/Embedder.js'
export type { Embedder } from './embeddings/Embedder.js'
