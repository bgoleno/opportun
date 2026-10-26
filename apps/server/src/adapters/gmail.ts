// Gmail mail provider (FR-M1, M7). Read-only: it lists, reads and follows history, and never
// labels, modifies or sends. The initial sync lists messages matching the user's query
// (settings gmail_query:<userId>); later syncs follow users.history.list from the stored
// historyId. An expired historyId (404) falls back to a full resync, which is safe because
// communications are upserted on (user, channel, external_id).
import { and, eq } from 'drizzle-orm';
import { decodeEntities, htmlToText, splitAddresses } from '@opportun/core';
import type { OAuth2Client } from 'google-auth-library';
import { z } from 'zod';
import type { Db } from '../db/client';
import { settings } from '../db/schema';
import {
  GMAIL_SCOPES,
  googleErrorStatus,
  withRateLimitRetry,
  type GmailMessage,
  type GmailMessagePart,
  type GoogleApi,
  type GoogleConn,
} from '../lib/google';
import type { Exec, UserCtx } from '../repos/base';
import { listRules } from '../repos/mailFilters';
import { readUserSetting, writeUserSetting } from '../repos/userSettings';
import { parseMailPattern } from '@opportun/core';
import type { InboundMessage, MailProvider, SyncItem } from './mailProvider';
import { DEFAULT_LOOKBACK_DAYS, lookbackDaysFromQuery } from '../lib/lookback';

// The HTML-to-text contract lives in @opportun/core so the Apple Mail connector shares it.
export { decodeEntities, htmlToText, splitAddresses };

export const gmailQueryForDays = (days: number): string => `newer_than:${days}d -in:spam -in:trash`;
export const DEFAULT_GMAIL_QUERY = gmailQueryForDays(DEFAULT_LOOKBACK_DAYS);
export const gmailQueryKey = (userId: string): string => `gmail_query:${userId}`;

/** The folder/label Opportun watches, when the user has chosen one (spec D0). */
export const MAIL_LABEL_SETTING = 'mail_label';
/**
 * The synced mailbox's own address, as users.getProfile reports it.
 *
 * Stored because the deep link back to a message needs it: Gmail's `/u/0` means "the browser's
 * first Google account", which need not be the mailbox Opportun syncs, and `authuser=<address>`
 * is how a link opens the right one. It is not the user's Opportun login, which may differ.
 */
export const GMAIL_ADDRESS_SETTING = 'gmail_address';
/**
 * Gmail rejects an over-long `q`, and a rejected query stops the sync entirely rather than
 * degrading, so exclusions are truncated to fit. Stage 1 enforces whatever is dropped here,
 * which is why both layers exist.
 */
export const GMAIL_QUERY_MAX_CHARS = 2000;

/** A label safe to interpolate: Gmail has no escape for a quote inside a quoted term. */
const safeLabel = (label: string): string | null => {
  const text = label.trim();
  if (text.length === 0 || text.length > 200 || /["\\\n\r]/.test(text)) return null;
  return /\s/.test(text) ? `"${text}"` : text;
};

export interface GmailQueryParts {
  days: number;
  /** null watches the whole mailbox (the default). */
  label: string | null;
  /** Whole domains the user denied, newest rule first; truncated to fit the length cap. */
  denyDomains: string[];
}

/**
 * The stored Gmail query for a user's Stage 0 scope (spec D0): an optional label, the lookback
 * window, and `-from:` terms for senders they have denied, so denied mail is never fetched at
 * all rather than fetched and dropped.
 */
export function buildGmailQuery(parts: GmailQueryParts): string {
  const label = parts.label === null ? null : safeLabel(parts.label);
  const base = [label === null ? null : `label:${label}`, gmailQueryForDays(parts.days)]
    .filter((p) => p !== null)
    .join(' ');
  let query = base;
  for (const domain of parts.denyDomains) {
    const next = `${query} -from:${domain}`;
    if (next.length > GMAIL_QUERY_MAX_CHARS) break;
    query = next;
  }
  return query;
}

/** Labels whose messages are never ingested from history (the initial query excludes them). */
const SKIPPED_LABELS: ReadonlySet<string> = new Set(['SPAM', 'TRASH', 'DRAFT']);
/** Stands in for a configured label that no longer exists, so nothing matches it. */
const NO_SUCH_LABEL = '\u0000no-such-label';

/**
 * Where a sync resumes. `initial` is a full listing in progress (pageToken is the page being
 * processed, historyId the mailbox id taken before it started); `incremental` follows history.
 */
export const GmailCursorSchema = z.object({
  phase: z.enum(['initial', 'incremental']),
  historyId: z.string().min(1),
  pageToken: z.string().optional(),
});
export type GmailCursor = z.infer<typeof GmailCursorSchema>;

export async function readGmailQuery(db: Db, ctx: UserCtx): Promise<string> {
  const value = (
    await db
      .select({ value: settings.value })
      .from(settings)
      .where(and(eq(settings.key, gmailQueryKey(ctx.userId)), eq(settings.userId, ctx.userId)))
      .get()
  )?.value;
  return typeof value === 'string' && value.trim().length > 0 ? value : DEFAULT_GMAIL_QUERY;
}

export async function writeGmailQuery(db: Exec, ctx: UserCtx, query: string): Promise<void> {
  const now = Date.now();
  await db
    .insert(settings)
    .values({ key: gmailQueryKey(ctx.userId), userId: ctx.userId, value: query, updatedAt: now })
    .onConflictDoUpdate({ target: settings.key, set: { value: query, updatedAt: now } })
    .run();
}

/** The lookback window encoded in the user's query; null when the query was hand-edited. */
export async function gmailLookbackDays(db: Db, ctx: UserCtx): Promise<number | null> {
  return lookbackDaysFromQuery(await readGmailQuery(db, ctx));
}

/**
 * The ingestion window every channel reads, in days (lib/lookback).
 *
 * It lives here because this is where the window is stored, inside the Gmail query, and not
 * because it is about Gmail: a LinkedIn export is bounded by the same number. A hand-edited
 * query answers null above, and a channel that has to apply the window itself cannot send a
 * query to anyone, so it gets the default rather than no window at all.
 */
export async function ingestLookbackDays(db: Db, ctx: UserCtx): Promise<number> {
  return (await gmailLookbackDays(db, ctx)) ?? DEFAULT_LOOKBACK_DAYS;
}

/**
 * The query the sync actually sends (spec D0): the stored query when the user hand-edited it,
 * otherwise one built from their lookback window, chosen label, and denied domains.
 *
 * Only a deny rule covering a WHOLE domain becomes a `-from:` term. Gmail's `from:` matches a
 * domain or a full address, not a local-part wildcard, so an address-level rule is left to
 * Stage 1 rather than widened into a domain exclusion the user did not ask for.
 */
export async function effectiveGmailQuery(db: Db, ctx: UserCtx): Promise<string> {
  const days = await gmailLookbackDays(db, ctx);
  // Hand-edited: the user owns it, and second-guessing it would silently change their scope.
  if (days === null) return await readGmailQuery(db, ctx);
  const label = await readUserSetting(db, ctx, MAIL_LABEL_SETTING, z.string(), '');
  const rules = await listRules(db, ctx);
  const denyDomains: string[] = [];
  for (const rule of rules) {
    if (rule.effect !== 'deny' || !rule.enabled) continue;
    const parsed = parseMailPattern(rule.pattern);
    if (parsed === null || parsed.subdomains || parsed.local !== '*') continue;
    if (!denyDomains.includes(parsed.domain)) denyDomains.push(parsed.domain);
  }
  return buildGmailQuery({ days, label: label.length === 0 ? null : label, denyDomains });
}

// ---------------------------------------------------------------------------
// Message normalization

const decodeB64 = (data: string): string => Buffer.from(data, 'base64url').toString('utf8');

/** Reads one part's content by attachmentId (users.messages.attachments.get), base64url. */
export type AttachmentFetcher = (attachmentId: string) => Promise<string>;

async function findPart(
  part: GmailMessagePart | null | undefined,
  mime: string,
  fetchAttachment: AttachmentFetcher | undefined,
): Promise<string | undefined> {
  if (part === null || part === undefined) return undefined;
  const isAttachment = typeof part.filename === 'string' && part.filename.length > 0;
  if (!isAttachment && part.mimeType?.toLowerCase() === mime) {
    if (part.body?.data) return decodeB64(part.body.data);
    // Large parts arrive this way instead of inline (observed on real mail, not just file
    // attachments): without a fetcher there is nothing more to do than treat it as not found.
    if (fetchAttachment && part.body?.attachmentId) {
      return decodeB64(await fetchAttachment(part.body.attachmentId));
    }
  }
  for (const child of part.parts ?? []) {
    const found = await findPart(child, mime, fetchAttachment);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** The text/plain part when there is one, otherwise the HTML part stripped to text. */
export async function bodyTextOf(
  payload: GmailMessagePart | null | undefined,
  fetchAttachment?: AttachmentFetcher,
): Promise<string> {
  const plain = await findPart(payload, 'text/plain', fetchAttachment);
  if (plain !== undefined) return plain.replace(/\r\n/g, '\n').trim();
  const html = await findPart(payload, 'text/html', fetchAttachment);
  // Links are kept: an html-only message's posting link is critical information.
  return html === undefined ? '' : htmlToText(html, { keepLinks: true });
}

function header(payload: GmailMessagePart | null | undefined, name: string): string {
  const lower = name.toLowerCase();
  const h = (payload?.headers ?? []).find((x) => x.name?.toLowerCase() === lower);
  return h?.value ?? '';
}

export async function toInbound(
  msg: GmailMessage,
  fetchAttachment?: AttachmentFetcher,
): Promise<InboundMessage> {
  const sent = Number(msg.internalDate);
  const dateHeader = Date.parse(header(msg.payload, 'Date'));
  return {
    externalId: msg.id,
    threadKey: msg.threadId,
    from: header(msg.payload, 'From') || '(unknown sender)',
    to: splitAddresses(header(msg.payload, 'To')),
    subject: header(msg.payload, 'Subject'),
    snippet: decodeEntities(msg.snippet ?? ''),
    bodyText: await bodyTextOf(msg.payload, fetchAttachment),
    sentAt: Number.isFinite(sent) && sent > 0 ? sent : Number.isFinite(dateHeader) ? dateHeader : 0,
  };
}

// ---------------------------------------------------------------------------
// The provider

export function createGmailProvider(google: GoogleApi, conn: GoogleConn): MailProvider {
  // A part too large for Gmail to inline (body.attachmentId, no body.data) needs its own read;
  // bound to one client and message so every toInbound call site stays a one-liner.
  const attachmentFetcherFor =
    (client: OAuth2Client, messageId: string): AttachmentFetcher =>
    async (attachmentId) => {
      const att = await withRateLimitRetry(() =>
        google.gmailGetAttachment(client, messageId, attachmentId),
      );
      return att.data;
    };

  return {
    /**
     * Reads one message again, by the id the row already holds. This is what replaces the stored
     * body for a classification that happens after the sync: Gmail is the one channel that can be
     * asked, which is why `fetchBody` is optional on the provider rather than assumed.
     *
     * A message deleted in the mailbox answers 404, which is null here: there is nothing to read
     * and nothing to retry.
     */
    async fetchBody(db, ctx, externalId) {
      const client = await conn.getClient(db, ctx, GMAIL_SCOPES);
      try {
        const msg = await withRateLimitRetry(() => google.gmailGetMessage(client, externalId));
        return (await toInbound(msg, attachmentFetcherFor(client, msg.id))).bodyText;
      } catch (err) {
        if (googleErrorStatus(err) === 404) return null;
        throw err;
      }
    },

    async *sync(db, ctx, rawCursor): AsyncGenerator<SyncItem, GmailCursor> {
      const client = await conn.getClient(db, ctx, GMAIL_SCOPES);
      const parsed = GmailCursorSchema.safeParse(rawCursor);
      const cursor = parsed.success ? parsed.data : null;
      // Every Gmail call waits out per-user rate limits: the initial backlog fires a page of
      // message gets back to back, which exhausts the per-minute quota (observed: 6,000
      // units/min/user, 5 per get). After the first trip, gets pace themselves to a rate the
      // window sustains; before one, the sync runs at full speed (and tests stay instant).
      let paceMs = 0;
      const onRateLimit = (): void => {
        paceMs = 120;
      };
      const getMessage = async (id: string): Promise<GmailMessage> => {
        if (paceMs > 0) await new Promise((resolve) => setTimeout(resolve, paceMs));
        return withRateLimitRetry(() => google.gmailGetMessage(client, id), { onRateLimit });
      };
      /**
       * The profile call, which the sync makes anyway for the history id, also reports the
       * mailbox's address. Stored on the way past, because the deep link back to a message needs
       * it (see GMAIL_ADDRESS_SETTING) and there is no other moment that knows it. Written only
       * when it changed, so an ordinary sync does no extra write.
       */
      const rememberProfile = async (): Promise<{ historyId: string }> => {
        const profile = await withRateLimitRetry(() => google.gmailProfile(client));
        const address = profile.emailAddress?.trim().toLowerCase() ?? '';
        if (address.length > 0) {
          const known = await readUserSetting(db, ctx, GMAIL_ADDRESS_SETTING, z.string(), '');
          if (known !== address) {
            await writeUserSetting(db, ctx, GMAIL_ADDRESS_SETTING, address);
          }
        }
        return { historyId: profile.historyId };
      };

      async function* initial(historyId: string, from?: string): AsyncGenerator<SyncItem> {
        // Stage 0 (spec D0): label scope and denied senders are applied here, so excluded
        // mail is never fetched rather than fetched and dropped.
        const q = await effectiveGmailQuery(db, ctx);
        let pageToken = from;
        do {
          const page = await withRateLimitRetry(() =>
            google.gmailListMessages(client, { q, pageToken }),
          );
          const resume: GmailCursor = {
            phase: 'initial',
            historyId,
            ...(pageToken === undefined ? {} : { pageToken }),
          };
          for (const ref of page.messages) {
            const msg = await getMessage(ref.id);
            yield {
              message: await toInbound(msg, attachmentFetcherFor(client, msg.id)),
              nextCursor: resume,
            };
          }
          pageToken = page.nextPageToken;
        } while (pageToken !== undefined);
      }

      if (cursor === null) {
        const { historyId } = await rememberProfile();
        yield* initial(historyId);
        return { phase: 'incremental', historyId };
      }
      if (cursor.phase === 'initial') {
        yield* initial(cursor.historyId, cursor.pageToken);
        return { phase: 'incremental', historyId: cursor.historyId };
      }

      // Incremental. The stored cursor only advances once every history page is processed.
      //
      // Stage 0's label scope has to be enforced here too (spec D0). history.list takes no
      // query, so the label name is resolved to the id that history records carry and messages
      // outside it are skipped. Without this the scope would apply only to the first backfill
      // and the steady-state 15-minute sync would keep pulling the whole mailbox, which is the
      // opposite of what the settings page promises.
      const scopeLabel = await readUserSetting(db, ctx, MAIL_LABEL_SETTING, z.string(), '');
      let scopeLabelId: string | null = null;
      if (scopeLabel.length > 0) {
        const labels = await withRateLimitRetry(() => google.gmailListLabels(client));
        // A label that no longer exists must not silently widen the scope back to everything.
        scopeLabelId = labels.find((l) => l.name === scopeLabel)?.id ?? NO_SUCH_LABEL;
      }
      const inScope = (labelIds: string[] | null | undefined): boolean =>
        scopeLabelId === null || (labelIds ?? []).includes(scopeLabelId);
      let pageToken: string | undefined;
      let latest: string | undefined;
      const resume: GmailCursor = { phase: 'incremental', historyId: cursor.historyId };
      do {
        let page;
        try {
          page = await withRateLimitRetry(() =>
            google.gmailListHistory(client, { startHistoryId: cursor.historyId, pageToken }),
          );
        } catch (err) {
          if (googleErrorStatus(err) !== 404) throw err;
          // The history id expired: list everything again (upserts make this safe).
          const { historyId } = await rememberProfile();
          yield* initial(historyId);
          return { phase: 'incremental', historyId };
        }
        latest = page.historyId;
        const seen = new Set<string>();
        for (const ref of page.added) {
          if (seen.has(ref.id)) continue;
          seen.add(ref.id);
          if ((ref.labelIds ?? []).some((l) => SKIPPED_LABELS.has(l))) continue;
          if (!inScope(ref.labelIds)) continue;
          let msg: GmailMessage;
          try {
            msg = await getMessage(ref.id);
          } catch (err) {
            // Deleted between the history record and now: nothing to ingest.
            if (googleErrorStatus(err) === 404) continue;
            throw err;
          }
          if ((msg.labelIds ?? []).some((l) => SKIPPED_LABELS.has(l))) continue;
          if (!inScope(msg.labelIds)) continue;
          yield {
            message: await toInbound(msg, attachmentFetcherFor(client, msg.id)),
            nextCursor: resume,
          };
        }
        pageToken = page.nextPageToken;
      } while (pageToken !== undefined);
      return { phase: 'incremental', historyId: latest ?? cursor.historyId };
    },
  };
}
