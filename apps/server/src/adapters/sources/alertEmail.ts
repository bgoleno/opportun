// Job alert emails as discovery leads (FR-D1 alert source). Mail from a job alert sender (the
// user's list in settings `alert_senders:<userId>`, by default LinkedIn's and Indeed's alert
// addresses) is not sent to the AI classifier: a deterministic parser extracts one partial lead
// per job (title, company, location, link; no description) and the leads enter the review queue
// through the engine's own insert path (sanitize, dedupe, lead resolution), under a synthetic,
// always-on alert_email source per user. The message itself stays stored, classified 'other',
// with no activity: a digest is not a conversation.
//
// The leads' links (often LinkedIn job pages) are metadata only and are never fetched (C-1).
import { buffer } from 'node:stream/consumers';
import type { NormalizedPosting } from '@opportun/core';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../../db/client';
import { communications } from '../../db/schema';
import { insertLeads, type RunStats } from '../../jobs/discoveryRun';
import { INDEED_ALERT_SENDER, parseIndeedAlert } from '../../lib/alertParsers/indeed';
import { LINKEDIN_ALERT_SENDER, parseLinkedInAlert } from '../../lib/alertParsers/linkedin';
import type { Storage } from '../../lib/storage';
import type { UserCtx } from '../../repos/base';
import { markAlertDigest } from '../../repos/communications';
import { ensureChannelSource, type DiscoverySourceRow } from '../../repos/discovery';
import { readUserSetting } from '../../repos/userSettings';
import type { Exec } from '../../db/client';

export const ALERT_SENDERS_SETTING = 'alert_senders';
/** Sender addresses (mail only, never fetched) of the supported alert digests. */
export const DEFAULT_ALERT_SENDERS: readonly string[] = [
  LINKEDIN_ALERT_SENDER,
  INDEED_ALERT_SENDER,
];

/** At most 100 lowercase addresses; shared with the settings route so validation never drifts. */
export const SendersSchema = z.array(z.string().trim().toLowerCase().min(3).max(320)).max(100);

/** The user's alert sender list (the defaults until they set one). */
export async function alertSenders(exec: Exec, ctx: UserCtx): Promise<string[]> {
  return await readUserSetting(exec, ctx, ALERT_SENDERS_SETTING, SendersSchema, [
    ...DEFAULT_ALERT_SENDERS,
  ]);
}

/** The longest From header considered; a header holding one mailbox is far shorter. */
export const MAX_FROM_HEADER_CHARS = 2000;

/**
 * True when the header can hold one mailbox only: no comma outside a quoted display name
 * (`attacker@evil.example, <alerts@board.example>` lists two), and no unterminated quoted
 * string, where whether a comma separates mailboxes cannot be told.
 */
function singleMailbox(header: string): boolean {
  let quoted = false;
  for (let i = 0; i < header.length; i++) {
    const ch = header.charAt(i);
    if (!quoted) {
      if (ch === ',') return false;
      if (ch === '"') quoted = true;
    } else if (ch === '\\') i += 1;
    else if (ch === '"') quoted = false;
  }
  return !quoted;
}

/**
 * The mailbox address of a From header, lowercased, or '' when there is none. The address is
 * the angle-addr that ENDS the header (`Name <addr>`); anything before it is display name, which
 * the sender controls freely (`"<alerts@board.example>" <attacker@evil.example>` is the
 * attacker's address). Without an angle-addr the header must be a bare addr-spec.
 *
 * A header listing several mailboxes has no single sender, so it never yields an address: the
 * trusted mailbox could sit last behind an attacker's own. For the same reason an over-long
 * header is refused rather than cut to the cap, which would make its last mailbox the ending
 * angle-addr.
 */
export function senderAddress(from: string): string {
  const header = from.trim();
  if (header.length > MAX_FROM_HEADER_CHARS || !singleMailbox(header)) return '';
  const lt = header.lastIndexOf('<');
  if (lt !== -1) {
    const angle = /^<([^<>\s"@]{1,64}@[^<>\s"@]{1,255})>$/.exec(header.slice(lt));
    return angle === null ? '' : (angle[1] as string).toLowerCase();
  }
  return /^[^<>\s"@]{1,64}@[^<>\s"@]{1,255}$/.test(header) ? header.toLowerCase() : '';
}

export async function isAlertDigest(exec: Exec, ctx: UserCtx, from: string): Promise<boolean> {
  return (await alertSenders(exec, ctx)).includes(senderAddress(from));
}

/** Leads from a digest body: the first parser that recognizes it wins. */
export function parseAlertDigest(text: string): NormalizedPosting[] {
  for (const parse of [parseLinkedInAlert, parseIndeedAlert]) {
    const leads = parse(text);
    if (leads.length > 0) return leads;
  }
  return [];
}

/** The user's synthetic alert_email source, created on first use (enabled, no schedule). */
export async function alertSource(db: Db, ctx: UserCtx): Promise<DiscoverySourceRow> {
  return await ensureChannelSource(db, ctx, 'alert_email');
}

export type DigestOutcome =
  | { status: 'processed'; runId: string; stats: RunStats }
  | { status: 'skipped'; reason: 'missing' | 'not_digest' };

/** Turns one stored digest into leads and marks the message; never calls the AI. */
export async function processAlertDigest(
  db: Db,
  ctx: UserCtx,
  storage: Storage,
  communicationId: string,
  /**
   * The message body, which is not stored (Plan 3 Task 1): ingest hands it over directly, and
   * the classify job carries it in its payload for the retry path. Without one, a row that still
   * has a body file falls back to it, and otherwise the snippet is all there is.
   */
  body?: string,
): Promise<DigestOutcome> {
  const row = await db
    .select()
    .from(communications)
    .where(and(eq(communications.userId, ctx.userId), eq(communications.id, communicationId)))
    .get();
  if (row === undefined) return { status: 'skipped', reason: 'missing' };
  if (!(await isAlertDigest(db, ctx, row.from))) return { status: 'skipped', reason: 'not_digest' };
  const text =
    body !== undefined && body.length > 0
      ? body
      : row.bodyRef === null
        ? (row.snippet ?? '')
        : (await buffer(await storage.openAttachment(row.bodyRef))).toString('utf8');
  const source = await alertSource(db, ctx);
  const { runId, stats } = await insertLeads(db, ctx, parseAlertDigest(text), source.id, row.id);
  await markAlertDigest(db, ctx, row.id);
  return { status: 'processed', runId, stats };
}
