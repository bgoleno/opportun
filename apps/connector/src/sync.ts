// One sync: read Mail newer than the cursor, push it in batches, and move the cursor only
// after the server has accepted a batch (2xx). Messages go oldest first, so a cursor taken
// after any accepted batch never skips an earlier message.
import { loadState, saveState, type ConnectorConfig, type SyncState } from './config';
import { listMail } from './mail';
import { toInbound } from './normalize';
import { pushBatch, splitBatches } from './push';
import { ConnectorError, EXIT, type ConnectorIo, type InboundMessage } from './types';

const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * Each sync re-reads this much before the cursor: a message Mail files late with an earlier
 * received date (a slow account, a Mac waking up) is still picked up. Re-pushing is harmless:
 * the server upserts on the external id.
 */
export const OVERLAP_MS = 5 * 60 * 1000;
/** Syncs that may fail to read the same message before it is given up on. */
export const MAX_READ_ATTEMPTS = 3;
/** Messages read from Mail per osascript run (one full batch). */
export const PAGE_SIZE = 100;
/** Retries after a 5xx or network failure, waiting 2s, 4s, 8s. */
const SERVER_RETRIES = 3;
const BACKOFF_BASE_MS = 2000;
/** The wait on a 429 that names none. */
const DEFAULT_RATE_WAIT_MS = 60_000;
/** 429 waits in a row before giving up on this sync. */
const MAX_RATE_WAITS = 20;

export const TOKEN_REJECTED =
  'The server rejected the device token: it was revoked, has expired or is mistyped. ' +
  'Create a new one in Opportun under Settings > Integrations > Devices, then run ' +
  '`opportun-connector init` again.';
const TOKEN_SCOPE =
  'The device token lacks the mail:push scope. Create a token for the Apple Mail connector in ' +
  'Opportun under Settings > Integrations > Devices, then run `opportun-connector init` again.';

export interface SyncSummary {
  /** Messages Mail returned (a message in two mailboxes counts twice). */
  found: number;
  /** Messages the server accepted. */
  pushed: number;
  /** Of those, new to the server. */
  inserted: number;
  /** Messages not pushed this run: unreadable (held for a retry, or for good) or refused. */
  skipped: number;
}

export interface SyncOptions {
  /** Checked between batches and during waits; an aborted sync stops cleanly. */
  signal?: AbortSignal;
  pageSize?: number;
}

class Aborted extends Error {}

interface Delivered {
  pushed: number;
  inserted: number;
  skipped: number;
}

/** Mail content for the terminal: control characters (escape sequences) masked, cut short. */
function printable(text: string): string {
  // eslint-disable-next-line no-control-regex
  const masked = text.replace(/[\u0000-\u001f\u007f-\u009f]/g, '?');
  return masked.length > 80 ? `${masked.slice(0, 80)}...` : masked;
}

async function pause(io: ConnectorIo, ms: number, signal: AbortSignal | undefined) {
  await io.clock.sleep(ms, signal);
  if (signal?.aborted === true) throw new Aborted();
}

/** Pushes one batch through rate limits and transient failures; throws when it cannot. */
async function deliver(
  io: ConnectorIo,
  config: ConnectorConfig,
  batch: InboundMessage[],
  signal: AbortSignal | undefined,
): Promise<Delivered> {
  let failures = 0;
  let rateWaits = 0;
  for (;;) {
    const res = await pushBatch(io, config, batch);
    switch (res.kind) {
      case 'ok':
        return { pushed: batch.length, inserted: res.inserted, skipped: 0 };
      case 'rate_limited': {
        rateWaits += 1;
        if (rateWaits > MAX_RATE_WAITS) {
          throw new ConnectorError('The server kept rate limiting; try again later.', EXIT.SERVER);
        }
        const wait = res.retryAfterMs ?? DEFAULT_RATE_WAIT_MS;
        io.stderr(`Server rate limit reached; waiting ${Math.ceil(wait / 1000)}s to continue.`);
        await pause(io, wait, signal);
        break;
      }
      case 'server_error':
      case 'network_error': {
        if (failures >= SERVER_RETRIES) {
          throw new ConnectorError(
            res.kind === 'server_error'
              ? `Server error (${res.status}) after ${SERVER_RETRIES} retries; try again later.`
              : `Could not reach the server after ${SERVER_RETRIES} retries: ${res.message}`,
            EXIT.SERVER,
          );
        }
        await pause(io, BACKOFF_BASE_MS * 2 ** failures, signal);
        failures += 1;
        break;
      }
      case 'unauthorized':
        throw new ConnectorError(TOKEN_REJECTED, EXIT.AUTH);
      case 'forbidden':
        throw new ConnectorError(TOKEN_SCOPE, EXIT.AUTH);
      case 'too_large': {
        // Client-side caps make this unexpected; never resend the same refusal forever.
        const first = batch[0];
        if (batch.length === 1 && first !== undefined) {
          io.stderr(
            `WARNING: skipped ${first.externalId}, "${printable(first.subject)}" sent ` +
              `${new Date(first.sentAt).toISOString()}: the server refused it as too large ` +
              '(HTTP 413) and it will not be retried. The connector keeps every request under ' +
              '12MB, so this usually means a reverse proxy in front of Opportun has a lower ' +
              'limit: raise it (nginx: client_max_body_size 12m; its default is 1m).',
          );
          return { pushed: 0, inserted: 0, skipped: 1 };
        }
        const mid = Math.ceil(batch.length / 2);
        const a = await deliver(io, config, batch.slice(0, mid), signal);
        const b = await deliver(io, config, batch.slice(mid), signal);
        return {
          pushed: a.pushed + b.pushed,
          inserted: a.inserted + b.inserted,
          skipped: a.skipped + b.skipped,
        };
      }
      case 'rejected':
        throw new ConnectorError(
          `The server refused a batch (HTTP ${res.status}${res.code === null ? '' : `, ${res.code}`}). ` +
            'Check that the connector and the server are up to date.',
          EXIT.FAILURE,
        );
    }
  }
}

export async function syncOnce(
  io: ConnectorIo,
  config: ConnectorConfig,
  opts: SyncOptions = {},
): Promise<SyncSummary> {
  const { signal } = opts;
  const pageSize = opts.pageSize ?? PAGE_SIZE;
  const summary: SyncSummary = { found: 0, pushed: 0, inserted: 0, skipped: 0 };
  const loaded = await loadState(io);
  let cursor = loaded.cursor;
  let since = cursor === null ? io.clock.now() - config.lookbackDays * DAY_MS : cursor - OVERLAP_MS;
  // The cursor's ceiling this run: just before the oldest message Mail failed to read.
  let hold: number | null = null;
  let retry: SyncState['retry'];
  const state = (): SyncState => (retry === undefined ? { cursor } : { cursor, retry });

  try {
    for (;;) {
      const page = await listMail(io, { mailboxes: config.mailboxes, since, limit: pageSize });
      const pageLength = page.messages.length + page.skipped.length;
      summary.found += pageLength;

      // Mail failing to return a message (busy, a timeout) is usually transient: hold the
      // cursor before it so the next sync reads it again, up to MAX_READ_ATTEMPTS times.
      summary.skipped += page.skipped.length;
      for (const skip of [...page.skipped].sort((a, b) => a.date - b.date)) {
        if (hold !== null) break;
        const when = new Date(skip.date).toISOString();
        const attempts = (loaded.retry?.at === skip.date ? loaded.retry.attempts : 0) + 1;
        if (attempts >= MAX_READ_ATTEMPTS) {
          io.stderr(
            `WARNING: Mail failed ${attempts} times to return the message received ${when} ` +
              `(${skip.error}); gave up on it so newer mail is not held back.`,
          );
          continue;
        }
        hold = skip.date - 1;
        retry = { at: skip.date, attempts };
        io.stderr(
          `Mail could not return the message received ${when} (${skip.error}); it will be ` +
            `retried on the next sync (attempt ${attempts} of ${MAX_READ_ATTEMPTS}).`,
        );
      }

      const byId = new Map<string, { message: InboundMessage; receivedAt: number }>();
      for (const raw of page.messages) {
        try {
          const item = toInbound(raw);
          if (!byId.has(item.message.externalId)) byId.set(item.message.externalId, item);
        } catch (err) {
          // Missing id or date: reading it again cannot help.
          summary.skipped += 1;
          io.stderr(
            `WARNING: skipping a message Mail returned that cannot be pushed ` +
              `(${(err as Error).message}); it will not be retried.`,
          );
        }
      }
      const items = [...byId.values()].sort((a, b) => a.receivedAt - b.receivedAt);
      const receivedAt = new Map(items.map((i) => [i.message.externalId, i.receivedAt]));

      for (const batch of splitBatches(items.map((i) => i.message))) {
        if (signal?.aborted === true) throw new Aborted();
        const done = await deliver(io, config, batch, signal);
        summary.pushed += done.pushed;
        summary.inserted += done.inserted;
        summary.skipped += done.skipped;
        const last = receivedAt.get(batch[batch.length - 1]?.externalId ?? '');
        const next = last === undefined || hold === null ? last : Math.min(last, hold);
        if (next !== undefined && (cursor === null || next > cursor)) {
          cursor = next;
          await saveState(io, state());
        }
      }

      // A full page means more may be waiting: continue from the cursor (the page kept every
      // message sharing its last date, so "after the cursor" misses none). Stop on no
      // progress, and at a held message (paging past it would re-read the same page).
      if (pageLength < pageSize || hold !== null || cursor === null || cursor <= since) break;
      since = cursor;
    }
  } catch (err) {
    if (!(err instanceof Aborted)) throw err;
  }
  // Record a new hold, or clear one whose message has now been read.
  if (JSON.stringify(state()) !== JSON.stringify(loaded)) await saveState(io, state());
  return summary;
}
