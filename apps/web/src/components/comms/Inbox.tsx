import type { CommChannel } from '@opportun/core';
import { Link } from '@tanstack/react-router';
import { ArrowDownWideNarrow, ArrowUpWideNarrow, RefreshCw } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { ConfirmDialog } from '@/components/ConfirmDialog';
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
  filterKey,
  useBulkTriage,
  useGmailStatus,
  useGmailSyncRefresh,
  useGmailSync,
  INBOX_PAGE,
  tooLongFilters,
  useInbox,
  type InboxFilters,
  type InboxTab,
} from './api';
import { BlockedRow, STORED_ON_BLOCK } from './BlockedRow';
import { InboxRow, type RowMode } from './InboxRow';
import { INBOX_FILTER_MAX } from './limits';
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
    // What was read depends on the rule (https://github.com/bgoleno/opportun/issues/104). The
    // filters run on the user's own server (lib/mailTriage.ts triageMessage: local, no IO); some
    // of them read the subject and body there, so "nothing read it" would be false (tl on #110).
    // What is true for every filter rule is that the message went nowhere. The AI check sent its
    // opening to the user's AI provider, and its own rows say so (BlockedRow).
    note: `Kept out by your mail filters, which check each message on your own Opportun server and send it nowhere, or by the AI check, whose rows say what it sent to your AI provider. ${STORED_ON_BLOCK} Edit the rules in Settings, Mail filters.`,
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

/** `pageSize` is INBOX_PAGE for everyone who uses the app; a test passes a small one (#646). */
export function Inbox({
  initialTab,
  pageSize = INBOX_PAGE,
}: {
  initialTab?: InboxTab;
  pageSize?: number;
}) {
  return (
    <section>
      <PageHeader
        title="Inbox"
        description="Recruiter messages that need your attention."
        actions={<SyncControl />}
      />
      <Tabs defaultValue={initialTab ?? 'needs_review'}>
        <TabsList data-tour="inbox-tabs">
          {TABS.map((t) => (
            <TabsTrigger key={t.tab} value={t.tab}>
              {t.label}
              <TabCount tab={t.tab} />
            </TabsTrigger>
          ))}
        </TabsList>
        {TABS.map((t) => (
          // grid-cols-1, not a bare grid: a bare grid's one track is auto and grows to the widest
          // row's min-content, so a long sender address widened every row past the phone screen.
          <TabsContent key={t.tab} value={t.tab} className="grid grid-cols-1 gap-3 pt-2">
            {t.note ? <p className="text-sm text-muted-foreground">{t.note}</p> : null}
            <InboxList tab={t.tab} mode={t.mode} empty={t.empty} pageSize={pageSize} />
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
  tooLong,
  onQ,
  onSender,
  onChannel,
  onToggleOrder,
}: {
  q: string;
  sender: string;
  channel: CommChannel | '';
  order: 'newest' | 'oldest';
  /** The filters refused as too long (#894). */
  tooLong: readonly ('keyword' | 'sender')[];
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
        aria-invalid={tooLong.includes('keyword') || undefined}
        value={q}
        onChange={(e) => onQ(e.target.value)}
        className="h-9 w-full sm:w-64"
      />
      <Input
        type="search"
        placeholder="Filter by sender"
        aria-label="Sender"
        aria-invalid={tooLong.includes('sender') || undefined}
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

function BulkBar({
  rows,
  loading,
  openedOn,
  inFlight,
  onDone,
}: {
  rows: { id: string; opportunityId: string | null }[];
  /** The list is still loading (a new filter or page): the rows shown may be about to go. */
  loading: boolean;
  /**
   * What the confirmation was opened on (#841), null while it is closed. A reload that changes it
   * closes the confirmation with a message, so it never acts on a count the user did not see. The
   * list's, since it outlives this bar: it is the list that says when a reload took every row.
   */
  openedOn: RefObject<readonly string[] | null>;
  /** While the reject is in flight its own outcome is reported (ConfirmDialog), not the list's. */
  inFlight: RefObject<boolean>;
  onDone: () => void;
}) {
  const ids = rows.map((r) => r.id);
  const bulk = useBulkTriage();
  const [reason, setReason] = useState<RejectionReason>(BULK_REASONS[0]?.value ?? 'other');
  // Asked first (#647): a reject wipes the messages' subject, snippet and body for good.
  const [confirming, setConfirming] = useState(false);
  const count = `${ids.length} message${ids.length === 1 ? '' : 's'}`;
  const idsKey = [...ids].sort().join(',');
  useEffect(() => {
    const seen = openedOn.current;
    if (!confirming || seen === null || inFlight.current) return;
    if ([...seen].sort().join(',') === idsKey) return;
    const gone = seen.filter((id) => !ids.includes(id)).length;
    openedOn.current = null;
    setConfirming(false);
    toast({
      title: 'Nothing was rejected',
      description: `${gone} of the ${seen.length} selected messages ${gone === 1 ? 'is' : 'are'} no longer listed. Check the selection and reject again.`,
    });
    // ids is read through idsKey, its contents.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, confirming]);
  // Escape or Cancel returns focus to the button that opened the confirmation (#841). A native
  // <dialog> does that itself, but not to a disabled button, so the button is never disabled
  // while the confirmation can be open, only marked so (aria-disabled), and focus is put back
  // here too when the browser has left it on the page body.
  const opener = useRef<HTMLButtonElement>(null);
  const wasConfirming = useRef(false);
  useEffect(() => {
    if (wasConfirming.current && !confirming) {
      const active = document.activeElement;
      if (active === null || active === document.body) opener.current?.focus();
    }
    wasConfirming.current = confirming;
  }, [confirming]);
  const blocked = bulk.isPending || loading;
  const reject = async () => {
    // mutateAsync: the dialog stays open with the failure in it (ConfirmDialog), not a toast.
    // Each message goes with the link it was seen under (#666): a changed one is left alone.
    inFlight.current = true;
    let res: Awaited<ReturnType<typeof bulk.mutateAsync>>;
    try {
      res = await bulk.mutateAsync({
        items: rows.map((r) => ({ id: r.id, opportunityId: r.opportunityId })),
        action: { kind: 'reject', reason },
      });
    } finally {
      inFlight.current = false;
    }
    // Done: the bar goes with its rows (onDone), and that is not the list changing under it.
    openedOn.current = null;
    const notes = [
      res.skipped > 0 ? `${res.skipped} skipped (not yours or already gone).` : null,
      // Linked or moved in another tab or session since they were selected (#666).
      res.changed > 0
        ? `${res.changed} ${res.changed === 1 ? 'was' : 'were'} changed elsewhere and left as ${res.changed === 1 ? 'it is' : 'they are'}.`
        : null,
    ].filter((n): n is string => n !== null);
    toast({
      title: `${res.succeeded} rejected`,
      description: notes.length === 0 ? undefined : notes.join(' '),
    });
    onDone();
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
      {/* Not while the list loads (#678): a row the new filter hides still looks selected. */}
      <Button
        ref={opener}
        type="button"
        size="sm"
        aria-disabled={blocked}
        className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
        onClick={() => {
          if (blocked) return;
          openedOn.current = ids;
          setConfirming(true);
        }}
      >
        {bulk.isPending ? 'Rejecting...' : `Reject ${ids.length}`}
      </Button>
      <ConfirmDialog
        open={confirming}
        onOpenChange={(o) => {
          if (!o) openedOn.current = null;
          setConfirming(o);
        }}
        title={`Reject ${count}?`}
        description={`Rejecting removes the subject, snippet and body of ${ids.length === 1 ? 'this message' : `these ${count}`} for good. This cannot be undone.`}
        confirmLabel={`Reject ${ids.length}`}
        confirmVariant="destructive"
        // As the button that opened it (#758): a confirmation opened before a new filter applied
        // waits for its list, so it never rejects a row that filter is about to hide.
        confirmDisabled={loading}
        onConfirm={reject}
      />
      <Button type="button" variant="ghost" size="sm" onClick={onDone} disabled={bulk.isPending}>
        Clear
      </Button>
    </div>
  );
}

/**
 * "Showing 201–400 of 523", and the way to the pages before and after (#646). `shownPage` is the
 * page the rows on screen are from, which is what the range describes (#894); `page` is the one the
 * buttons step from, and differs while another page loads. `locked`: the rows answer other filters
 * than the ones set, so their other pages are not to be had.
 */
function Pager({
  page,
  shownPage,
  pageSize,
  shown,
  total,
  locked,
  loading,
  onPage,
}: {
  page: number;
  shownPage: number;
  pageSize: number;
  shown: number;
  total: number;
  locked: boolean;
  loading: boolean;
  onPage: (page: number) => void;
}) {
  const last = Math.min(shownPage * pageSize + shown, total);
  const first = Math.min(shownPage * pageSize + 1, last);
  return (
    <nav aria-label="Message pages" className="flex flex-wrap items-center gap-2 text-sm">
      <span className="tabular-nums text-muted-foreground">
        Showing {first}–{last} of {total}
      </span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        aria-label="Previous page"
        disabled={locked || page === 0}
        onClick={() => onPage(page - 1)}
      >
        Previous
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        aria-label="Next page"
        disabled={locked || (page + 1) * pageSize >= total}
        onClick={() => onPage(page + 1)}
      >
        Next
      </Button>
      {loading && page !== shownPage ? (
        <span className="text-muted-foreground">Loading page {page + 1}...</span>
      ) : null}
    </nav>
  );
}

function InboxList({
  tab,
  mode,
  empty,
  pageSize,
}: {
  tab: InboxTab;
  mode: RowMode;
  empty: string;
  pageSize: number;
}) {
  const [q, setQ] = useState('');
  const [sender, setSender] = useState('');
  const [channel, setChannel] = useState<CommChannel | ''>('');
  const [order, setOrder] = useState<'newest' | 'oldest'>('newest');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [page, setPage] = useState(0);

  const filters: InboxFilters = {
    q: useDebounced(q),
    sender: useDebounced(sender),
    channel: channel === '' ? undefined : channel,
    order,
  };
  // Too long to send (#894): said in plain words, with no rows, since none were asked for it.
  const tooLong = tooLongFilters(filters);
  const refused = tooLong.length > 0;
  const query = useInbox(tab, filters, page, pageSize);
  const fresh = refused ? undefined : query.data;
  const error = refused ? null : query.error;
  const { isPlaceholderData } = query;
  // A reload that fails keeps the list that last loaded on screen (#841), and with it the
  // selection made from it, with a note that the list could not refresh. Without it the rows,
  // the selection and an open confirmation all went at once.
  const [lastLoaded, setLastLoaded] = useState(fresh);
  useEffect(() => {
    if (fresh !== undefined) setLastLoaded(fresh);
  }, [fresh]);
  const held = fresh ?? (error ? lastLoaded : undefined);
  // What is held can answer an earlier request: while the next loads, or after it failed. Its rows
  // stay on screen then, but when it has none there is nothing to keep, and nothing it says ("no
  // messages match") is about what is asked for now (tl on #906).
  const otherFilters = held !== undefined && held.filters !== filterKey(filters);
  const otherPage = held !== undefined && !otherFilters && held.page !== page;
  const data = (otherFilters || otherPage) && held?.items.length === 0 ? undefined : held;
  // What was asked for, not what is being typed: the list on screen answers the debounced values.
  const filtered =
    (filters.q ?? '').trim() !== '' ||
    (filters.sender ?? '').trim() !== '' ||
    filters.channel !== undefined;

  // A new filter starts again from its first page (#646). The selection is not cleared with it
  // (#678): the pruning below drops a row the filter hides, and keeps one still listed.
  useEffect(() => {
    setPage(0);
  }, [filters.q, filters.sender, filters.channel, filters.order]);
  // A page left empty (its last messages rejected or linked away) steps back to the last page
  // that has any, rather than showing the tab's empty message with messages still in it.
  // Only on the page's own answer, never on the page before still shown while it loads (tl).
  useEffect(() => {
    if (isPlaceholderData) return;
    if (fresh !== undefined && page > 0 && fresh.items.length === 0 && fresh.total > 0) {
      setPage(Math.max(0, Math.ceil(fresh.total / pageSize) - 1));
    }
  }, [fresh, isPlaceholderData, page, pageSize]);
  // A row that leaves the list leaves the selection (#647): only rows on screen are ever selected.
  // That covers a filter change too, a row the new filter hides is dropped, so a row still listed
  // stays selected, and a confirmation open for it stays open (#678).
  const onScreen = useMemo(() => new Set((data?.items ?? []).map((c) => c.id)), [data]);
  useEffect(() => {
    setSelected((prev) => {
      const kept = [...prev].filter((id) => onScreen.has(id));
      return kept.length === prev.size ? prev : new Set(kept);
    });
  }, [onScreen]);
  // What the bar acts on is filtered too, so not even the render before the effect can reject a
  // row that is gone.
  // Each with the link it is shown under, which the reject is checked against (#666).
  const actOn = (data?.items ?? [])
    .filter((c) => selected.has(c.id))
    .map((c) => ({ id: c.id, opportunityId: c.opportunityId ?? null }));

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

  // When the bulk bar goes (its reject done, or its rows gone), focus that was in it or in its
  // dialog would fall to the page body (#678): it moves to this list instead.
  const bulkShown = actOn.length > 0;
  const root = useRef<HTMLDivElement>(null);
  const wasShown = useRef(false);
  const openedOn = useRef<readonly string[] | null>(null);
  const inFlight = useRef(false);
  useEffect(() => {
    if (wasShown.current && !bulkShown) {
      // The bar's rows went, and with them an open confirmation (#841): say so. Here, not when the
      // bar unmounts, which leaving the page does too, with every message still listed (#894).
      const seen = openedOn.current;
      openedOn.current = null;
      if (seen !== null && !inFlight.current) {
        toast({
          title: 'Nothing was rejected',
          description: refused
            ? 'No messages are listed while a filter is too long.'
            : seen.length === 1
              ? 'The selected message is no longer listed.'
              : `None of the ${seen.length} selected messages are listed any more.`,
        });
      }
      const active = document.activeElement;
      if (active === null || active === document.body) root.current?.focus();
    }
    wasShown.current = bulkShown;
    // `refused` is read when the bar goes, which is what this follows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bulkShown]);

  // Try again goes with the error it answers, so focus moves to the list first.
  const retry = () => {
    root.current?.focus();
    void query.refetch();
  };

  return (
    <div
      ref={root}
      tabIndex={-1}
      role="region"
      aria-label={`${TABS.find((t) => t.tab === tab)?.label ?? 'Inbox'} messages`}
      className="grid grid-cols-1 gap-3 outline-none"
    >
      {selectable ? (
        <FilterBar
          q={q}
          sender={sender}
          channel={channel}
          order={order}
          tooLong={tooLong}
          onQ={setQ}
          onSender={setSender}
          onChannel={setChannel}
          onToggleOrder={() => setOrder((o) => (o === 'newest' ? 'oldest' : 'newest'))}
        />
      ) : null}

      {selectable && bulkShown ? (
        <BulkBar
          rows={actOn}
          loading={isPlaceholderData}
          openedOn={openedOn}
          inFlight={inFlight}
          onDone={clear}
        />
      ) : null}

      {/* Not over an empty page: during a step-back that page stands in for the next (#678). */}
      {data !== undefined && data.items.length > 0 && data.total > data.items.length ? (
        <Pager
          // After a failure the buttons step from the rows shown, so Next asks again.
          page={error ? data.page : page}
          shownPage={data.page}
          pageSize={pageSize}
          shown={data.items.length}
          total={data.total}
          locked={otherFilters}
          loading={isPlaceholderData}
          onPage={(p) => (p === page ? retry() : setPage(p))}
        />
      ) : null}

      {refused ? (
        <FormError
          message={`The ${tooLong.join(' and ')} ${tooLong.length === 1 ? 'filter is' : 'filters are'} too long: ${INBOX_FILTER_MAX} characters at most. No messages are listed until ${tooLong.length === 1 ? 'it is' : 'they are'} shorter.`}
        />
      ) : null}
      {error ? (
        <>
          <FormError
            message={
              data === undefined
                ? errorMessage(error)
                : otherPage
                  ? `Page ${page + 1} couldn't load. ${errorMessage(error)} Page ${data.page + 1} is still shown.`
                  : `The list couldn't refresh. ${errorMessage(error)}${otherFilters ? ' The messages shown are from before the filters changed.' : ''}`
            }
          />
          <Button type="button" variant="outline" size="sm" className="w-fit" onClick={retry}>
            Try again
          </Button>
        </>
      ) : null}
      {refused || (error && data === undefined) ? null : data === undefined ? (
        <p className="text-sm text-muted-foreground">Loading...</p>
      ) : data.items.length === 0 && data.total > 0 ? (
        // An empty page of a tab that has messages: a step-back to a page not cached yet (#678).
        <p className="text-sm text-muted-foreground">Loading...</p>
      ) : data.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {/* With a filter set, an empty list is about the filter, not the tab (#652). */}
          {filtered ? 'No messages match these filters.' : empty}
        </p>
      ) : (
        <ul className="grid grid-cols-1 gap-3" aria-label="Messages">
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
  // The one place the lists follow the status (#645): not in useGmailStatus, which every row reads.
  useGmailSyncRefresh();
  const status = useGmailStatus();
  const sync = useGmailSync();
  if (status.isPending || status.isError) return null;
  if (!status.data.connected) {
    return (
      <Link
        to="/settings/integrations"
        data-tour="inbox-connect"
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
