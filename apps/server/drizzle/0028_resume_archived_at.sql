-- Archiving a submitted resume instead of deleting it (#70). Hand-written for the same reason
-- as 0022 to 0027: drizzle-kit generate refuses this chain over the pre-existing 0015-0019 and
-- 0021-0027 snapshot collisions (see the known-issue filed alongside this migration). The
-- Postgres twin (drizzle-pg/0010_resume_archived_at.sql) IS generated.
--
-- Archived is not a status: RESUME_STATUSES stays draft/in_review/final/submitted, and a
-- submitted resume keeps that status. archived_at is a second axis set only when a delete is
-- requested for a resume whose status is already submitted; every other column, including
-- opportunity_id and every foreign key into this row, is left untouched.
ALTER TABLE `resumes` ADD COLUMN `archived_at` integer;
