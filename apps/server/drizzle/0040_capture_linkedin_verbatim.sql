-- capture.linkedin, https://github.com/bgoleno/opportun/issues/88: a LinkedIn job capture now
-- keeps the model's location and pay only when the page text contains them (isGroundedIn, as the
-- Indeed path since #76), and its description is always the page's own. So the system default
-- asks for verbatim copies of location and pay, and no longer for a description. Updated in place
-- (it stays version 1, the shared default every user version descends from; the 0007 pattern).
-- Users' own versions are theirs and are not touched. Each replace() is a no-op once applied, so
-- re-running this changes nothing. No schema change.
UPDATE `prompts`
   SET `body` = replace(replace(replace(`body`, '- location: the city, region, or country as stated.', '- location: on a job, the location copied exactly as the page states it, with the same words and punctuation, for example a city and region, or Remote; on a profile, the city, region, or country as stated.'), '- compNote: on a job, the compensation text as stated, for example a salary range with its currency. Null for a profile.', '- compNote: on a job, the pay copied exactly as the page states it, for example a salary range with its currency and period, with nothing reworded, converted or summarized. Null for a profile.'), '- descriptionMd: on a job, the job description as clean Markdown (responsibilities, requirements, benefits), without navigation, ads, or other listings. Null for a profile.', '- descriptionMd: always null. The description is read from the page itself.
On a job, a location or pay that cannot be found word for word in the page text is thrown away, so never paraphrase them.'),
       `updated_at` = 1793700000000
 WHERE `user_id` IS NULL AND `task_key` = 'capture.linkedin';
