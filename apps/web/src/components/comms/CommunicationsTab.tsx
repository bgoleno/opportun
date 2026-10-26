import { FormError } from '@/components/FormError';
import { errorMessage } from '@/lib/api';
import { InboxRow } from './InboxRow';
import { useOpportunityCommunications } from './api';

/** An opportunity's linked messages, oldest first (they also appear on its Timeline). */
export function CommunicationsTab({ opportunityId }: { opportunityId: string }) {
  const { data, error, isPending } = useOpportunityCommunications(opportunityId);
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
    <ul className="grid gap-3" aria-label="Linked messages">
      {data.items.map((c) => (
        <InboxRow key={c.id} comm={c} mode="opportunity" />
      ))}
    </ul>
  );
}
