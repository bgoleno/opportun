ALTER TABLE `users` ADD `last_seen_at` integer;--> statement-breakpoint
-- Backfill (issue #320). users.last_seen_at did not exist before this migration, so the only
-- history available for an existing row is whatever session it happens to have open right now
-- -- the same max(sessions.last_seen_at) the admin list used to compute live on every read
-- (routes/auth.ts), filtered to kind='session' so a pending_2fa row is never read as a sign-in.
-- Hand-written, not drizzle-kit generate: the tool only diffs structure, never data.
--
-- This only reaches users with a session row right now; everyone else is left NULL, which is
-- honest (no invented timestamp) rather than a failure. On the demo instance specifically,
-- after its nightly reset this will be almost nobody -- expected, not a sign anything broke.
UPDATE `users`
   SET `last_seen_at` = (
     SELECT MAX(`sessions`.`last_seen_at`)
       FROM `sessions`
      WHERE `sessions`.`user_id` = `users`.`id`
        AND `sessions`.`kind` = 'session'
   )
 WHERE EXISTS (
     SELECT 1
       FROM `sessions`
      WHERE `sessions`.`user_id` = `users`.`id`
        AND `sessions`.`kind` = 'session'
   );
