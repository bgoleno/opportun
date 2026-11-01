-- The Contacts section is renamed Network (issue https://github.com/bgoleno/opportun/issues/22):
-- the contacts table becomes network_contacts, and its primary key, foreign keys and indexes
-- take the names drizzle derives from the new table name. Twin of
-- drizzle/0038_network_contacts.sql.
--
-- Written by hand in place of what drizzle-kit generated. drizzle-kit renamed the table, then
-- dropped and re-added the three foreign keys (re-validating every row) and dropped and
-- rebuilt both indexes, and left the primary key named contacts_pkey. Renames reach the same
-- schema without touching a row: they change only the catalog, and renaming the primary key
-- constraint renames its index too. The names must match meta/0020_snapshot.json (drizzle-kit's
-- own output for this change), because a later generated migration that drops one of these
-- constraints or indexes will name it as the snapshot does.
ALTER TABLE "contacts" RENAME TO "network_contacts";--> statement-breakpoint
ALTER TABLE "network_contacts" RENAME CONSTRAINT "contacts_pkey" TO "network_contacts_pkey";--> statement-breakpoint
ALTER TABLE "network_contacts" RENAME CONSTRAINT "contacts_user_id_users_id_fk" TO "network_contacts_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "network_contacts" RENAME CONSTRAINT "contacts_current_company_id_companies_id_fk" TO "network_contacts_current_company_id_companies_id_fk";--> statement-breakpoint
ALTER TABLE "communications" RENAME CONSTRAINT "communications_contact_id_contacts_id_fk" TO "communications_contact_id_network_contacts_id_fk";--> statement-breakpoint
ALTER INDEX "contacts_user_id_idx" RENAME TO "network_contacts_user_id_idx";--> statement-breakpoint
ALTER INDEX "contacts_user_company_idx" RENAME TO "network_contacts_user_company_idx";
