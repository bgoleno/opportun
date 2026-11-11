import { ArrowDownWideNarrow, ArrowUpWideNarrow } from 'lucide-react';
import { useState } from 'react';
import { FormError } from '@/components/FormError';
import { Button } from '@/components/ui/button';
import { errorMessage } from '@/lib/api';
import { InboxRow } from './InboxRow';
import { useOpportunityCommunications, type CommunicationView } from './api';

type Order = 'newest' | 'oldest';

/** When a message was sent; one without a usable date sorts as the oldest. */
function sentTime(c: CommunicationView): number {
  return Number.isFinite(c.sentAt) ? c.sentAt : Number.NEGATIVE_INFINITY;
}

/**
 * The messages in `order` (#394). Oldest first is by date, then by id for messages sent at the
 * same moment, the server's own order for a thread; newest first is exactly its reverse, so
 * switching never reshuffles ties. Sorted here rather than asked of the server, whose thread
 * order stays as it is for every other caller.
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
 */
export function CommunicationsTab({ opportunityId }: { opportunityId: string }) {
  const { data, error, isPending } = useOpportunityCommunications(opportunityId);
  const [order, setOrder] = useState<Order>('newest');
  if (error) return <FormError message={errorMessage(error)} />;
  if (isPending) return <p className="text-sm text-muted-foreground">Loading...</p>;
  if (data.items.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No messages are linked yet. Link one from the Inbox.
      </p>
    );
  }
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
      <ul className="grid gap-3" aria-label="Linked messages">
        {orderMessages(data.items, order).map((c) => (
          <InboxRow key={c.id} comm={c} mode="opportunity" />
        ))}
      </ul>
    </div>
  );
}
