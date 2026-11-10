// The Recommended companies list (https://github.com/bgoleno/opportun/issues/300, slice b of #222):
// one list on the Companies tab for the companies in the user's network and the companies the AI
// suggested, each once, with filters (source, industry, board), two sorts, and Follow and Deny on
// every row. It replaces "In your network" (#216) and "Suggested companies".
//
// It is built from what the page already read: the network list, the suggestions and the confirmed
// industry profile are three reads of the user's own rows. Filtering and sorting happen here, in
// the browser, so none of it can request anything: no board is checked, nothing goes to the AI
// provider, and the server is not asked again.
import { useId, useMemo, useState } from 'react';
import { FormError } from '@/components/FormError';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { errorMessage } from '@/lib/api';
import {
  useAcceptCompany,
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
  type RecommendedFilters,
  type RecommendedSort,
  type SourceFilter,
} from './recommended';
import { RecommendedRow } from './RecommendedRow';

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
      <ul className="grid gap-3" aria-label="Recommended companies">
        {rows.map((item) => {
          const c = item.company;
          const busy =
            (accept.isPending && accept.variables?.id === c.id) ||
            (deny.isPending && deny.variables?.id === c.id) ||
            (follow.isPending && follow.variables?.id === c.id) ||
            (denyNetwork.isPending && denyNetwork.variables?.id === c.id) ||
            (undeny.isPending && undeny.variables?.id === c.id);
          // A suggestion is accepted or denied as a suggestion, even when someone in the network
          // works there too: the server refuses the other route with not_suggested.
          const isSuggestion = c.status === 'suggested';
          return (
            <RecommendedRow
              key={c.id}
              item={item}
              fit={fitOf(c, confirmed)}
              busy={busy}
              onFollow={() => (isSuggestion ? accept.mutate(c) : follow.mutate(c))}
              onDeny={() => (isSuggestion ? deny.mutate(c) : denyNetwork.mutate(c))}
              onUndeny={() => undeny.mutate(c)}
            />
          );
        })}
      </ul>
    </section>
  );
}
