-- resume.tailor (issue #11): the match report is model output produced over the hostile job
-- description, so the placeholder is now {{match_report_untrusted}}, which renderPrompt fences.
-- The seeded system default only (`user_id IS NULL`): a user's own versions are theirs to
-- edit, and tailorSystem reads any stored {{match_report}} through the new name at render
-- time, so a customized prompt is fenced too without this migration touching it.
UPDATE `prompts`
   SET `body` = replace(`body`, '{{match_report}}', '{{match_report_untrusted}}'),
       `updated_at` = 1792750000000
 WHERE `task_key` = 'resume.tailor' AND `user_id` IS NULL;
