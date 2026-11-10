// Token and estimated cost usage (FR-A5), from the task_runs ledger: per product feature over the
// window, each expandable to its tasks and the models they ran on (#341), then per task per day.
// The server lists every feature and task with zeros where nothing ran, so a feature that has not
// been used shows as zero rather than going missing.
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Fragment, useState } from 'react';
import { Button } from '@/components/ui/button';
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
import {
  type FeatureUsage,
  type ModelUsage,
  providerLabel,
  type UsageMetrics,
  type UsageSums,
  useUsage,
} from './api';

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

const ZERO: UsageSums = {
  runs: 0,
  errors: 0,
  inputTokens: 0,
  outputTokens: 0,
  estCostUsd: 0,
  estimated: false,
};

function sumOf(rows: UsageSums[]): UsageSums {
  return rows.reduce(
    (acc, t) => ({
      runs: acc.runs + t.runs,
      errors: acc.errors + t.errors,
      inputTokens: acc.inputTokens + t.inputTokens,
      outputTokens: acc.outputTokens + t.outputTokens,
      estCostUsd: acc.estCostUsd + t.estCostUsd,
      estimated: acc.estimated || t.estimated,
    }),
    ZERO,
  );
}

/** Calls, input tokens, output tokens and estimated cost: the last four cells of a row. */
function MetricCells({ row }: { row: UsageSums }) {
  return (
    <>
      <TableCell className="text-right tabular-nums">
        {int.format(row.runs)}
        {row.errors > 0 ? (
          <span className="text-destructive"> ({int.format(row.errors)} failed)</span>
        ) : null}
      </TableCell>
      <TableCell className="text-right tabular-nums">{int.format(row.inputTokens)}</TableCell>
      <TableCell className="text-right tabular-nums">{int.format(row.outputTokens)}</TableCell>
      <TableCell className="text-right tabular-nums">
        {usd.format(row.estCostUsd)}
        {row.estimated ? <EstimatedMark /> : null}
      </TableCell>
    </>
  );
}

/**
 * A model and the provider it was called through (#350). One model id can be reached through two
 * providers (an OpenAI-compatible gateway in front of OpenAI's own model, say), and the server
 * keeps them as separate rows, so each row says which it is.
 */
function ModelName({ m }: { m: ModelUsage }) {
  return (
    <>
      {m.model}{' '}
      <span className="font-sans text-muted-foreground">({providerLabel(m.provider)})</span>
    </>
  );
}

function FeatureTable({ features }: { features: FeatureUsage[] }) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <Table aria-label="AI usage by feature">
      <TableHeader>
        <TableRow>
          <TableHead>Feature</TableHead>
          <TableHead>Model</TableHead>
          <TableHead className="text-right">Calls</TableHead>
          <TableHead className="text-right">Input tokens</TableHead>
          <TableHead className="text-right">Output tokens</TableHead>
          <TableHead className="text-right">Est. cost</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {features.map((f) => {
          const expanded = open.has(f.feature);
          return (
            <Fragment key={f.feature}>
              <TableRow>
                <TableCell>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-fit px-1 font-medium"
                    aria-expanded={expanded}
                    onClick={() => toggle(f.feature)}
                  >
                    {expanded ? (
                      <ChevronDown aria-hidden="true" />
                    ) : (
                      <ChevronRight aria-hidden="true" />
                    )}
                    {f.label}
                  </Button>
                </TableCell>
                <TableCell />
                <MetricCells row={f} />
              </TableRow>
              {expanded
                ? f.tasks.map((t) => (
                    <Fragment key={t.taskKey}>
                      <TableRow>
                        <TableCell className="pl-9 font-mono text-xs">{t.taskKey}</TableCell>
                        <TableCell className="font-mono text-xs">
                          {t.models.length === 1 ? (
                            <ModelName m={t.models[0]!} />
                          ) : t.models.length > 1 ? (
                            `${t.models.length} models`
                          ) : (
                            ''
                          )}
                        </TableCell>
                        <MetricCells row={t} />
                      </TableRow>
                      {t.models.length > 1
                        ? t.models.map((m) => (
                            <TableRow key={`${m.provider}/${m.model}`}>
                              <TableCell />
                              <TableCell className="pl-4 font-mono text-xs">
                                <ModelName m={m} />
                              </TableCell>
                              <MetricCells row={m} />
                            </TableRow>
                          ))
                        : null}
                    </Fragment>
                  ))
                : null}
            </Fragment>
          );
        })}
        <TableRow className="font-medium">
          <TableCell>Total</TableCell>
          <TableCell />
          <MetricCells row={sumOf(features)} />
        </TableRow>
      </TableBody>
    </Table>
  );
}

function DayTable({ items }: { items: (UsageMetrics & { day: string })[] }) {
  return (
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
        {items.map((row) => (
          <TableRow key={`${row.day}|${row.taskKey}`}>
            <TableCell className="tabular-nums">{row.day}</TableCell>
            <TableCell className="font-mono text-xs">{row.taskKey}</TableCell>
            <MetricCells row={row} />
          </TableRow>
        ))}
        <TableRow className="font-medium">
          <TableCell colSpan={2}>Total</TableCell>
          <MetricCells row={sumOf(items)} />
        </TableRow>
      </TableBody>
    </Table>
  );
}

export function UsageTable() {
  const [days, setDays] = useState<number>(30);
  const usage = useUsage(days);

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
      ) : (
        <>
          <FeatureTable features={usage.data.features} />
          {usage.data.items.length > 0 ? (
            <>
              <h3 className="text-sm font-medium">By day</h3>
              <DayTable items={usage.data.items} />
            </>
          ) : null}
        </>
      )}
      <p className="max-w-prose text-xs text-muted-foreground">
        Costs are estimates from list prices; your provider bill is authoritative. Each call keeps
        the price it was charged when it ran, so a price changed later does not change past costs.
        Costs marked estimated come from models with no list price, which are counted at the highest
        listed price so they still count toward the daily budget.
      </p>
    </div>
  );
}
