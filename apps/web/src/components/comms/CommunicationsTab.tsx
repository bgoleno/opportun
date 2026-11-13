import { ArrowDownWideNarrow, ArrowUpWideNarrow } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { FormError } from '@/components/FormError';
import { Button } from '@/components/ui/button';
import { errorMessage } from '@/lib/api';
import { InboxRow } from './InboxRow';
import {
  joinThreadPages,
  THREAD_PAGE,
  useOpportunityCommunications,
  type CommunicationView,
} from './api';

type Order = 'newest' | 'oldest';

/** When a message was sent; one without a usable date sorts as the oldest. */
function sentTime(c: CommunicationView): number {
  return Number.isFinite(c.sentAt) ? c.sentAt : Number.NEGATIVE_INFINITY;
}

/**
 * The messages in `order` (#394). Oldest first is by date, then by id for messages sent at the
 * same moment, the server's own order for a thread; newest first is exactly its reverse, so
 * switching never reshuffles ties. The server is asked for the same order (so its cap keeps
 * the right 200); sorting here as well shows the page already held in the new order at once.
 */
export function orderMessages(
  items: readonly CommunicationView[],
  order: Order,
): CommunicationView[] {
  const oldestFirst = [...items].sort((a, b) => {
    const byTime = sentTime(a) - sentTime(b);
    if (byTime !== 0 && !Number.isNaN(byTime)) return byTime;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return order === 'oldest' ? oldestFirst : oldestFirst.reverse();
}

/**
 * An opportunity's linked messages (they also appear on its Timeline): newest first on every
 * load, with the Inbox's own control to read them oldest first. The choice is not remembered,
 * and no other list is touched.
 *
 * Over the server's 200 cap (#422), a line says how many are shown of how many, and "Show N
 * more" asks for the next page in the same order. Load more, not a link to the Inbox: the Inbox
 * has the same cap, and the reader keeps their place and their order here.
 */
export function CommunicationsTab({ opportunityId }: { opportunityId: string }) {
  const [order, setOrder] = useState<Order>('newest');
  const {
    data,
    error,
    isPending,
    isPlaceholderData,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
  } = useOpportunityCommunications(opportunityId, order);
  // Each message once, counted against the newest page's total: while a message the thread
  // gained between pages is missing, the line stays (#422).
  const { items, total } = data ? joinThreadPages(data.pages) : { items: [], total: 0 };
  const remaining = total - items.length;
  const offersMore = hasNextPage && remaining > 0;

  // "Show N more" goes once the thread is all shown, and a keyboard user's focus would go with
  // it: it moves to the first message the press added, or to the list if none was (#422).
  const listRef = useRef<HTMLUListElement>(null);
  const heldAtPress = useRef<Set<string> | null>(null);
  useEffect(() => {
    const before = heldAtPress.current;
    if (before === null || offersMore || isFetchingNextPage || !data) return;
    heldAtPress.current = null;
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    const shown = orderMessages(joinThreadPages(data.pages).items, order);
    const index = shown.findIndex((c) => !before.has(c.id));
    const row = index === -1 ? null : listRef.current?.children.item(index);
    if (row instanceof HTMLElement) {
      // Focusable from script only, not a tab stop: the row's own controls stay the tab stops.
      row.tabIndex = -1;
      row.focus();
    } else {
      listRef.current?.focus();
    }
  }, [offersMore, isFetchingNextPage, data, order]);

  if (error) return <FormError message={errorMessage(error)} />;
  if (isPending) return <p className="text-sm text-muted-foreground">Loading...</p>;
  if (items.length === 0 && !isPlaceholderData) {
    return (
      <p className="text-sm text-muted-foreground">
        No messages are linked yet. Link one from the Inbox.
      </p>
    );
  }
  // The other order's first page is on its way. What is held can stand in for it only when it
  // is the whole thread: part of it, re-sorted, would be the wrong messages (#422).
  const waiting = isPlaceholderData && items.length < total;
  return (
    <div className="grid gap-3">
      <div className="flex justify-end">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setOrder((o) => (o === 'newest' ? 'oldest' : 'newest'))}
          aria-label={order === 'newest' ? 'Sorted newest first' : 'Sorted oldest first'}
        >
          {order === 'newest' ? (
            <ArrowDownWideNarrow className="size-4" />
          ) : (
            <ArrowUpWideNarrow className="size-4" />
          )}
          {order === 'newest' ? 'Newest' : 'Oldest'}
        </Button>
      </div>
      {waiting ? (
        <p role="status" className="text-sm text-muted-foreground">
          {`Loading the ${order} messages...`}
        </p>
      ) : (
        <>
          {remaining > 0 ? (
            <p className="text-sm text-muted-foreground">
              {`Showing the ${order} ${items.length} of ${total} messages.`}
            </p>
          ) : null}
          <ul ref={listRef} tabIndex={-1} className="grid gap-3" aria-label="Linked messages">
            {orderMessages(items, order).map((c) => (
              <InboxRow key={c.id} comm={c} mode="opportunity" />
            ))}
          </ul>
          {offersMore ? (
            <Button
              type="button"
              variant="outline"
              className="w-fit"
              disabled={isFetchingNextPage}
              onClick={() => {
                heldAtPress.current = new Set(items.map((c) => c.id));
                void fetchNextPage();
              }}
            >
              {isFetchingNextPage ? 'Loading...' : `Show ${Math.min(remaining, THREAD_PAGE)} more`}
            </Button>
          ) : null}
        </>
      )}
    </div>
  );
}
