import type { Database } from '../db/Database.js'
import type { SearchRepo } from '../repos/SearchRepo.js'
import { VectorRepo } from '../repos/VectorRepo.js'
import { HybridSearch } from '../search/HybridSearch.js'
import { TransformersEmbedder } from '../embeddings/Embedder.js'

/**
 * Builds kb_find's search backend for the stdio and HTTP servers. Returns
 * undefined when KB_EMBEDDINGS=0, which leaves kb_find on FTS only.
 */
export function createHybridSearch(
  db: Database,
  search: SearchRepo,
  env: NodeJS.ProcessEnv = process.env
): HybridSearch | undefined {
  if (env.KB_EMBEDDINGS === '0') return undefined
  return new HybridSearch(
    search,
    new VectorRepo(db),
    (model) => new TransformersEmbedder({ model })
  )
}

/**
 * Loads the embedding model in the background so the first kb_find doesn't
 * pay for it. A failure is logged, not fatal: kb_find falls back to FTS.
 */
export function warmup(hybrid: HybridSearch | undefined, tag: string): void {
  if (!hybrid) return
  const model = hybrid.model()
  if (!model) {
    process.stderr.write(`[${tag}] no embeddings in the KB — kb_find runs FTS only\n`)
    return
  }
  const engine = hybrid.vectorEngine()
  process.stderr.write(
    `[${tag}] vector search: ${engine.engine}${engine.reason ? ` (${engine.reason})` : ''}\n`
  )
  const started = Date.now()
  hybrid.warmup().then(
    () =>
      process.stderr.write(
        `[${tag}] embedding model ${model} ready in ${Date.now() - started}ms\n`
      ),
    (err: unknown) =>
      process.stderr.write(
        `[${tag}] embedding model ${model} failed to load, FTS only: ${String(err)}\n`
      )
  )
}
