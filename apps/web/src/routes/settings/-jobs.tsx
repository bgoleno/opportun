// Settings > Jobs (admins only, issue #140, NFR-OPS5): the one queue every background job
// shares (Gmail sync, classification, backups, the attachment sweep, discovery runs, and
// more) had no page, so "is something stuck" meant reading server logs. Read-only by design:
// a retry/cancel/purge control is a different review, about what either does to a job that
// already half-ran, not this one.
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { FormError } from '@/components/FormError';
import { Badge, type badgeVariants } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/opportunities';
import { cn } from '@/lib/utils';
import type { VariantProps } from 'class-variance-authority';

export interface JobView {
  id: string;
  kind: string;
  status: 'pending' | 'running' | 'done' | 'dead';
  attempts: number;
  maxAttempts: number;
  runAt: number;
  lastError: string | null;
  userId: string | null;
  createdAt: number;
  updatedAt: number;
}

/** Live enough for an operator actively diagnosing a stuck instance, not so tight it hammers
 * a server that may already be struggling. */
const POLL_MS = 5000;

const jobsQuery = {
  queryKey: ['admin', 'jobs'] as const,
  queryFn: () => api<{ items: JobView[] }>('/jobs?limit=200'),
};

export function useJobs() {
  return useQuery({ ...jobsQuery, refetchInterval: POLL_MS });
}

/**
 * `pending` alone does not say whether a job is fresh or has already failed once and is
 * waiting out a backoff: `attempts > 0` with a `pending` status is that case, and the
 * distinction is exactly what "did something fail" needs (#140). `running`, `done` and `dead`
 * need no translation.
 */
export type DisplayStatus = 'queued' | 'retrying' | 'running' | 'done' | 'dead';

export function displayStatus(j: Pick<JobView, 'status' | 'attempts'>): DisplayStatus {
  if (j.status !== 'pending') return j.status;
  return j.attempts > 0 ? 'retrying' : 'queued';
}

const STATUS_ORDER: readonly DisplayStatus[] = ['queued', 'running', 'retrying', 'dead', 'done'];

const STATUS_LABEL: Readonly<Record<DisplayStatus, string>> = {
  queued: 'Queued',
  running: 'Running',
  retrying: 'Retrying',
  dead: 'Dead',
  done: 'Done',
};

const STATUS_VARIANT: Readonly<
  Record<DisplayStatus, VariantProps<typeof badgeVariants>['variant']>
> = {
  queued: 'outline',
  running: 'default',
  retrying: 'warning',
  dead: 'destructive',
  done: 'success',
};

export function JobsCard() {
  const jobs = useJobs();
  const [filter, setFilter] = useState<DisplayStatus | null>(null);
  const now = Date.now();

  if (jobs.isError) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Jobs</CardTitle>
        </CardHeader>
        <CardContent>
          <FormError message={errorMessage(jobs.error)} />
        </CardContent>
      </Card>
    );
  }

  const items = jobs.data?.items ?? [];
  const counts = new Map<DisplayStatus, number>();
  for (const j of items) counts.set(displayStatus(j), (counts.get(displayStatus(j)) ?? 0) + 1);
  const shown = filter === null ? items : items.filter((j) => displayStatus(j) === filter);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Jobs</CardTitle>
        <CardDescription>
          Every background job (Gmail sync, classification, backups, the attachment sweep, discovery
          runs, and the rest) shares this one queue. The most recently changed 200 are shown, newest
          first, and the list refreshes itself every few seconds.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {jobs.isPending ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : (
          <>
            <ul aria-label="Jobs by status" className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              {STATUS_ORDER.map((s) => {
                const n = counts.get(s) ?? 0;
                const active = filter === s;
                return (
                  <li key={s}>
                    <button
                      type="button"
                      aria-pressed={active}
                      onClick={() => setFilter(active ? null : s)}
                      className={cn(
                        'flex h-full w-full flex-col gap-1 rounded-xl border p-4 text-left transition-colors outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring',
                        active ? 'border-primary bg-accent' : 'bg-card',
                      )}
                    >
                      <span className="text-xs font-medium text-muted-foreground">
                        {STATUS_LABEL[s]}
                      </span>
                      <span className="text-2xl font-semibold tabular-nums">{n}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
            {items.length === 0 ? (
              <p className="text-sm text-muted-foreground">No jobs yet.</p>
            ) : shown.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No {STATUS_LABEL[filter as DisplayStatus].toLowerCase()} jobs.
              </p>
            ) : (
              <div className="overflow-x-auto rounded-md border">
                <Table aria-label="Jobs">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Kind</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Attempts</TableHead>
                      <TableHead>Due</TableHead>
                      <TableHead>Updated</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {shown.map((j) => {
                      const status = displayStatus(j);
                      // A pending job already due is one a worker should have claimed by now:
                      // the signal that something is actually stuck, not just waiting its turn.
                      const overdue = j.status === 'pending' && j.runAt <= now;
                      return (
                        <TableRow key={j.id}>
                          <TableCell>
                            <div className="grid gap-0.5">
                              <span className="font-mono text-xs">{j.kind}</span>
                              {j.userId === null ? null : (
                                <span className="text-xs text-muted-foreground">
                                  user {j.userId}
                                </span>
                              )}
                            </div>
                          </TableCell>
                          <TableCell>
                            <div className="grid gap-0.5">
                              <Badge variant={STATUS_VARIANT[status]}>{STATUS_LABEL[status]}</Badge>
                              {j.lastError === null ? null : (
                                <span className="max-w-64 truncate text-xs text-destructive">
                                  {j.lastError}
                                </span>
                              )}
                            </div>
                          </TableCell>
                          <TableCell className="text-muted-foreground tabular-nums">
                            {j.attempts} / {j.maxAttempts}
                          </TableCell>
                          <TableCell
                            className={cn(
                              'whitespace-nowrap',
                              overdue ? 'font-medium text-destructive' : 'text-muted-foreground',
                            )}
                          >
                            {formatDateTime(j.runAt)}
                            {overdue ? ' (overdue)' : ''}
                          </TableCell>
                          <TableCell className="whitespace-nowrap text-muted-foreground">
                            {formatDateTime(j.updatedAt)}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
