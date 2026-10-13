-- 0002_embeddings.sql — semantic vectors for hybrid search.
--
-- Design notes:
--   * One vector per entity, built offline by `kb-ingest embed` from the same
--     `name + body` text FTS indexes. The server only reads this table.
--   * `vector` is raw little-endian float32 (the layout of a Float32Array, and
--     also what sqlite-vec reads), L2-normalized so dot product = cosine.
--   * `model` records which embedding model produced the vector. The server
--     embeds queries with that same model; mixing models would compare
--     vectors from different spaces, so `kb-ingest embed` keeps a single one.
--   * `content_hash` lets `kb-ingest embed` skip entities whose text did not
--     change since the last run, and lets `status` report stale vectors.
--   * A plain table (not a sqlite-vec virtual table) keeps the schema loadable
--     without native extensions; search is a brute-force scan, fine up to
--     ~100k entities.

CREATE TABLE IF NOT EXISTS embeddings (
  entity_id     TEXT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
  model         TEXT NOT NULL,
  dims          INTEGER NOT NULL,
  content_hash  TEXT NOT NULL,
  vector        BLOB NOT NULL,
  updated_at    TEXT NOT NULL
);
