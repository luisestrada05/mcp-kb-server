import { createHash } from 'node:crypto'
import type * as Transformers from '@huggingface/transformers'

/**
 * Turns text into L2-normalized vectors. Queries and passages are embedded
 * separately because some models (the e5 family) are trained with a
 * different prefix for each side.
 */
export interface Embedder {
  readonly model: string
  embedQuery(text: string): Promise<Float32Array>
  embedPassages(texts: string[]): Promise<Float32Array[]>
}

/**
 * Default model: multilingual (Spanish included), 384 dims, ~120 MB
 * quantized, runs on CPU in-process. Downloaded once to the cache dir.
 */
export const DEFAULT_EMBED_MODEL = 'Xenova/multilingual-e5-small'

/** The text an entity contributes to its vector — same fields FTS indexes. */
export function entityText(name: string, body: string | null): string {
  return body ? `${name}\n${body}` : name
}

export function contentHash(model: string, text: string): string {
  return createHash('sha256').update(model).update('\0').update(text).digest('hex')
}

/** e5 models expect "query: " / "passage: " prefixes; other models take raw text. */
function prefixesFor(model: string): { query: string; passage: string } {
  return /(^|[/-])e5-/i.test(model)
    ? { query: 'query: ', passage: 'passage: ' }
    : { query: '', passage: '' }
}

interface FeatureExtractor {
  (
    texts: string[],
    opts: { pooling: 'mean'; normalize: boolean }
  ): Promise<{ tolist(): number[][] }>
}

export interface TransformersEmbedderOptions {
  model?: string
  /** Where model files are cached. Defaults to KB_EMBED_CACHE_DIR, else transformers.js' default. */
  cacheDir?: string
}

/**
 * Local embedder backed by transformers.js (ONNX runtime, CPU). The package
 * is an optional dependency and is imported lazily, so a server whose DB has
 * no vectors never loads it.
 */
export class TransformersEmbedder implements Embedder {
  readonly model: string
  private readonly cacheDir: string | undefined
  private extractor: Promise<FeatureExtractor> | null = null

  constructor(opts: TransformersEmbedderOptions = {}) {
    this.model = opts.model ?? DEFAULT_EMBED_MODEL
    this.cacheDir = opts.cacheDir ?? process.env.KB_EMBED_CACHE_DIR
  }

  /** Loads (downloading if needed) the model. Safe to call more than once. */
  load(): Promise<FeatureExtractor> {
    this.extractor ??= this.createExtractor().catch((err: unknown) => {
      // Let a later call retry (e.g. the network came back).
      this.extractor = null
      throw err
    })
    return this.extractor
  }

  async embedQuery(text: string): Promise<Float32Array> {
    const [v] = await this.run([prefixesFor(this.model).query + text])
    return v as Float32Array
  }

  embedPassages(texts: string[]): Promise<Float32Array[]> {
    const prefix = prefixesFor(this.model).passage
    return this.run(texts.map((t) => prefix + t))
  }

  private async run(texts: string[]): Promise<Float32Array[]> {
    const extract = await this.load()
    const out = await extract(texts, { pooling: 'mean', normalize: true })
    return out.tolist().map((row) => Float32Array.from(row))
  }

  private async createExtractor(): Promise<FeatureExtractor> {
    let transformers: typeof Transformers
    try {
      transformers = await import('@huggingface/transformers')
    } catch (err) {
      throw new Error(
        `embeddings need the optional dependency @huggingface/transformers (${String(err)})`
      )
    }
    if (this.cacheDir) transformers.env.cacheDir = this.cacheDir
    const pipe = await transformers.pipeline('feature-extraction', this.model, { dtype: 'q8' })
    return pipe as unknown as FeatureExtractor
  }
}
