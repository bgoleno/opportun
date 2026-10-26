-- Full-text search index (FR-O9). Drizzle does not model virtual tables, so this
-- migration is hand-written (generated with drizzle-kit generate --custom).
--
-- One row per searchable entity, maintained by the repository write paths:
--   opportunity:   title + description_md
--   activity:      title + body_md
--   communication: subject + snippet
-- Only `text` is tokenized; the other columns are UNINDEXED so a query can never match
-- an id. Every search filters on user_id and joins back to the owning row.
--
-- This is a regular (content-storing) FTS5 table rather than a contentless one:
-- snippet() needs the stored text, and returns NULL on a contentless table.
CREATE VIRTUAL TABLE `search_index` USING fts5(
  entity_kind UNINDEXED,
  entity_id UNINDEXED,
  user_id UNINDEXED,
  text,
  tokenize = 'unicode61 remove_diacritics 2'
);
--> statement-breakpoint
INSERT INTO `search_index` (entity_kind, entity_id, user_id, text)
SELECT 'opportunity', id, user_id, title || char(10) || coalesce(description_md, '')
FROM `opportunities`;
--> statement-breakpoint
INSERT INTO `search_index` (entity_kind, entity_id, user_id, text)
SELECT 'activity', id, user_id, title || char(10) || coalesce(body_md, '')
FROM `activities`;
--> statement-breakpoint
INSERT INTO `search_index` (entity_kind, entity_id, user_id, text)
SELECT 'communication', id, user_id, coalesce(subject, '') || char(10) || coalesce(snippet, '')
FROM `communications`;
