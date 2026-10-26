import { Link } from '@tanstack/react-router';
import { Inbox } from 'lucide-react';
import { cn } from '@/lib/utils';

/** Count of ingested communications awaiting review, linking to the Inbox. */
export function TriageBadge({ count }: { count: number }) {
  const label =
    count === 0
      ? 'Inbox is clear'
      : `${count} ${count === 1 ? 'communication needs' : 'communications need'} triage`;
  return (
    <Link
      to="/inbox"
      className={cn(
        'inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
        count > 0
          ? 'border-transparent bg-primary text-primary-foreground hover:bg-primary/90'
          : 'bg-card text-muted-foreground hover:bg-accent hover:text-accent-foreground',
      )}
    >
      <Inbox className="size-4" aria-hidden="true" />
      {label}
    </Link>
  );
}
