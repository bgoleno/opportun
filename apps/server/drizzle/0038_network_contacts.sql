-- The Contacts section is renamed Network (issue https://github.com/bgoleno/opportun/issues/22):
-- the contacts table becomes network_contacts and its two indexes follow. Every row is kept,
-- and so is every communications.contact_id that points at one.
--
-- Written by hand in place of what drizzle-kit generated. drizzle-kit renamed the table and
-- then rebuilt both network_contacts and communications (CREATE TABLE __new_..., copy,
-- DROP TABLE, rename back) between PRAGMA foreign_keys=OFF and ON. migrateLocked
-- (src/db/client.ts) applies migrations inside BEGIN IMMEDIATE with foreign_keys ON, and that
-- PRAGMA does nothing inside a transaction, so those DROP TABLEs would fire the ON DELETE
-- actions of every row pointing at the dropped tables: communications.contact_id,
-- discovery_results.source_communication_id and dismissal_feedback.communication_id would all
-- be set null. None of the rebuild is needed. SQLite 3.26 and later (with legacy_alter_table
-- off, as it is here) rewrites the REFERENCES clause in communications when the table it names
-- is renamed, and no trigger or view names the table. SQLite cannot rename an index, so the two
-- are dropped and created again under the new names.
--
-- meta/0038_snapshot.json is drizzle-kit's own output for this change; only this SQL was
-- replaced. test/migrationNetworkContacts.test.ts migrates a database holding contacts and the
-- rows that point at them, and compares every row before and after.
ALTER TABLE `contacts` RENAME TO `network_contacts`;--> statement-breakpoint
DROP INDEX `contacts_user_id_idx`;--> statement-breakpoint
DROP INDEX `contacts_user_company_idx`;--> statement-breakpoint
CREATE INDEX `network_contacts_user_id_idx` ON `network_contacts` (`user_id`);--> statement-breakpoint
CREATE INDEX `network_contacts_user_company_idx` ON `network_contacts` (`user_id`,`current_company_id`);
