-- comms.classify: hard-constraint violations must beat the fit tie-break. Observed live
-- (2026-10-17): a recruiter InMail stating $150,000 and a relocation requirement was classified
-- targeted, because the tie-break said function+seniority fit wins, and auto-entered the
-- pipeline against a 200k-floor remote-only role target. Hand-written (the 0007 pattern):
-- replace() is a no-op where a user rewrote the text, so every statement applies to all
-- comms.classify rows, system default and user versions alike.
UPDATE `prompts`
   SET `body` = replace(`body`, 'fits at least one role target (function and title family, seniority, location or remote preference, domain).', 'fits at least one role target (function and title family, seniority, location or remote preference, compensation, domain).'),
       `updated_at` = 1792195200014
 WHERE `task_key` = 'comms.classify';
--> statement-breakpoint
UPDATE `prompts`
   SET `body` = replace(`body`, 'Tie-breaks: between targeted and irrelevant, choose targeted when function and seniority both fit.', 'Tie-breaks: a stated hard-constraint violation (pay below a target''s compensation minimum, onsite or relocation required when the remote preference is remote, wrong country) makes it irrelevant even when function and seniority fit. Otherwise, between targeted and irrelevant, choose targeted when function and seniority both fit.'),
       `updated_at` = 1792195200014
 WHERE `task_key` = 'comms.classify';
--> statement-breakpoint
UPDATE `prompts`
   SET `body` = replace(`body`, 'for example "junior role, targets are staff level" or "onsite in another country". Otherwise null.', 'for example "junior role, targets are staff level", "onsite in another country" or "pay below the compensation minimum". Otherwise null.'),
       `updated_at` = 1792195200014
 WHERE `task_key` = 'comms.classify';
--> statement-breakpoint
UPDATE `prompts`
   SET `body` = replace(`body`, '6. confidence: from 0 to 1, how sure you are of classification and outreachKind together. Use a value below 0.5 when the message is ambiguous.', '6. confidence: from 0 to 1, how sure you are of classification and outreachKind together. Use a value below 0.5 when the message is ambiguous.
7. hardConstraintViolation: when the message itself states pay, location or an onsite/relocation requirement that violates a role target (for example a salary below the compensation minimum, or relocation required when the remote preference is remote), a short phrase naming that conflict, like "pay 150,000 below the 200,000 minimum". Otherwise null, including when the message simply does not mention pay or location.'),
       `updated_at` = 1792195200014
 WHERE `task_key` = 'comms.classify';
