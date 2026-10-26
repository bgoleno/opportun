import { createFileRoute } from '@tanstack/react-router';
import { Inbox } from '@/components/comms/Inbox';
import { INBOX_TABS, type InboxTab } from '@/components/comms/api';

/**
 * `?view=` selects the opening tab, so Settings can link straight to the blocked mail its
 * rules produced. An unknown value falls back rather than failing the route: this is a deep
 * link people will type and paste, not an API.
 */
export const Route = createFileRoute('/inbox')({
  validateSearch: (search: Record<string, unknown>): { view?: InboxTab } => {
    const view = INBOX_TABS.find((t) => t === search['view']);
    return view === undefined ? {} : { view };
  },
  component: InboxRoute,
});

function InboxRoute() {
  const { view } = Route.useSearch();
  return <Inbox initialTab={view} />;
}
