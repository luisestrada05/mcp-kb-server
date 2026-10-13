import type { Embedder } from '../../src/embeddings/Embedder.js'

/**
 * Deterministic stand-in for a real embedding model: each word maps to a
 * "concept" dimension, with synonyms sharing one, so texts that say the same
 * thing in different words end up close — the property hybrid search relies
 * on — without downloading a model.
 */
const CONCEPTS: Record<string, number> = {
  diferido: 0,
  diferidos: 0,
  diferir: 0,
  meses: 0,
  plazos: 0,
  msi: 0,
  interes: 1,
  intereses: 1,
  tasa: 1,
  validacion: 2,
  validar: 2,
  verificar: 2,
  revision: 2,
  comercio: 3,
  comercios: 3,
  tienda: 3,
  calculadora: 4,
  simulador: 4,
}
const DIMS = 6

export class FakeEmbedder implements Embedder {
  calls = 0
  constructor(readonly model = 'fake/concepts-v1') {}

  embedQuery(text: string): Promise<Float32Array> {
    this.calls++
    return Promise.resolve(vectorize(text))
  }

  embedPassages(texts: string[]): Promise<Float32Array[]> {
    this.calls++
    return Promise.resolve(texts.map(vectorize))
  }
}

function vectorize(text: string): Float32Array {
  const v = new Float32Array(DIMS)
  const words =
    text
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .match(/\p{L}+/gu) ?? []
  for (const w of words) v[CONCEPTS[w] ?? DIMS - 1] += 1
  const norm = Math.hypot(...v) || 1
  return v.map((x) => x / norm)
}
