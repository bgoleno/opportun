// The Recommended companies list (https://github.com/bgoleno/opportun/issues/300, slice b of #222):
// one list on the Companies tab for the companies in the user's network and the companies the AI
// suggested, each once, with filters (source, industry, board), two sorts, and Follow and Deny on
// every row. It replaces "In your network" (#216) and "Suggested companies".
//
// It is built from what the page already read: the network list, the suggestions and the confirmed
// industry profile are three reads of the user's own rows. Filtering and sorting happen here, in
// the browser, so none of it can request anything: no board is checked, nothing goes to the AI
// provider, and the server is not asked again.
import { useEffect, useId, useMemo, useState } from 'react';
import { FormError } from '@/components/FormError';
import { MainWithRail } from '@/components/MainWithRail';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { useDiscoveryBudget } from '@/components/ai/api';
import { errorMessage } from '@/lib/api';
import { useHotkeys } from '@/lib/useHotkeys';
import {
  useAcceptCompany,
  useBulkCompanies,
  useCheckBoard,
  useCompanySuggestions,
  useDenyCompany,
  useDenyNetworkCompany,
  useFollowCompany,
  useIndustryProfile,
  useNetworkCompanies,
  useUndenyCompany,
} from './companiesApi';
import {
  applyRecommended,
  fitOf,
  industryOptions,
  mergeRecommended,
  NO_FILTERS,
  type BoardFilter,
  type IndustryOption,
  type Recommended,
  type RecommendedFilters,
  type RecommendedSort,
  type SourceFilter,
} from './recommended';
import { RecommendedRow } from './RecommendedRow';
import { useSources } from './api';
import { useCostFigures } from './costFigures';
import { dollars, estimateOf, estimateText, type Estimate } from './estimate';
import { FollowConfirmDialog } from './FollowConfirmDialog';
import { usePrefilterRecall } from './PrefilterRecall';
import {
  confirmReasons,
  selectionTotals,
  type BudgetToday,
  type ConfirmReason,
  type SelectionTotals,
} from './selection';

const SOURCE_OPTIONS: [SourceFilter, string][] = [
  ['all', 'All'],
  ['network', 'In your network'],
  ['suggested', 'AI suggested'],
];
const BOARD_OPTIONS: [BoardFilter, string][] = [
  ['any', 'Any'],
  ['found', 'Board found'],
  ['not_checked', 'Not checked yet'],
  ['not_found', 'No board found'],
];
const SORT_OPTIONS: [RecommendedSort, string][] = [
  ['people', 'Most people you know'],
  ['fit', 'Best fit'],
];

/** The options in order, the ones in a tier inside an optgroup named for it. */
function IndustryOptions({ options }: { options: IndustryOption[] }) {
  const blocks: { group: string | null; items: IndustryOption[] }[] = [];
  for (const o of options) {
    const last = blocks.at(-1);
    if (o.group !== null && last?.group === o.group) last.items.push(o);
    else blocks.push({ group: o.group, items: [o] });
  }
  return (
    <>
      {blocks.map((block) => {
        const items = block.items.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ));
        return block.group === null ? (
          items
        ) : (
          <optgroup key={block.group} label={block.group}>
            {items}
          </optgroup>
        );
      })}
    </>
  );
}

function countText(n: number): string {
  return n === 0
    ? 'No company matches these filters.'
    : `${n} ${n === 1 ? 'company' : 'companies'}`;
}

/** The running total of the rows checked, as the estimate line reads for one (#302). */
function SelectionBar(props: {
  totals: SelectionTotals;
  busy: boolean;
  budget: BudgetToday | null;
  onFollow: () => void;
  onDeny: () => void;
  onClear: () => void;
}) {
  const t = props.totals;
  const none = t.withoutEstimate.length;
  return (
    <section
      aria-label="Selection"
      className="sticky bottom-0 z-10 grid min-w-0 gap-2 rounded-xl border bg-card p-3 shadow-md"
    >
      <p role="status" className="text-sm font-medium">
        {`${t.rows} selected`}
      </p>
      {t.counted > 0 ? (
        <p className="text-sm [overflow-wrap:anywhere]">
          {estimateText({
            newPerDay: t.newPerDay,
            rankedPerDay: t.rankedPerDay,
            costPerDayUsd: t.costPerDayUsd,
            firstRun: { count: t.firstRunCalls, usd: t.firstRunUsd },
          })}
        </p>
      ) : null}
      {none > 0 ? (
        <details className="text-sm">
          <summary className="cursor-pointer">{`${none} without an estimate`}</summary>
          <ul className="mt-1 grid gap-0.5 pl-4" aria-label="Selected without an estimate">
            {t.withoutEstimate.map((c) => (
              <li key={c.id} className="[overflow-wrap:anywhere]">
                {c.name}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          disabled={props.busy}
          onClick={props.onFollow}
          aria-label={`Follow ${t.rows} selected`}
        >
          {`Follow ${t.rows}`}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={props.busy}
          onClick={props.onDeny}
          aria-label={`Deny ${t.rows} selected`}
        >
          {`Deny ${t.rows}`}
        </Button>
        <Button size="sm" variant="ghost" onClick={props.onClear}>
          Clear selection
        </Button>
      </div>
    </section>
  );
}

/** Today's discovery spend against the budget, and what the selection adds on its first day (#302). */
function BudgetRail(props: { budget: BudgetToday; totals: SelectionTotals }) {
  const { dailyUsd, spentTodayUsd } = props.budget;
  const first = props.totals.rows > 0 ? props.totals.firstRunUsd : null;
  const after = first === null ? null : spentTodayUsd + first;
  const share = (usd: number): number =>
    dailyUsd > 0 ? Math.min(100, Math.max(0, (usd / dailyUsd) * 100)) : 100;
  return (
    <aside
      aria-label="Today's discovery budget"
      className="grid min-w-0 content-start gap-2 rounded-xl border bg-card p-3 text-sm lg:sticky lg:top-4"
    >
      <p className="font-medium">{`Spent today: ${dollars(spentTodayUsd)} of ${dollars(dailyUsd)}`}</p>
      <div
        role="meter"
        aria-label="Discovery spend today"
        aria-valuemin={0}
        aria-valuemax={dailyUsd}
        aria-valuenow={spentTodayUsd}
        className="relative h-2 overflow-hidden rounded-full bg-muted"
      >
        <div
          className="absolute inset-y-0 left-0 bg-primary"
          style={{ width: `${share(spentTodayUsd)}%` }}
        />
        {after !== null ? (
          <div
            className="absolute inset-y-0 bg-primary/40"
            style={{
              left: `${share(spentTodayUsd)}%`,
              width: `${share(after) - share(spentTodayUsd)}%`,
            }}
          />
        ) : null}
      </div>
      {after !== null ? (
        <p className="[overflow-wrap:anywhere]">
          {`With the selection’s first run: ${dollars(after)} of ${dollars(dailyUsd)}`}
          {after > dailyUsd ? ' (over today’s budget)' : ''}
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">
        Ranking, industry tags and company suggestions share it, and what does not fit waits for the
        next day.
      </p>
    </aside>
  );
}

export function RecommendedCompanies() {
  // The whole network list once, denied ones included: the toggles below filter it here.
  const network = useNetworkCompanies(true);
  const suggestions = useCompanySuggestions();
  const profile = useIndustryProfile();
  const accept = useAcceptCompany();
  const deny = useDenyCompany();
  const follow = useFollowCompany();
  const denyNetwork = useDenyNetworkCompany();
  const undeny = useUndenyCompany();
  const check = useCheckBoard();
  // The estimate line's figures: the 30-day cost of a rank call, whether the pre-filter acts, and
  // each followed company's own source. All reads of the user's own records, no AI call.
  const figures = useCostFigures();
  const recall = usePrefilterRecall();
  const sources = useSources();
  const costPerCall = figures.data?.rank.find((r) => r.days === 30)?.avgCostUsd ?? null;
  const sourceOf = useMemo(
    () =>
      new Map(
        (sources.data?.items ?? []).flatMap((s) =>
          s.companyId === null ? [] : [[s.companyId, s] as const],
        ),
      ),
    [sources.data],
  );
  const volumeOf = useMemo(
    () => new Map((figures.data?.sources ?? []).map((v) => [v.sourceId, v])),
    [figures.data],
  );

  const [filters, setFilters] = useState<RecommendedFilters>(NO_FILTERS);
  const [sort, setSort] = useState<RecommendedSort>('people');
  const [showFollowed, setShowFollowed] = useState(false);
  const [showDenied, setShowDenied] = useState(false);
  const ids = useId();

  // Only the confirmed rows count, as everywhere else a profile is used.
  const confirmed = useMemo(
    () => (profile.data?.items ?? []).filter((r) => r.confirmed),
    [profile.data],
  );
  const merged = useMemo(
    () => mergeRecommended(network.data?.items ?? [], suggestions.data?.items ?? []),
    [network.data, suggestions.data],
  );
  const rows = useMemo(
    () => applyRecommended(merged, filters, sort, confirmed, { showFollowed, showDenied }),
    [merged, filters, sort, confirmed, showFollowed, showDenied],
  );
  const options = useMemo(() => industryOptions(confirmed), [confirmed]);

  // ---- selecting (#302): checkboxes, the keyboard cursor, the budget and the confirm ----------
  const bulkFollow = useBulkCompanies('follow');
  const bulkDeny = useBulkCompanies('deny');
  const budgetRead = useDiscoveryBudget();
  const budget: BudgetToday | null =
    budgetRead.data === undefined
      ? null
      : { dailyUsd: budgetRead.data.dailyUsd, spentTodayUsd: budgetRead.data.spentTodayUsd };
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [cursorId, setCursorId] = useState<string | null>(null);
  const [ask, setAsk] = useState<{
    items: Recommended[];
    totals: SelectionTotals;
    reasons: ConfirmReason[];
    /** One company, from its own button or the f key: the one-company routes and their toasts. */
    single: boolean;
  } | null>(null);

  // No estimate until the cost figure and the pre-filter's recall have been read (or failed): before
  // that the pre-filter would count as off and the cost as unknown, and the first line shown would
  // be the wrong one (tl on #325).
  const estimatesReady = !figures.isPending && !recall.isPending;
  const estimateFor = (item: Recommended): Estimate | null => {
    if (!estimatesReady) return null;
    const source = sourceOf.get(item.company.id);
    return estimateOf({
      company: item.company,
      source,
      volume: source === undefined ? undefined : volumeOf.get(source.id),
      costPerCall,
      recallOn: recall.data?.on === true,
    });
  };
  const canSelect = (item: Recommended): boolean =>
    item.company.status === 'none' || item.company.status === 'suggested';
  const selectedRows = rows.filter((r) => canSelect(r) && selected.has(r.company.id));
  const totals = selectionTotals(
    selectedRows.map((r) => ({ company: r.company, estimate: estimateFor(r) })),
  );

  // Only what is on screen stays selected, so the totals and Follow only ever apply to the rows
  // the user can see: a filter, a sort or a toggle that hides a row drops it from the selection.
  const shownKey = rows
    .filter(canSelect)
    .map((r) => r.company.id)
    .join('|');
  useEffect(() => {
    const shown = new Set(shownKey === '' ? [] : shownKey.split('|'));
    setSelected((prev) => {
      const kept = [...prev].filter((id) => shown.has(id));
      return kept.length === prev.size ? prev : new Set(kept);
    });
  }, [shownKey]);

  const cursorIndex = rows.findIndex((r) => r.company.id === cursorId);
  const cursorRow = rows.find((r) => r.company.id === cursorId);
  useEffect(() => {
    if (cursorId === null) return;
    document
      .querySelector(`[data-company-id="${CSS.escape(cursorId)}"]`)
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [cursorId]);

  function toggle(id: string, on: boolean): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  /** What a follow of one or more rows does: at once, or after the question when it is large. */
  function requestFollow(items: Recommended[], single: boolean): void {
    if (items.length === 0) return;
    const t = selectionTotals(items.map((r) => ({ company: r.company, estimate: estimateFor(r) })));
    const reasons = confirmReasons(t, budget);
    if (reasons.length > 0) {
      setAsk({ items, totals: t, reasons, single });
      return;
    }
    void runFollow(items, single);
  }

  async function runFollow(items: Recommended[], single: boolean): Promise<void> {
    const [only] = items;
    if (single && only !== undefined) {
      (only.company.status === 'suggested' ? accept : follow).mutate(only.company);
      return;
    }
    const outcome = await bulkFollow.mutateAsync(items.map((r) => r.company));
    // The ones that did not follow stay selected, to try again; the others are done.
    setSelected((prev) => {
      const done = new Set(outcome.done.map((c) => c.id));
      return new Set([...prev].filter((id) => !done.has(id)));
    });
  }

  function denyOne(item: Recommended): void {
    (item.company.status === 'suggested' ? deny : denyNetwork).mutate(item.company);
  }

  // The keyboard, as the Review queue has it: j and k move a cursor that is not the checkboxes,
  // Space checks the row it is on, f follows it (with the question when it applies), x denies it,
  // Escape clears the selection. useHotkeys leaves a field, a select and an open dialog alone.
  useHotkeys({
    j: () => {
      const next = rows[cursorIndex + 1];
      if (next !== undefined) setCursorId(next.company.id);
    },
    k: () => {
      const prev = cursorIndex > 0 ? rows[cursorIndex - 1] : undefined;
      if (prev !== undefined) setCursorId(prev.company.id);
    },
    ' ': (e) => {
      if (cursorRow === undefined || !canSelect(cursorRow)) return;
      e.preventDefault();
      toggle(cursorRow.company.id, !selected.has(cursorRow.company.id));
    },
    f: () => {
      if (cursorRow !== undefined && canSelect(cursorRow)) requestFollow([cursorRow], true);
    },
    x: () => {
      if (cursorRow !== undefined && canSelect(cursorRow)) denyOne(cursorRow);
    },
    Escape: () => {
      if (selected.size > 0) setSelected(new Set());
    },
  });
  const filtered =
    filters.source !== 'all' || filters.industry !== 'all' || filters.board !== 'any';
  const loaded = network.data !== undefined && suggestions.data !== undefined;

  return (
    <section className="grid min-w-0 gap-3" aria-labelledby="recommended-companies-heading">
      <h2 id="recommended-companies-heading" className="text-lg font-semibold">
        Recommended companies
      </h2>
      <p className="max-w-prose text-sm text-muted-foreground">
        Companies where someone in your contacts works now, and companies the AI suggests from your
        pipeline and the industries you confirmed. It is built from what Opportun already has: no
        job board is checked and nothing is sent to your AI provider to show or sort it.
      </p>
      <div
        role="group"
        aria-label="Filter and sort the companies"
        className="grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-4"
      >
        <div className="grid min-w-0 gap-1">
          <Label htmlFor={`${ids}-source`}>Source</Label>
          <Select
            id={`${ids}-source`}
            className="w-full min-w-0"
            value={filters.source}
            onChange={(e) =>
              setFilters({ ...filters, source: e.currentTarget.value as SourceFilter })
            }
          >
            {SOURCE_OPTIONS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        </div>
        <div className="grid min-w-0 gap-1">
          <Label htmlFor={`${ids}-industry`}>Industry</Label>
          <Select
            id={`${ids}-industry`}
            className="w-full min-w-0"
            value={filters.industry}
            onChange={(e) => setFilters({ ...filters, industry: e.currentTarget.value })}
          >
            <IndustryOptions options={options} />
          </Select>
        </div>
        <div className="grid min-w-0 gap-1">
          <Label htmlFor={`${ids}-board`}>Board</Label>
          <Select
            id={`${ids}-board`}
            className="w-full min-w-0"
            value={filters.board}
            onChange={(e) =>
              setFilters({ ...filters, board: e.currentTarget.value as BoardFilter })
            }
          >
            {BOARD_OPTIONS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        </div>
        <div className="grid min-w-0 gap-1">
          <Label htmlFor={`${ids}-sort`}>Sort by</Label>
          <Select
            id={`${ids}-sort`}
            className="w-full min-w-0"
            value={sort}
            onChange={(e) => setSort(e.currentTarget.value as RecommendedSort)}
          >
            {SORT_OPTIONS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 sm:col-span-2 lg:col-span-4">
          <div className="flex items-center gap-2">
            <Checkbox
              id={`${ids}-followed`}
              checked={showFollowed}
              onCheckedChange={(v) => setShowFollowed(v === true)}
            />
            <Label htmlFor={`${ids}-followed`} className="text-sm font-normal">
              Show followed
            </Label>
          </div>
          <div className="flex items-center gap-2">
            <Checkbox
              id={`${ids}-denied`}
              checked={showDenied}
              onCheckedChange={(v) => setShowDenied(v === true)}
            />
            <Label htmlFor={`${ids}-denied`} className="text-sm font-normal">
              Show denied
            </Label>
          </div>
          {filtered ? (
            <Button size="sm" variant="outline" onClick={() => setFilters(NO_FILTERS)}>
              Clear filters
            </Button>
          ) : null}
        </div>
      </div>
      {network.error ? <FormError message={errorMessage(network.error)} /> : null}
      {suggestions.error ? <FormError message={errorMessage(suggestions.error)} /> : null}
      {!loaded && !network.error && !suggestions.error ? (
        <p className="text-sm text-muted-foreground">Loading...</p>
      ) : null}
      {loaded && merged.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          None yet. Suggestions appear as your pipeline grows. Add your contacts' current companies
          under Network to see them here.
        </p>
      ) : null}
      {/* Said politely, so a screen reader hears what a filter or a toggle did to the list. */}
      {loaded && merged.length > 0 ? (
        <p
          role="status"
          aria-live="polite"
          aria-label="Companies shown"
          className="text-sm text-muted-foreground"
        >
          {countText(rows.length)}
        </p>
      ) : null}
      <MainWithRail>
        <div className="grid min-w-0 content-start gap-3">
          <ul className="grid gap-3" aria-label="Recommended companies">
            {rows.map((item) => {
              const c = item.company;
              const busy =
                (accept.isPending && accept.variables?.id === c.id) ||
                (deny.isPending && deny.variables?.id === c.id) ||
                (follow.isPending && follow.variables?.id === c.id) ||
                (denyNetwork.isPending && denyNetwork.variables?.id === c.id) ||
                (undeny.isPending && undeny.variables?.id === c.id) ||
                (check.isPending && check.variables?.id === c.id) ||
                bulkFollow.isPending ||
                bulkDeny.isPending;
              return (
                <RecommendedRow
                  key={c.id}
                  item={item}
                  fit={fitOf(c, confirmed)}
                  estimate={estimateFor(item)}
                  busy={busy}
                  selectable={canSelect(item)}
                  selected={selected.has(c.id)}
                  cursor={cursorId === c.id}
                  onSelect={(on) => toggle(c.id, on)}
                  onCheckBoard={() => check.mutate(c)}
                  onFollow={() => requestFollow([item], true)}
                  onDeny={() => denyOne(item)}
                  onUndeny={() => undeny.mutate(c)}
                />
              );
            })}
          </ul>
          {selectedRows.length > 0 ? (
            <SelectionBar
              totals={totals}
              busy={bulkFollow.isPending || bulkDeny.isPending}
              onFollow={() => requestFollow(selectedRows, false)}
              onDeny={() => {
                const picked = selectedRows;
                void bulkDeny.mutateAsync(picked.map((r) => r.company)).then((outcome) => {
                  const done = new Set(outcome.done.map((c) => c.id));
                  setSelected((prev) => new Set([...prev].filter((id) => !done.has(id))));
                });
              }}
              onClear={() => setSelected(new Set())}
              budget={budget}
            />
          ) : null}
        </div>
        {budget !== null ? <BudgetRail budget={budget} totals={totals} /> : null}
      </MainWithRail>
      {ask !== null ? (
        <FollowConfirmDialog
          open
          rows={ask.items.map((r) => ({ company: r.company, estimate: estimateFor(r) }))}
          totals={ask.totals}
          reasons={ask.reasons}
          budget={budget}
          onCancel={() => setAsk(null)}
          onConfirm={() => {
            const pending = ask;
            setAsk(null);
            void runFollow(pending.items, pending.single);
          }}
        />
      ) : null}
    </section>
  );
}
