-- M5 auth and devices (iteration 3 plan, Tasks 2 and 8). Hand-written: the meta snapshots are
-- copies (0016 onward), so drizzle-kit generate cannot diff against them.
-- FR-S3 two-factor: users.totp_secret (0000) holds the vault-encrypted secret; these add the
-- enabled flag, the hashed recovery codes and the replay guard.
ALTER TABLE `users` ADD `totp_enabled` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `totp_recovery` text;--> statement-breakpoint
ALTER TABLE `users` ADD `totp_last_step` integer;--> statement-breakpoint
-- A password-verified login of a 2FA user parks a 'pending_2fa' row here; only the 2FA verify
-- route accepts it, and the session cookie lookup ignores every kind but 'session'.
ALTER TABLE `sessions` ADD `kind` text DEFAULT 'session' NOT NULL;--> statement-breakpoint
-- Wrong codes against one pending_2fa row; at 5 the row is deleted (a fresh password step is needed).
ALTER TABLE `sessions` ADD `failed_attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Set when a pending_2fa row is redeemed (claimed before the code check, same transaction).
ALTER TABLE `sessions` ADD `used_at` integer;--> statement-breakpoint
-- FR-M5/FR-C5 device tokens: bearer credentials for the connector and the capture extension.
CREATE TABLE `device_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`scopes` text NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `device_tokens_token_hash_unique` ON `device_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `device_tokens_user_id_idx` ON `device_tokens` (`user_id`);
