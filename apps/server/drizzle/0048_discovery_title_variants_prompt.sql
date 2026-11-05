-- System default prompt for discovery.title_variants (https://github.com/bgoleno/opportun/issues/217):
-- lists job titles equivalent to one role target for the discovery pre-filter. Hand-written
-- (the 0002 pattern). Inserted only when no system default exists yet, so re-running it
-- changes nothing.
INSERT INTO `prompts` (`id`, `user_id`, `task_key`, `name`, `body`, `version`, `parent_id`, `is_active`, `created_at`, `updated_at`)
SELECT '0199e800-0000-7000-8000-00000000000f', NULL, 'discovery.title_variants', 'default', 'You list the job titles that mean the same work as one role target, so a filter can recognize postings for it by their title alone.

## The role target
{{role_target}}

## What to list
20 to 40 distinct job titles an employer might use for this same role: common synonyms, the usual spellings and abbreviations (for example "SRE" and "Site Reliability Engineer"), and the same role at the seniority levels the target gives. Write each as a job board would show it, with no company name, location, level in brackets or other note. Leave out titles for different work, broader umbrella titles, and management titles unless the target is a management role.

## Output
titles: the list, the most common first.', 1, NULL, 1, 1794500000000, 1794500000000
WHERE NOT EXISTS (
  SELECT 1 FROM `prompts` WHERE `user_id` IS NULL AND `task_key` = 'discovery.title_variants'
);
