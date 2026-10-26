-- Full-text search index on Postgres (FR-O9; iteration 4 Task 11). Postgres-only: SQLite
-- keeps its FTS5 virtual table (drizzle/0001_fts.sql). Drizzle does not model this table on
-- either engine, so it is hand-written and absent from schema.pg.ts and the snapshots.
--
-- One row per searchable entity (opportunity, activity, communication, contact), maintained
-- by the repository write paths in the same transaction as the row change (repos/search.ts).
-- `text` is the entity's text as stored on SQLite; `tsv` is built by the writer from the
-- same text normalized in application code the way FTS5's unicode61 tokenizer
-- (remove_diacritics 2) would split and fold it, so both engines index the same terms. The
-- 'simple' configuration has no stemming and no stop words, like unicode61.
CREATE TABLE "search_index" (
	"entity_kind" text NOT NULL,
	"entity_id" text NOT NULL,
	"user_id" text NOT NULL,
	"text" text NOT NULL,
	"tsv" tsvector NOT NULL,
	CONSTRAINT "search_index_pk" PRIMARY KEY ("user_id", "entity_kind", "entity_id")
);
--> statement-breakpoint
CREATE INDEX "search_index_tsv_idx" ON "search_index" USING gin ("tsv");
