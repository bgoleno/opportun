-- Stage 1 triage verdict on each stored message (design 2026-10-19, D1 and D6). Hand-written
-- for the same reason as 0022: drizzle-kit refuses this chain over the pre-existing 0015-0019
-- snapshot collision. The generated Postgres twin is drizzle-pg/0005_comms_triage_decision.sql.
--
--   triage_decision  'passed'   the message reached the classifier
--                    'filtered' Stage 1 dropped it; it was never sent to any model
--                    NULL       ingested before this feature existed
--   triage_rule      which rule decided (allow_list, deny_list, consumer_domain,
--                    unreadable_sender, none), so the blocked view can explain itself
--                    WITHOUT storing the message. A filtered row keeps sender, date and the
--                    identifiers needed for a deep link, and deliberately keeps no subject,
--                    snippet or body: the incident that motivated this had its private content
--                    in the subject line ("Appointment Reminder", "Superbill").
--
-- Both nullable with no backfill: every existing message keeps NULL and behaves as it did.
ALTER TABLE `communications` ADD COLUMN `triage_decision` text;--> statement-breakpoint
ALTER TABLE `communications` ADD COLUMN `triage_rule` text;
