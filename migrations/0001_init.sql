-- 0001_init.sql — initial knowledge-graph schema.
--
-- Design notes:
--   * `entities` and `edges` are domain-agnostic: `type` and `relation` are free-form
--     strings the per-project plugin defines (e.g. 'rule' / 'feature' / 'decision').
--   * `metadata` is JSON for forward-compatibility; we don't model arbitrary properties
--     in a separate table because SQLite's JSON1 lets us query them efficiently
--     without the join cost of EAV.
--   * `entities_fts` is FTS5 over `name + body`. Triggers below keep it in lockstep
--     with `entities` so callers never see drift.
--   * `terms` is a separate keyword index for the "word → rules" pattern (e.g. the
--     ingestion plugin extracts term lists from frontmatter and we resolve by exact
--     match). FTS5 covers fuzzy/full-text; `terms` covers exact tag-style lookups.
--   * `updated_at` is ISO-8601 UTC text. SQLite stores it as TEXT — we don't use
--     the broken DATETIME affinity.

CREATE TABLE IF NOT EXISTS entities (
  id            TEXT PRIMARY KEY,
  type          TEXT NOT NULL,
  name          TEXT NOT NULL,
  body          TEXT,
  metadata      TEXT NOT NULL DEFAULT '{}',  -- JSON object
  source_path   TEXT,
  updated_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_entities_type        ON entities(type);
CREATE INDEX IF NOT EXISTS idx_entities_source_path ON entities(source_path);

CREATE TABLE IF NOT EXISTS edges (
  src       TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  dst       TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  relation  TEXT NOT NULL,
  metadata  TEXT NOT NULL DEFAULT '{}',  -- JSON object
  PRIMARY KEY (src, dst, relation)
);

CREATE INDEX IF NOT EXISTS idx_edges_src_relation ON edges(src, relation);
CREATE INDEX IF NOT EXISTS idx_edges_dst_relation ON edges(dst, relation);

-- Keyword index. Same term can map to many entities; same entity can have many
-- terms. Designed for the "word in requirement → rule" lookup pattern.
CREATE TABLE IF NOT EXISTS terms (
  term       TEXT NOT NULL,
  entity_id  TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  PRIMARY KEY (term, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_terms_term ON terms(term);

-- FTS5 over name + body. `content=entities` lets us point back to the source row,
-- saving storage; `content_rowid` requires we expose an INTEGER rowid on entities.
-- SQLite gives every table a hidden rowid we can reuse.
CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(
  name,
  body,
  content='entities',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);

-- Triggers to keep FTS in sync with entities. We use `INSERT INTO entities_fts(...)
-- VALUES(...)` with the special 'delete' command to remove the old row first on
-- UPDATE/DELETE — the recommended pattern for external-content FTS5 tables.
CREATE TRIGGER IF NOT EXISTS entities_fts_insert AFTER INSERT ON entities BEGIN
  INSERT INTO entities_fts(rowid, name, body) VALUES (new.rowid, new.name, new.body);
END;

CREATE TRIGGER IF NOT EXISTS entities_fts_delete AFTER DELETE ON entities BEGIN
  INSERT INTO entities_fts(entities_fts, rowid, name, body) VALUES ('delete', old.rowid, old.name, old.body);
END;

CREATE TRIGGER IF NOT EXISTS entities_fts_update AFTER UPDATE ON entities BEGIN
  INSERT INTO entities_fts(entities_fts, rowid, name, body) VALUES ('delete', old.rowid, old.name, old.body);
  INSERT INTO entities_fts(rowid, name, body) VALUES (new.rowid, new.name, new.body);
END;
