// Discovery > Sources: each board's posting volume, and the ranking it implies (#209, #190
// slice 1). Figures from the app's own runs; nothing here fetches a board or calls a model.
import { useId } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { sourceKindLabel, useSources, type DiscoverySource } from './api';
import { perDay, usd, useCostFigures, whole, type SourceVolumeFigures } from './costFigures';
import { sourceSummary } from './SourcesManager';

const NO_DATA = 'no data yet';

/** A rate a day, with the days it covers while they are fewer than 14. */
const rate = (value: number | null, days: number): string =>
  value === null ? NO_DATA : `${perDay.format(value)}${days < 14 ? ` (${days} days)` : ''}`;

function cost(v: SourceVolumeFigures): string {
  if (v.newPerDay === null) return NO_DATA;
  // A rate with no ranking calls in the last 30 days to price it by.
  if (v.costPerDayUsd === null) return 'no cost data yet';
  return usd.format(v.costPerDayUsd);
}

function Row({ v, name }: { v: SourceVolumeFigures; name: string }) {
  const id = useId();
  return (
    <li aria-labelledby={id} className="grid gap-1 rounded-md border p-3">
      <span id={id} className="font-medium [overflow-wrap:anywhere]">
        {name}
      </span>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-sm">
        <dt className="text-muted-foreground">Open jobs at the last run</dt>
        <dd>{v.openJobs === null ? NO_DATA : whole.format(v.openJobs)}</dd>
        <dt className="text-muted-foreground">New postings a day</dt>
        <dd>{rate(v.newPerDay, v.days)}</dd>
        <dt className="text-muted-foreground">Ranking calls a day</dt>
        <dd>{rate(v.rankCallsPerDay, v.days)}</dd>
        <dt className="text-muted-foreground">Estimated cost a day</dt>
        <dd>{cost(v)}</dd>
      </dl>
    </li>
  );
}

export function SourceVolume() {
  const figures = useCostFigures();
  const sources = useSources();
  const byId = new Map((sources.data?.items ?? []).map((s) => [s.id, s]));
  return (
    <Card>
      <CardHeader>
        <CardTitle>Posting volume and ranking cost</CardTitle>
        <CardDescription>
          For each company board: new postings a day over the last 14 days (a board&apos;s first
          run, which brings in the whole board, is left out), the ranking calls that means, and
          their cost at the last 30 days&apos; average cost per call.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {figures.isPending ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : figures.isError ? (
          <p className="text-sm text-destructive">Could not load the posting figures.</p>
        ) : figures.data.sources.length === 0 ? (
          <p className="text-sm text-muted-foreground">No board sources yet.</p>
        ) : (
          <ul className="grid gap-2">
            {figures.data.sources.map((v) => {
              const s = byId.get(v.sourceId);
              const name =
                s === undefined
                  ? sourceKindLabel(v.kind as DiscoverySource['kind'])
                  : `${sourceKindLabel(s.kind)} ${sourceSummary(s)}`;
              return <Row key={v.sourceId} v={v} name={name} />;
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
