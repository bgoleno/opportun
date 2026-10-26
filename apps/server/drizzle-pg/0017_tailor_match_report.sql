-- resume.tailor (issue #303): the model couldn't see the match score, so "rerun the score and
-- ask for a review" asked it to review something it had no way to read. Inserted before "## How
-- to respond" so the score lands between the job description and the response instructions,
-- matching the order the context is actually assembled in (job, resume, score, user prompt).
-- replace() is a no-op where a user rewrote this heading away; tailorSystem's own fallback
-- (prepend when {{match_report}} is absent) covers that case at render time, the same as
-- resume_rules already does.
--
-- user_id IS NULL, the seeded system default only: prompts is versioned with a nullable
-- user_id, so updating a user's own row in place would not record this as a new version. It
-- would edit their customization and stamp updated_at on it, with no route back to what they
-- wrote. tailorSystem's placeholder fallback already renders the score correctly whether or
-- not a customized prompt was ever touched by this migration, so scoping it loses nothing.
UPDATE "prompts"
   SET "body" = replace("body", '## How to respond', '## The match score
{{match_report}}

## How to respond'),
       "updated_at" = 1792657353000
 WHERE "task_key" = 'resume.tailor' AND "user_id" IS NULL;
