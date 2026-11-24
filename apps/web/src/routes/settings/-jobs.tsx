// Settings > Jobs (admins only, issue #140, NFR-OPS5): the one queue every background job
// shares (Gmail sync, classification, backups, the attachment sweep, discovery runs, and
// more) had no page, so "is something stuck" meant reading server logs. Read-only by design:
// a retry/cancel/purge control is a different review, about what either does to a job that
// already half-ran, not this one.
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { FormError } from '@/components/FormError';
import { Badge, type badgeVariants } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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

/** The most jobs listed at once (the server's own limit); the counts are of all of them (#982). */
const LISTED = 200;

export interface JobsAnswer {
  items: JobView[];
  counts: Record<DisplayStatus, number>;
}

/** The jobs of one status, or of every one, and how many there are of each. */
function useJobs(filter: DisplayStatus | null) {
  return useQuery({
    queryKey: ['admin', 'jobs', filter] as const,
    queryFn: () =>
      api<JobsAnswer>(`/jobs?limit=${LISTED}${filter === null ? '' : `&status=${filter}`}`),
    refetchInterval: POLL_MS,
    // The counts stay while another status is asked for.
    placeholderData: keepPreviousData,
    // A status left is forgotten: asked for again, it is read again, not shown as it was then.
    gcTime: 0,
  });
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

// eslint-disable-next-line security/detect-object-injection -- a typed display status
const labelOf = (s: DisplayStatus) => STATUS_LABEL[s];

const STATUS_VARIANT: Readonly<
  Record<DisplayStatus, VariantProps<typeof badgeVariants>['variant']>
> = {
  queued: 'outline',
  running: 'default',
  retrying: 'warning',
  dead: 'destructive',
  done: 'success',
};

/** Which of the jobs are listed, and how many there are beyond them. */
function shownText(shown: number, counted: number, filter: DisplayStatus | null): string {
  const kind = filter === null ? '' : `${labelOf(filter).toLowerCase()} `;
  // The server reads the list and the counts one after the other: a job added between them is in
  // one only, so the list can be the longer.
  const beyond = counted - shown;
  if (beyond > 0) {
    const more = `${beyond.toLocaleString()} more ${beyond === 1 ? 'is' : 'are'} not.`;
    return `The ${shown} most recently changed ${kind}jobs are shown, newest first. ${more}`;
  }
  return shown === 1
    ? `The one ${kind}job is shown.`
    : `All ${shown} ${kind}jobs are shown, most recently changed first.`;
}

export function JobsCard() {
  const [filter, setFilter] = useState<DisplayStatus | null>(null);
  const jobs = useJobs(filter);
  const now = Date.now();

  if (jobs.isError) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Jobs</CardTitle>
        </CardHeader>
        <CardContent className="grid justify-items-start gap-4">
          <FormError message={errorMessage(jobs.error)} />
          {/* The tiles, which would clear it, are not here. */}
          {filter === null ? null : (
            <Button variant="outline" size="sm" onClick={() => setFilter(null)}>
              Show all jobs
            </Button>
          )}
        </CardContent>
      </Card>
    );
  }

  const { items, counts } = jobs.data ?? { items: [], counts: null };
  // eslint-disable-next-line security/detect-object-injection -- a typed display status
  const countOf = (s: DisplayStatus) => counts?.[s] ?? 0;
  const counted =
    filter === null ? STATUS_ORDER.reduce((sum, s) => sum + countOf(s), 0) : countOf(filter);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Jobs</CardTitle>
        <CardDescription>
          Every background job (Gmail sync, classification, backups, the attachment sweep, discovery
          runs, and the rest) shares this one queue. The counts are of all of them, and the page
          refreshes itself every few seconds.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {jobs.isPending ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : (
          <>
            <ul aria-label="Jobs by status" className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              {STATUS_ORDER.map((s) => {
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
                        {labelOf(s)}
                      </span>
                      <span className="text-2xl font-semibold tabular-nums">
                        {countOf(s).toLocaleString()}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
            {jobs.isPlaceholderData ? (
              // The list is still the last status's.
              <p className="text-sm text-muted-foreground">Loading...</p>
            ) : items.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {filter === null ? 'No jobs yet.' : `No ${labelOf(filter).toLowerCase()} jobs.`}
              </p>
            ) : (
              <>
                <p className="text-sm text-muted-foreground">
                  {shownText(items.length, counted, filter)}
                </p>
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
                      {items.map((j) => {
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
                                {/* eslint-disable-next-line security/detect-object-injection -- a typed display status */}
                                <Badge variant={STATUS_VARIANT[status]}>{labelOf(status)}</Badge>
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
              </>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
