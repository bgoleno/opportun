// Settings > AI usage: what discovery's ranking costs, over the last 7 and 30 days (#209, #190
// slice 1). Figures from the app's own task_runs; nothing here calls a model.
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  useCostFigures,
  usd,
  whole,
  type RankWindow,
  type TokenSpread,
} from '@/components/discovery/costFigures';

const spread = (s: TokenSpread | null): string =>
  s === null ? 'none' : `${whole.format(s.median)} / ${whole.format(s.p90)}`;

function calls(w: RankWindow): string {
  if (w.errors === 0) return whole.format(w.calls);
  return `${whole.format(w.calls)} (${whole.format(w.errors)} ${w.errors === 1 ? 'error' : 'errors'})`;
}

export function RankCostCard() {
  const figures = useCostFigures();
  return (
    // min-w-0: a grid item is as wide as its content by default, so the six-column table would
    // widen the whole settings column on a phone; this lets the table scroll inside its own
    // container instead (e2e/mobile.spec.ts, every view fits the screen).
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle>Discovery ranking cost</CardTitle>
        <CardDescription>
          The calls that score discovered postings. Tokens are per call, as median / 90th
          percentile, over the calls that ranked; the total includes calls that failed.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {figures.isPending ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : figures.isError ? (
          <p className="text-sm text-destructive">Could not load the ranking figures.</p>
        ) : (
          <Table aria-label="Discovery ranking cost">
            <TableHeader>
              <TableRow>
                <TableHead>Window</TableHead>
                <TableHead>Calls</TableHead>
                <TableHead>Input tokens</TableHead>
                <TableHead>Output tokens</TableHead>
                <TableHead>Cost per call</TableHead>
                <TableHead>Total cost</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {figures.data.rank.map((w) => (
                <TableRow key={w.days}>
                  <TableCell className="font-medium">Last {w.days} days</TableCell>
                  <TableCell>{calls(w)}</TableCell>
                  <TableCell>{spread(w.inputTokens)}</TableCell>
                  <TableCell>{spread(w.outputTokens)}</TableCell>
                  <TableCell>{w.avgCostUsd === null ? 'none' : usd.format(w.avgCostUsd)}</TableCell>
                  <TableCell>{usd.format(w.totalCostUsd)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
