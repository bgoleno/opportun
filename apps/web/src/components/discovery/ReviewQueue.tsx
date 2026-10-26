// The discovery review queue (FR-U6): pending results best AI score first, with the pipeline's
// keyboard triage (j/k select, i accept, x dismiss, p opens the posting in a new tab, Enter
// opens the in-app detail dialog). Accept and dismiss leave the queue at once and come back if
// the server refuses; a 409 duplicate on accept asks whether to attach the result to the
// existing opportunity or create one anyway. "Capture posting" adds a posting by link or pasted
// text; a needs_capture lead is completed the same way.
//
// Issue #191: one role advertised in several locations produces one result per location, so
// results are grouped for display by their dedupeKey's company+title (groupResults.ts) before
// rendering -- an ordinary result is a singleton group and behaves exactly as before. j/k, i and
// x act on a group as the selectable unit; accepting a multi-location group accepts its primary
// (best-scoring) member normally, then links every other location to the resulting opportunity
// (FR-O10's existing "another posting of a job already tracked" mechanism, not a new bulk
// endpoint); dismissing one records the same reason for every location. Enter's detail dialog
// deliberately acts on just the one result it was opened for, not its whole group, so a member
// that turns out not to belong can always be split off and triaged on its own.
import type { DismissReason } from '@opportun/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FormError } from '@/components/FormError';
import { NewOpportunityDialog } from '@/components/pipeline/NewOpportunityDialog';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { ApiError, errorMessage } from '@/lib/api';
import { safeHttpUrl } from '@/lib/opportunities';
import { useHotkeys } from '@/lib/useHotkeys';
import {
  fetchAllPendingResultIds,
  useAcceptResult,
  useBulkAccept,
  useBulkDismiss,
  useBulkUndoDismiss,
  useDismissResult,
  useReviewQueue,
  type AcceptVars,
  type BulkItemResult,
  type BulkProgress,
  type DiscoveryResult,
} from './api';
import { CaptureDialog } from './CaptureDialog';
import { groupResults, rowKey, type ResultGroup } from './groupResults';
import {
  BulkAcceptConfirmDialog,
  BulkDismissDialog,
  DismissResultDialog,
  DuplicateAcceptDialog,
  ResultDetailDialog,
  type DuplicateState,
} from './QueueDialogs';
import { QueueGroupRow, QueueRow, resultLabel } from './QueueRow';

/** One line summarizing a bulk request's per-item outcomes (design principle 6: report only
 *  what actually happened, never just "done"). `headline` is the outcome this action is meant
 *  to produce (accepted / dismissed / restored); everything else only shows up when nonzero. */
function summarize(
  results: BulkItemResult[],
  headline: 'accepted' | 'dismissed' | 'restored',
): string {
  const counts = new Map<string, number>();
  for (const r of results) counts.set(r.outcome, (counts.get(r.outcome) ?? 0) + 1);
  const n = (outcome: string) => counts.get(outcome) ?? 0;
  const parts = [`${n(headline)} ${headline}`];
  if (n('duplicate') > 0) parts.push(`${n('duplicate')} already tracked`);
  if (n('already_decided') > 0) parts.push(`${n('already_decided')} already decided`);
  if (n('not_found') > 0) parts.push(`${n('not_found')} not found`);
  if (n('error') > 0) parts.push(`${n('error')} failed`);
  return parts.join('; ');
}

export function ReviewQueue() {
  const { data, error, isPending } = useReviewQueue();
  const acceptM = useAcceptResult();
  const dismissM = useDismissResult();
  const bulkAcceptM = useBulkAccept();
  const bulkDismissM = useBulkDismiss();
  const bulkUndoM = useBulkUndoDismiss();
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [dismissing, setDismissing] = useState<ResultGroup | null>(null);
  const [detail, setDetail] = useState<DiscoveryResult | null>(null);
  const [duplicate, setDuplicate] = useState<DuplicateState | null>(null);
  /** The other locations waiting to attach once a group's primary member's accept resolves,
   *  whether immediately or after a 409 is resolved through DuplicateAcceptDialog. */
  const [groupContinuation, setGroupContinuation] = useState<readonly DiscoveryResult[] | null>(
    null,
  );
  /** Open capture dialog: lead null for a new posting, or the needs_capture lead to complete. */
  const [capture, setCapture] = useState<{ lead: DiscoveryResult | null } | null>(null);
  const [manualEntry, setManualEntry] = useState(false);
  /** Bulk-triage checkboxes (#184), independent of `selectedId` (the keyboard focus cursor):
   *  many rows can be checked for a batch, only one is ever the keyboard cursor. */
  const [checkedIds, setCheckedIdsRaw] = useState<Set<string>>(new Set());
  const [bulkAccepting, setBulkAccepting] = useState(false);
  const [bulkDismissing, setBulkDismissing] = useState(false);
  const [selectingAllMatching, setSelectingAllMatching] = useState(false);
  /** Chunk progress for a batch over MAX_BULK_SIZE (#184's "visible progress"), null between
   *  requests and once a request finishes. */
  const [bulkProgress, setBulkProgress] = useState<BulkProgress | null>(null);
  const container = useRef<HTMLUListElement>(null);
  const lastToggledIndex = useRef<number | null>(null);
  const items = data?.items;
  const groups = useMemo(() => groupResults(items ?? []), [items]);
  /** Ids we can prove belong to a multi-location group (issue #209): every member of a group
   *  with more than one member, among the currently loaded page. A multi-location group's
   *  members have no checkbox of their own on QueueGroupRow, and a flat-index range (shift-
   *  click, Shift+J/K) spanning past one must not silently pull its members in anyway -- that
   *  would reopen the same N-duplicate-opportunities risk the row's own buttons exist to avoid,
   *  just reached through a different door than the checkbox. Deliberately an exclude-list, not
   *  an allow-list: a result beyond the loaded page (reached via "select all N matching") is
   *  unknown to this computation and is not excluded by it, since there is no grouping
   *  information for it to check yet -- closing that gap needs the data layer this page cannot
   *  see, which is #209's to solve, not a reason to treat every unseen id as suspect here. */
  const groupedMemberIds = useMemo(
    () =>
      new Set(
        groups.filter((g) => g.members.length > 1).flatMap((g) => g.members.map((m) => m.id)),
      ),
    [groups],
  );

  /** The only way `checkedIds` changes (issue #209's lesson, generalized): the guard against a
   *  location group entering the selection lives here, in the model, rather than at each place
   *  that could add to it (a checkbox, a range fill, "select all," a future shortcut). A
   *  per-call-site guard fails by omission the next time someone adds a new path in; this
   *  fails by construction instead -- whatever an update would produce, group members are
   *  filtered out before it commits, so the selection cannot contain one no matter how it was
   *  reached. */
  const setCheckedIds = useCallback(
    (update: Set<string> | ((prev: Set<string>) => Set<string>)) => {
      setCheckedIdsRaw((prev) => {
        const next = typeof update === 'function' ? update(prev) : update;
        let changed = false;
        for (const id of next) {
          if (groupedMemberIds.has(id)) {
            changed = true;
            break;
          }
        }
        if (!changed) return next;
        const filtered = new Set(next);
        for (const id of filtered) if (groupedMemberIds.has(id)) filtered.delete(id);
        return filtered;
      });
    },
    [groupedMemberIds],
  );

  // A result that left the queue (accepted, dismissed, unsuppressed elsewhere) is pruned from
  // the checked set rather than left dangling: a stale id in checkedIds would otherwise be
  // silently resent in the next bulk request for a row the user can no longer even see.
  useEffect(() => {
    if (items === undefined) return;
    const present = new Set(items.map((r) => r.id));
    setCheckedIds((prev) => {
      const next = new Set([...prev].filter((id) => present.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [items, setCheckedIds]);

  function toggleChecked(id: string, shiftKey: boolean) {
    const index = (items ?? []).findIndex((r) => r.id === id);
    setCheckedIds((prev) => {
      const next = new Set(prev);
      const from = lastToggledIndex.current;
      if (shiftKey && from !== null && items !== undefined) {
        const [lo, hi] = from < index ? [from, index] : [index, from];
        for (let i = lo; i <= hi; i++) {
          const row = items[i];
          if (row !== undefined) next.add(row.id);
        }
      } else if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
    lastToggledIndex.current = index;
  }

  function clearChecked() {
    setCheckedIds(new Set());
    lastToggledIndex.current = null;
  }

  async function bulkAccept() {
    const ids = [...checkedIds];
    try {
      const results = await bulkAcceptM.mutateAsync({ ids, onProgress: setBulkProgress });
      clearChecked();
      toast({ title: summarize(results, 'accepted') });
    } catch (err) {
      toast({
        title: 'Bulk accept failed',
        description: errorMessage(err),
        variant: 'destructive',
      });
    } finally {
      setBulkProgress(null);
      // Stays open and busy (BulkAcceptConfirmDialog's busy/progress props) for the whole
      // request rather than closing on submit, so a multi-chunk batch's progress is visible
      // where the user is actually looking, not silently running behind an already-closed
      // dialog.
      setBulkAccepting(false);
    }
  }

  async function bulkDismiss(v: { reason: DismissReason; note?: string }) {
    const ids = [...checkedIds];
    try {
      const results = await bulkDismissM.mutateAsync({ ids, ...v, onProgress: setBulkProgress });
      clearChecked();
      const dismissedIds = results.filter((r) => r.outcome === 'dismissed').map((r) => r.id);
      toast({
        title: summarize(results, 'dismissed'),
        ...(dismissedIds.length > 0
          ? {
              action: {
                label: 'Undo',
                onClick: () => {
                  void bulkUndoM
                    .mutateAsync({ ids: dismissedIds })
                    .then((undone) => toast({ title: summarize(undone, 'restored') }))
                    .catch((err: unknown) =>
                      toast({
                        title: 'Undo failed',
                        description: errorMessage(err),
                        variant: 'destructive',
                      }),
                    );
                },
              },
            }
          : {}),
      });
    } catch (err) {
      toast({
        title: 'Bulk dismiss failed',
        description: errorMessage(err),
        variant: 'destructive',
      });
    } finally {
      setBulkProgress(null);
      setBulkDismissing(false);
    }
  }

  async function selectAllMatching() {
    setSelectingAllMatching(true);
    try {
      setCheckedIds(new Set(await fetchAllPendingResultIds()));
    } catch (err) {
      toast({
        title: 'Could not select all',
        description: errorMessage(err),
        variant: 'destructive',
      });
    } finally {
      setSelectingAllMatching(false);
    }
  }

  /** Moves the selection off a group that is about to leave the queue. */
  function selectNeighbourGroup(key: string) {
    if (selectedKey !== key) return;
    const i = groups.findIndex((g) => rowKey(g) === key);
    const next = groups[i + 1] ?? groups[i - 1];
    setSelectedKey(next === undefined ? null : rowKey(next));
  }

  async function acceptOne(
    r: DiscoveryResult,
    extra: Omit<AcceptVars, 'id'> = {},
  ): Promise<DiscoveryResult | undefined> {
    try {
      const accepted = await acceptM.mutateAsync({ id: r.id, ...extra });
      setDuplicate(null);
      return accepted;
    } catch (err) {
      const existingId = err instanceof ApiError ? err.details.existingId : undefined;
      if (
        err instanceof ApiError &&
        err.code === 'duplicate' &&
        typeof existingId === 'string' &&
        extra.attachTo === undefined &&
        extra.force !== true
      ) {
        setDuplicate({ result: r, existingId });
        return undefined;
      }
      toast({ title: 'Not accepted', description: errorMessage(err), variant: 'destructive' });
      return undefined;
    }
  }

  /** Links every other location in a group to the opportunity its primary member just created
   *  or was attached to. Called after acceptGroup's own primary accept, or after a 409 on the
   *  primary is resolved through DuplicateAcceptDialog (resolveDuplicate). */
  async function finishGroupContinuation(
    primaryAccepted: DiscoveryResult,
    rest: readonly DiscoveryResult[],
  ) {
    setGroupContinuation(null);
    const opportunityId = primaryAccepted.opportunityId;
    if (opportunityId === null) {
      // Never actually null after an accept, but never assumed: report what happened rather
      // than silently dropping the rest of the group (design principle 6).
      toast({
        title: 'Added to pipeline',
        description: `${resultLabel(primaryAccepted)} (could not link its other ${
          rest.length === 1 ? 'location' : `${rest.length} locations`
        }: no opportunity id came back)`,
        variant: 'destructive',
      });
      return;
    }
    const settled = await Promise.all(rest.map((m) => acceptOne(m, { attachTo: opportunityId })));
    const attached = settled.filter((r) => r !== undefined).length;
    const total = rest.length + 1;
    if (attached === rest.length) {
      toast({
        title: `Added to pipeline (${total} locations)`,
        description: resultLabel(primaryAccepted),
        variant: 'success',
      });
    } else {
      toast({
        title: `Added to pipeline, but only ${attached + 1} of ${total} locations linked`,
        description: resultLabel(primaryAccepted),
        variant: 'destructive',
      });
    }
  }

  /** Accepts a whole location group in one decision (issue #191). A singleton group (every
   *  ordinary result) has no other member to chain, so this is the one accept path for both. */
  async function acceptGroup(g: ResultGroup) {
    const [primary, ...rest] = g.members;
    if (primary === undefined) return;
    selectNeighbourGroup(rowKey(g));
    if (rest.length > 0) setGroupContinuation(rest);
    const accepted = await acceptOne(primary);
    if (accepted === undefined) return;
    if (rest.length === 0) {
      toast({ title: 'Added to pipeline', description: resultLabel(primary), variant: 'success' });
      return;
    }
    await finishGroupContinuation(accepted, rest);
  }

  /** Resolves a 409 duplicate through the dialog's Attach/Create-anyway choice, then continues
   *  a pending group chain if this accept was a group's primary member. */
  async function resolveDuplicate(s: DuplicateState, extra: Omit<AcceptVars, 'id'>) {
    const accepted = await acceptOne(s.result, extra);
    if (accepted === undefined) return;
    if (groupContinuation !== null) {
      await finishGroupContinuation(accepted, groupContinuation);
      return;
    }
    toast({
      title:
        extra.attachTo === undefined ? 'Added to pipeline' : 'Attached to the existing opportunity',
      description: resultLabel(s.result),
      variant: 'success',
    });
  }

  /** Dismisses a whole location group in one decision (issue #191), recording the same reason
   *  for every member. A singleton group is a loop of one. */
  async function dismissGroup(g: ResultGroup, v: { reason: DismissReason; note?: string }) {
    setDismissing(null);
    selectNeighbourGroup(rowKey(g));
    const primary = g.members[0];
    if (primary === undefined) return;
    const settled = await Promise.allSettled(
      g.members.map((m) => dismissM.mutateAsync({ id: m.id, ...v })),
    );
    const ok = settled.filter((r) => r.status === 'fulfilled').length;
    if (ok === g.members.length) {
      toast({
        title: g.members.length === 1 ? 'Dismissed' : `Dismissed (${g.members.length} locations)`,
        description: resultLabel(primary),
      });
    } else {
      toast({
        title: `Only ${ok} of ${g.members.length} locations dismissed`,
        description: resultLabel(primary),
        variant: 'destructive',
      });
    }
  }

  /** The selected group, but only when it is actually one of the currently rendered rows. */
  function currentGroup(): ResultGroup | undefined {
    const root = container.current;
    if (root === null) return undefined;
    const nodes = Array.from(root.querySelectorAll<HTMLElement>('[data-result-id]'));
    return nodes.some((n) => n.dataset.resultId === selectedKey)
      ? groups.find((g) => rowKey(g) === selectedKey)
      : undefined;
  }

  /** The selected result, but only when the cursor sits on a singleton group: a multi-location
   *  group has no single id to check (#184's checkbox never renders on QueueGroupRow, #209),
   *  so Space on one is correctly inert rather than checking an arbitrary member. */
  function currentResult(): DiscoveryResult | undefined {
    const g = currentGroup();
    return g !== undefined && g.members.length === 1 ? g.members[0] : undefined;
  }

  /** Moves the selection by one row. Returns whether it actually moved, so j/k only claim the
   *  keystroke (and preventDefault) when there was somewhere to move to. */
  function move(delta: 1 | -1): boolean {
    const root = container.current;
    if (root === null) return false;
    const nodes = Array.from(root.querySelectorAll<HTMLElement>('[data-result-id]'));
    if (nodes.length === 0) return false;
    const index = nodes.findIndex((n) => n.dataset.resultId === selectedKey);
    const next = index === -1 ? 0 : Math.min(Math.max(index + delta, 0), nodes.length - 1);
    const node = nodes.at(next);
    if (node === undefined) return false;
    setSelectedKey(node.dataset.resultId ?? null);
    node.focus();
    return true;
  }

  /** The flat `items`-array index of a navigable unit's own member, only when it is a
   *  singleton group (the one case with a single id to check); -1 for a multi-location group
   *  or an out-of-range position, matching `findIndex`'s own "not found" convention. */
  function itemIndexAt(groupIndex: number): number {
    const g = groups[groupIndex];
    if (g === undefined || g.members.length !== 1) return -1;
    return (items ?? []).findIndex((r) => r.id === g.members[0]!.id);
  }

  /** Shift+J/Shift+K (#184): moves the cursor like j/k, and also checks every row the cursor
   *  crosses on the way, anchored at wherever the cursor started extending from (the same
   *  `lastToggledIndex` a shift-click range uses), so repeated presses keep growing one range
   *  instead of restarting it from the cursor's current row each time. `lastToggledIndex` and
   *  the range below both stay in `items`' own flat-index space (matching `toggleChecked`'s
   *  usage), never the grouped navigable-unit space `move`/`currentGroup` use. Moving onto a
   *  multi-location group (no single id of its own) still advances the cursor and still
   *  establishes the anchor if none exists yet, so a later press resumes the range from where
   *  extension actually started rather than losing it the moment it passes a group; the range
   *  this fills may include a group's members by flat index, same as a shift-click range can,
   *  and `setCheckedIds` (the model itself, #209) is what actually keeps them out. */
  function moveAndExtend(delta: 1 | -1): boolean {
    const root = container.current;
    if (root === null) return false;
    const nodes = Array.from(root.querySelectorAll<HTMLElement>('[data-result-id]'));
    if (nodes.length === 0) return false;
    const cursorIndex = nodes.findIndex((n) => n.dataset.resultId === selectedKey);
    const nextCursor = Math.min(Math.max(cursorIndex + delta, 0), nodes.length - 1);
    const node = nodes.at(nextCursor);
    if (node === undefined) return false;
    setSelectedKey(node.dataset.resultId ?? null);
    node.focus();
    const next = itemIndexAt(nextCursor);
    const start = itemIndexAt(cursorIndex);
    if (lastToggledIndex.current === null) {
      const candidate = start === -1 ? next : start;
      if (candidate !== -1) lastToggledIndex.current = candidate;
    }
    if (next === -1 || lastToggledIndex.current === null) return true;
    const anchor = lastToggledIndex.current;
    setCheckedIds((prev) => {
      const result = new Set(prev);
      const [lo, hi] = anchor < next ? [anchor, next] : [next, anchor];
      for (let i = lo; i <= hi; i++) {
        const row = items?.[i];
        if (row !== undefined) result.add(row.id);
      }
      return result;
    });
    return true;
  }

  // Keyboard triage, through the guards every screen's shortcuts share (lib/useHotkeys.ts):
  // never while typing, in a menu, or in a dialog. This is the reference implementation that
  // hook was extracted from (issue #155); ReviewQueue.test.tsx's existing behavior coverage is
  // what proves the migration changed nothing.
  useHotkeys({
    j: (e) => {
      if (move(1)) e.preventDefault();
    },
    k: (e) => {
      if (move(-1)) e.preventDefault();
    },
    J: (e) => {
      if (moveAndExtend(1)) e.preventDefault();
    },
    K: (e) => {
      if (moveAndExtend(-1)) e.preventDefault();
    },
    ' ': (e) => {
      const current = currentResult();
      if (current === undefined) return;
      // Only from the row itself, same restriction Enter already uses below: Space on a
      // nested button (Accept, Dismiss, the posting link) keeps its own native meaning.
      const target = e.target instanceof Element ? e.target : null;
      const onItem =
        target === null || target === document.body || target.hasAttribute('data-result-id');
      if (!onItem) return;
      e.preventDefault();
      toggleChecked(current.id, false);
    },
    Escape: (e) => {
      if (checkedIds.size === 0) return;
      e.preventDefault();
      clearChecked();
    },
    i: (e) => {
      const current = currentGroup();
      if (current === undefined) return;
      e.preventDefault();
      void acceptGroup(current);
    },
    x: (e) => {
      const current = currentGroup();
      if (current === undefined) return;
      e.preventDefault();
      setDismissing(current);
    },
    p: (e) => {
      const current = currentGroup();
      const primary = current?.members[0];
      if (primary === undefined) return;
      // No posting URL, no control on the row either (QueueRow/QueueGroupRow): the key is just
      // as inert. A group opens its primary (best-scoring) member's posting.
      const href = safeHttpUrl(primary.posting.postingUrl);
      if (href === null) return;
      e.preventDefault();
      window.open(href, '_blank', 'noopener,noreferrer');
    },
    Enter: (e) => {
      const current = currentGroup();
      const primary = current?.members[0];
      if (primary === undefined) return;
      // Only from the row itself: Enter on a link or button keeps its own meaning.
      const target = e.target instanceof Element ? e.target : null;
      const onItem =
        target === null || target === document.body || target.hasAttribute('data-result-id');
      if (!onItem) return;
      e.preventDefault();
      setDetail(primary);
    },
  });

  return (
    <section className="grid min-w-0 gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm text-muted-foreground">
          {data === undefined
            ? ''
            : data.total === 1
              ? '1 result to review.'
              : `${data.total} results to review.`}
        </p>
        <p className="ml-auto hidden text-xs text-muted-foreground lg:block">
          <kbd className="rounded border px-1">j</kbd>/<kbd className="rounded border px-1">k</kbd>{' '}
          select, <kbd className="rounded border px-1">i</kbd> accept,{' '}
          <kbd className="rounded border px-1">x</kbd> dismiss,{' '}
          <kbd className="rounded border px-1">p</kbd> posting,{' '}
          <kbd className="rounded border px-1">Enter</kbd> details,{' '}
          <kbd className="rounded border px-1">space</kbd> check
        </p>
        <Button
          type="button"
          size="sm"
          className="ml-auto lg:ml-0"
          onClick={() => setCapture({ lead: null })}
        >
          Capture posting
        </Button>
      </div>

      {error ? <FormError message={errorMessage(error)} /> : null}
      {isPending ? <p className="text-sm text-muted-foreground">Loading...</p> : null}
      {items !== undefined && items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nothing to review. New results appear here after your sources run.
        </p>
      ) : null}

      {items !== undefined && items.length > 0 ? (
        <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
          <button
            type="button"
            className="underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => setCheckedIds(new Set(items.map((r) => r.id)))}
          >
            {/* setCheckedIds (#209) strips out a location group's members, which have no
             *  checkbox of their own, so the label counts what will actually get checked. */}
            Select all {items.length - groupedMemberIds.size} loaded
          </button>
          {data !== undefined && data.total > items.length ? (
            <button
              type="button"
              disabled={selectingAllMatching}
              className="underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              onClick={() => void selectAllMatching()}
            >
              {selectingAllMatching ? 'Selecting…' : `Select all ${data.total} matching`}
            </button>
          ) : null}
        </div>
      ) : null}

      {checkedIds.size > 0 ? (
        <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded-lg border bg-card p-3 shadow-sm">
          <p className="text-sm font-medium">{checkedIds.size} selected</p>
          <Button type="button" size="sm" onClick={() => setBulkAccepting(true)}>
            Accept
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => setBulkDismissing(true)}>
            Dismiss
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={clearChecked}>
            Clear
          </Button>
        </div>
      ) : null}

      <ul ref={container} className="grid gap-3" aria-label="Results to review">
        {groups.map((g) =>
          g.members.length === 1 ? (
            <QueueRow
              key={rowKey(g)}
              result={g.members[0]!}
              selected={rowKey(g) === selectedKey}
              onSelect={() => setSelectedKey(rowKey(g))}
              onAccept={() => void acceptGroup(g)}
              onDismiss={() => setDismissing(g)}
              onOpen={() => {
                setSelectedKey(rowKey(g));
                setDetail(g.members[0]!);
              }}
              checked={checkedIds.has(g.members[0]!.id)}
              onToggleChecked={(shiftKey) => toggleChecked(g.members[0]!.id, shiftKey)}
            />
          ) : (
            // No checked/onToggleChecked: a location group is not selectable for bulk triage
            // (issue #209) -- bulk-accept over its members independently would create one
            // opportunity per location instead of one, which is worse than the redundancy of
            // its own Accept all/Dismiss all buttons below.
            <QueueGroupRow
              key={rowKey(g)}
              group={g}
              selected={rowKey(g) === selectedKey}
              onSelect={() => setSelectedKey(rowKey(g))}
              onAcceptAll={() => void acceptGroup(g)}
              onDismissAll={() => setDismissing(g)}
              onOpen={() => {
                setSelectedKey(rowKey(g));
                setDetail(g.members[0]!);
              }}
            />
          ),
        )}
      </ul>

      <ResultDetailDialog
        result={detail}
        onClose={() => setDetail(null)}
        onAccept={(r) => {
          setDetail(null);
          // Deliberately just this one result, not its whole group (see file header): the
          // person opened detail on one specific posting.
          void acceptGroup({ key: r.id, members: [r] });
        }}
        onDismiss={(r) => {
          setDetail(null);
          setDismissing({ key: r.id, members: [r] });
        }}
        onCapture={(r) => {
          setDetail(null);
          setCapture({ lead: r });
        }}
      />
      {capture !== null ? (
        <CaptureDialog
          lead={capture.lead}
          onClose={() => setCapture(null)}
          onManualEntry={() => {
            setCapture(null);
            setManualEntry(true);
          }}
        />
      ) : null}
      <NewOpportunityDialog open={manualEntry} onOpenChange={setManualEntry} />
      <DismissResultDialog
        result={dismissing === null ? null : (dismissing.members[0] ?? null)}
        otherLocations={dismissing === null ? undefined : dismissing.members.length - 1}
        onCancel={() => setDismissing(null)}
        onConfirm={(v) => {
          if (dismissing !== null) void dismissGroup(dismissing, v);
        }}
      />
      <DuplicateAcceptDialog
        state={duplicate}
        busy={acceptM.isPending}
        onCancel={() => {
          setDuplicate(null);
          setGroupContinuation(null);
        }}
        onAttach={(s) => void resolveDuplicate(s, { attachTo: s.existingId })}
        onForce={(s) => void resolveDuplicate(s, { force: true })}
      />
      <BulkAcceptConfirmDialog
        open={bulkAccepting}
        count={checkedIds.size}
        busy={bulkAcceptM.isPending}
        progress={bulkProgress}
        onCancel={() => setBulkAccepting(false)}
        onConfirm={() => void bulkAccept()}
      />
      <BulkDismissDialog
        open={bulkDismissing}
        count={checkedIds.size}
        busy={bulkDismissM.isPending}
        progress={bulkProgress}
        onCancel={() => setBulkDismissing(false)}
        onConfirm={(v) => void bulkDismiss(v)}
      />
    </section>
  );
}
