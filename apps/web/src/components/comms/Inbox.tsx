import type { CommChannel } from '@opportun/core';
import { Link } from '@tanstack/react-router';
import { ArrowDownWideNarrow, ArrowUpWideNarrow, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { FormError } from '@/components/FormError';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from '@/components/ui/toast';
import { errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/opportunities';
import {
  channelLabel,
  useBulkTriage,
  useGmailStatus,
  useGmailSync,
  useInbox,
  type InboxFilters,
  type InboxTab,
} from './api';
import { BlockedRow } from './BlockedRow';
import { InboxRow, type RowMode } from './InboxRow';
import type { RejectionReason } from './RejectForm';

const TABS: { tab: InboxTab; label: string; mode: RowMode; empty: string; note?: string }[] = [
  {
    tab: 'needs_review',
    label: 'Needs review',
    mode: 'review',
    empty: 'Nothing needs review.',
    note: 'Job-related messages that are not linked to an opportunity yet, or that the classifier was unsure about.',
  },
  {
    tab: 'linked',
    label: 'Linked',
    mode: 'linked',
    empty: 'No messages are linked to opportunities yet.',
  },
  {
    tab: 'spam',
    label: 'Spam',
    mode: 'spam',
    empty: 'No broadcast recruiter spam.',
    note: 'Mass or templated outreach. It never creates opportunities. Use Not spam to bring one back.',
  },
  {
    tab: 'filtered',
    label: 'Filtered',
    mode: 'filtered',
    empty: 'No filtered outreach.',
    note: 'Genuine roles that do not fit your role targets, with the reason.',
  },
  {
    tab: 'blocked',
    label: 'Blocked',
    // Unused: the blocked tab renders BlockedRow, which takes no mode.
    mode: 'filtered',
    empty: 'Nothing has been blocked by your mail filters.',
    note: 'Kept out by your mail filters before anything read them. Opportun stored the sender and the date, never the subject or the message. Edit the rules in Settings, Mail filters.',
  },
];

const CHANNELS: CommChannel[] = ['gmail', 'apple_mail', 'linkedin'];

const BULK_REASONS: { value: RejectionReason; label: string }[] = [
  { value: 'not_job_related', label: 'Not about the job search' },
  { value: 'wrong_role', label: 'Wrong role' },
  { value: 'wrong_company', label: 'Wrong company' },
  { value: 'spam', label: 'Spam' },
  { value: 'other', label: 'Other' },
];

export function Inbox({ initialTab }: { initialTab?: InboxTab }) {
  return (
    <section>
      <PageHeader
        title="Inbox"
        description="Recruiter messages that need your attention."
        actions={<SyncControl />}
      />
      <Tabs defaultValue={initialTab ?? 'needs_review'}>
        {/* Five tabs with counts are wider than a phone; scroll the strip instead of letting it
            widen the whole page past the viewport (which clipped every row on the right). */}
        <TabsList className="max-w-full justify-start overflow-x-auto">
          {TABS.map((t) => (
            <TabsTrigger key={t.tab} value={t.tab}>
              {t.label}
              <TabCount tab={t.tab} />
            </TabsTrigger>
          ))}
        </TabsList>
        {TABS.map((t) => (
          <TabsContent key={t.tab} value={t.tab} className="grid gap-3 pt-2">
            {t.note ? <p className="text-sm text-muted-foreground">{t.note}</p> : null}
            <InboxList tab={t.tab} mode={t.mode} empty={t.empty} />
          </TabsContent>
        ))}
      </Tabs>
    </section>
  );
}

function TabCount({ tab }: { tab: InboxTab }) {
  // Unfiltered on purpose: the badge is the whole view's size, not the filtered subset.
  const { data } = useInbox(tab);
  if (!data || data.total === 0) return null;
  return <span className="ml-1 text-xs tabular-nums">({data.total})</span>;
}

/** Keyword and sender are typed, so they are applied on a short delay rather than per keystroke. */
function useDebounced<T>(value: T, ms = 250): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

function FilterBar({
  q,
  sender,
  channel,
  order,
  onQ,
  onSender,
  onChannel,
  onToggleOrder,
}: {
  q: string;
  sender: string;
  channel: CommChannel | '';
  order: 'newest' | 'oldest';
  onQ: (v: string) => void;
  onSender: (v: string) => void;
  onChannel: (v: CommChannel | '') => void;
  onToggleOrder: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input
        type="search"
        placeholder="Search subject, text or sender"
        aria-label="Keyword"
        value={q}
        onChange={(e) => onQ(e.target.value)}
        className="h-9 w-full sm:w-64"
      />
      <Input
        type="search"
        placeholder="Filter by sender"
        aria-label="Sender"
        value={sender}
        onChange={(e) => onSender(e.target.value)}
        className="h-9 w-full sm:w-48"
      />
      <Select
        aria-label="Source"
        value={channel}
        onChange={(e) => onChannel(e.target.value as CommChannel | '')}
        className="w-full sm:w-40"
      >
        <option value="">All sources</option>
        {CHANNELS.map((c) => (
          <option key={c} value={c}>
            {channelLabel(c)}
          </option>
        ))}
      </Select>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={onToggleOrder}
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
  );
}

function BulkBar({ ids, onDone }: { ids: string[]; onDone: () => void }) {
  const bulk = useBulkTriage();
  const [reason, setReason] = useState<RejectionReason>(BULK_REASONS[0]?.value ?? 'other');
  const reject = () => {
    bulk.mutate(
      { ids, action: { kind: 'reject', reason } },
      {
        onSuccess: (res) => {
          toast({
            title: `${res.succeeded} rejected`,
            description:
              res.skipped > 0 ? `${res.skipped} skipped (not yours or already gone).` : undefined,
          });
          onDone();
        },
        onError: (err) =>
          toast({
            title: 'Bulk reject failed',
            description: errorMessage(err),
            variant: 'destructive',
          }),
      },
    );
  };
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border bg-card px-3 py-2 text-sm">
      <span className="tabular-nums">{ids.length} selected</span>
      <Select
        aria-label="Rejection reason"
        value={reason}
        onChange={(e) => setReason(e.target.value as RejectionReason)}
        className="w-48"
      >
        {BULK_REASONS.map((r) => (
          <option key={r.value} value={r.value}>
            {r.label}
          </option>
        ))}
      </Select>
      <Button type="button" size="sm" onClick={reject} disabled={bulk.isPending}>
        {bulk.isPending ? 'Rejecting...' : `Reject ${ids.length}`}
      </Button>
      <Button type="button" variant="ghost" size="sm" onClick={onDone} disabled={bulk.isPending}>
        Clear
      </Button>
    </div>
  );
}

function InboxList({ tab, mode, empty }: { tab: InboxTab; mode: RowMode; empty: string }) {
  const [q, setQ] = useState('');
  const [sender, setSender] = useState('');
  const [channel, setChannel] = useState<CommChannel | ''>('');
  const [order, setOrder] = useState<'newest' | 'oldest'>('newest');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());

  const filters: InboxFilters = {
    q: useDebounced(q),
    sender: useDebounced(sender),
    channel: channel === '' ? undefined : channel,
    order,
  };
  const { data, error, isPending } = useInbox(tab, filters);

  // Clear the selection whenever the filters change: a row that scrolls out of the filtered
  // view must not stay selected and get rejected while the user can no longer see it.
  useEffect(() => {
    setSelected(new Set());
  }, [filters.q, filters.sender, filters.channel, filters.order]);

  // The blocked view has no message content and no row-level actions, so it is not selectable
  // and shows no triage controls.
  const selectable = tab !== 'blocked';

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const clear = () => setSelected(new Set());

  return (
    <div className="grid gap-3">
      {selectable ? (
        <FilterBar
          q={q}
          sender={sender}
          channel={channel}
          order={order}
          onQ={setQ}
          onSender={setSender}
          onChannel={setChannel}
          onToggleOrder={() => setOrder((o) => (o === 'newest' ? 'oldest' : 'newest'))}
        />
      ) : null}

      {selectable && selected.size > 0 ? <BulkBar ids={[...selected]} onDone={clear} /> : null}

      {error ? (
        <FormError message={errorMessage(error)} />
      ) : isPending ? (
        <p className="text-sm text-muted-foreground">Loading...</p>
      ) : data.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="grid gap-3" aria-label="Messages">
          {data.items.map((c) =>
            tab === 'blocked' ? (
              <BlockedRow key={c.id} comm={c} />
            ) : (
              <InboxRow
                key={c.id}
                comm={c}
                mode={mode}
                selected={selected.has(c.id)}
                onSelect={() => toggle(c.id)}
              />
            ),
          )}
        </ul>
      )}
    </div>
  );
}

function SyncControl() {
  const status = useGmailStatus();
  const sync = useGmailSync();
  if (status.isPending || status.isError) return null;
  if (!status.data.connected) {
    return (
      <Link
        to="/settings/integrations"
        className="text-sm text-primary underline underline-offset-2"
      >
        Connect Gmail (read-only)
      </Link>
    );
  }
  const { lastSyncAt } = status.data;
  return (
    <div className="flex items-center gap-3">
      <span className="text-xs text-muted-foreground">
        {lastSyncAt === null ? 'Not synced yet' : `Synced ${formatDateTime(lastSyncAt)}`}
      </span>
      <Button
        variant="outline"
        size="sm"
        disabled={sync.isPending}
        onClick={() =>
          sync.mutate(undefined, {
            onSuccess: () =>
              toast({
                title: 'Sync queued',
                description: 'New messages appear here once they are classified.',
              }),
            onError: (err) =>
              toast({
                title: 'Sync not started',
                description: errorMessage(err),
                variant: 'destructive',
              }),
          })
        }
      >
        <RefreshCw aria-hidden="true" />
        Sync now
      </Button>
    </div>
  );
}
