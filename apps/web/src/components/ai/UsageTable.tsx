// Token and estimated cost usage per task per day (FR-A5), from the task_runs ledger.
import { useState } from 'react';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useUsage } from './api';

const WINDOWS = [7, 30, 90] as const;
const usd = new Intl.NumberFormat(undefined, {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});
const int = new Intl.NumberFormat();

function EstimatedMark() {
  return (
    <span
      className="ml-1 text-xs text-muted-foreground"
      title="This model has no list price, so the highest listed price was used"
    >
      (estimated)
    </span>
  );
}

export function UsageTable() {
  const [days, setDays] = useState<number>(30);
  const usage = useUsage(days);

  const totals = usage.data?.totals ?? [];
  const sum = totals.reduce(
    (acc, t) => ({
      runs: acc.runs + t.runs,
      inputTokens: acc.inputTokens + t.inputTokens,
      outputTokens: acc.outputTokens + t.outputTokens,
      estCostUsd: acc.estCostUsd + t.estCostUsd,
      estimated: acc.estimated || t.estimated,
    }),
    { runs: 0, inputTokens: 0, outputTokens: 0, estCostUsd: 0, estimated: false },
  );

  return (
    <div className="grid gap-3">
      <div className="flex items-center gap-2">
        <Label htmlFor="ai-usage-window">Window</Label>
        <div className="w-36">
          <Select
            id="ai-usage-window"
            value={String(days)}
            onChange={(e) => setDays(Number(e.target.value))}
          >
            {WINDOWS.map((d) => (
              <option key={d} value={d}>
                Last {d} days
              </option>
            ))}
          </Select>
        </div>
      </div>
      {usage.isPending ? (
        <p className="text-sm text-muted-foreground">Loading usage...</p>
      ) : usage.isError ? (
        <p role="alert" className="text-sm text-destructive">
          Could not load usage.
        </p>
      ) : usage.data.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">No AI calls in this window.</p>
      ) : (
        <Table aria-label="AI usage by day and task">
          <TableHeader>
            <TableRow>
              <TableHead>Day (UTC)</TableHead>
              <TableHead>Task</TableHead>
              <TableHead className="text-right">Calls</TableHead>
              <TableHead className="text-right">Input tokens</TableHead>
              <TableHead className="text-right">Output tokens</TableHead>
              <TableHead className="text-right">Est. cost</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {usage.data.items.map((row) => (
              <TableRow key={`${row.day}|${row.taskKey}`}>
                <TableCell className="tabular-nums">{row.day}</TableCell>
                <TableCell className="font-mono text-xs">{row.taskKey}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {int.format(row.runs)}
                  {row.errors > 0 ? (
                    <span className="text-destructive"> ({int.format(row.errors)} failed)</span>
                  ) : null}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {int.format(row.inputTokens)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {int.format(row.outputTokens)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {usd.format(row.estCostUsd)}
                  {row.estimated ? <EstimatedMark /> : null}
                </TableCell>
              </TableRow>
            ))}
            <TableRow className="font-medium">
              <TableCell colSpan={2}>Total</TableCell>
              <TableCell className="text-right tabular-nums">{int.format(sum.runs)}</TableCell>
              <TableCell className="text-right tabular-nums">
                {int.format(sum.inputTokens)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {int.format(sum.outputTokens)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {usd.format(sum.estCostUsd)}
                {sum.estimated ? <EstimatedMark /> : null}
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      )}
      <p className="text-xs text-muted-foreground">
        Costs are estimates from list prices; your provider bill is authoritative. Costs marked
        estimated come from models with no list price, which are counted at the highest listed price
        so they still count toward the daily budget.
      </p>
    </div>
  );
}
