// Mail ingestion boundary (FR-M1). A provider yields normalized inbound messages together with
// the cursor to resume from once that message is stored. Providers only read mail (FR-M7).
import type { Db } from '../db/client';
import type { UserCtx } from '../repos/base';

export interface InboundMessage {
  externalId: string;
  threadKey: string;
  from: string;
  to: string[];
  subject: string;
  snippet: string;
  bodyText: string;
  sentAt: number;
}

export interface SyncItem {
  message: InboundMessage;
  nextCursor: unknown;
}

export interface MailProvider {
  /**
   * Yields messages newer than `cursor` (everything in the sync window when null). When the
   * iterable is an async generator, its return value is the cursor to store after the last
   * message (it can move even when nothing new arrived).
   */
  sync(db: Db, ctx: UserCtx, cursor: unknown | null): AsyncIterable<SyncItem>;
  /**
   * One message's body, read again from the provider (Plan 3 Task 2).
   *
   * Bodies are not stored, so a classification that happens later than the sync (the backfill
   * after an API key is added, a replay, the user asking for a re-classification) has nothing
   * to read. A provider that can pull a message back implements this; one that cannot leaves it
   * undefined, which is the honest answer for the Apple Mail connector (it pushes, and the
   * server never reaches the Mac) and for a LinkedIn export (a file that is gone). Null means
   * the message itself is no longer there.
   */
  fetchBody?(db: Db, ctx: UserCtx, externalId: string): Promise<string | null>;
}

/**
 * Drives a provider's sync: `onItem` runs for each message in order, and the resolved value is
 * the final cursor (the generator's return value, else the last item's nextCursor, else the
 * starting cursor).
 */
export async function runSync(
  provider: MailProvider,
  db: Db,
  ctx: UserCtx,
  cursor: unknown | null,
  onItem: (item: SyncItem) => Promise<void>,
): Promise<unknown> {
  const iterable = provider.sync(db, ctx, cursor);
  const iterator = iterable[Symbol.asyncIterator]();
  let last: unknown = cursor;
  for (;;) {
    const step = await iterator.next();
    if (step.done === true) {
      return step.value === undefined ? last : (step.value as unknown);
    }
    await onItem(step.value);
    last = step.value.nextCursor;
  }
}
