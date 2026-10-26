// The user's discovery sources (FR-U6): status, last run and schedule, enable or disable, run
// now, run history, and create or edit per kind. Alert-email and manual-capture sources are made
// by the app; they are listed here but not edited.
import { History, Pencil, Play, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { FormError } from '@/components/FormError';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { IconButton } from '@/components/ui/icon-button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { toast } from '@/components/ui/toast';
import { ApiError, errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/opportunities';
import { useRoleTargets } from '@/routes/settings/-api';
import {
  isAtsKind,
  sourceKindLabel,
  useAlertSenders,
  useCreateSource,
  useDeleteSource,
  useRunSource,
  useSetAlertSenders,
  useSourceRuns,
  useSources,
  useUpdateSource,
  type DiscoverySource,
  type SourceInput,
} from './api';
import { AlertSendersList } from './AlertSenders';
import { editableConfig, SourceForm } from './SourceForm';

const isUserManaged = (s: DiscoverySource): boolean => isAtsKind(s.kind) || s.kind === 'mcp';
/**
 * Only adapter-backed kinds can be run on demand; alert-email and manual sources receive postings
 * as they arrive, and the server refuses to run them (422 source_not_runnable).
 */
const isRunnable = isUserManaged;

/** One line saying what the source reads, from its config (as text). */
export function sourceSummary(s: DiscoverySource): string {
  const c = editableConfig(s.config);
  if (s.kind === 'ats_workday') {
    const { host, tenant, site } = c;
    return typeof host === 'string' && typeof tenant === 'string' && typeof site === 'string'
      ? `${tenant}/${site} (${host})`
      : '(no site)';
  }
  if (isAtsKind(s.kind)) return typeof c.org === 'string' ? c.org : '(no slug)';
  if (s.kind === 'mcp') {
    const tool = typeof c.tool === 'string' ? c.tool : '?';
    const where =
      c.transport === 'http'
        ? typeof c.url === 'string'
          ? c.url
          : ''
        : typeof c.command === 'string'
          ? c.command
          : '';
    return `${tool} via ${where}`;
  }
  if (s.kind === 'alert_email') return 'Job alert digests from the configured sender list';
  if (s.kind === 'extension') return 'LinkedIn job pages you capture with the browser extension';
  return 'Postings you capture yourself';
}

function scheduleText(s: DiscoverySource): string {
  if (!s.enabled) return 'Paused';
  return s.scheduleCron === null ? 'Run now only' : `On schedule: ${s.scheduleCron}`;
}

type Editing = { mode: 'create' } | { mode: 'edit'; source: DiscoverySource } | null;

export function SourcesManager() {
  const list = useSources();
  const roleTargets = useRoleTargets();
  const create = useCreateSource();
  const update = useUpdateSource();
  const remove = useDeleteSource();
  const run = useRunSource();
  const [editing, setEditing] = useState<Editing>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [historyFor, setHistoryFor] = useState<DiscoverySource | null>(null);
  const [pendingDelete, setPendingDelete] = useState<DiscoverySource | null>(null);
  const [alertSendersOpen, setAlertSendersOpen] = useState(false);
  const targetName = new Map((roleTargets.data?.items ?? []).map((t) => [t.id, t.name]));

  function close() {
    setEditing(null);
    setFormError(null);
  }

  async function save(input: SourceInput) {
    setFormError(null);
    try {
      if (editing?.mode === 'edit') {
        await update.mutateAsync({ id: editing.source.id, patch: input });
        toast({ title: 'Source updated', variant: 'success' });
      } else {
        await create.mutateAsync(input);
        toast({ title: 'Source added', variant: 'success' });
      }
      close();
    } catch (err) {
      setFormError(errorMessage(err));
    }
  }

  function runNow(s: DiscoverySource) {
    run.mutate(s.id, {
      onSuccess: () =>
        toast({
          title: 'Run queued',
          description: 'New results appear in the review queue when it finishes.',
        }),
      onError: (err) =>
        toast({
          title: 'Run not started',
          description:
            err instanceof ApiError && err.code === 'source_not_runnable'
              ? 'This source cannot be run on demand: its postings arrive on their own.'
              : errorMessage(err),
          variant: 'destructive',
        }),
    });
  }

  const items = list.data?.items ?? [];

  return (
    <section className="grid min-w-0 gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          Where discovery looks for postings. Each run adds new results to the review queue.
        </p>
        <Button onClick={() => setEditing({ mode: 'create' })}>
          <Plus aria-hidden="true" />
          New source
        </Button>
      </div>
      {list.isError ? <FormError message={errorMessage(list.error)} /> : null}
      {list.isPending ? (
        <p className="text-sm text-muted-foreground">Loading sources...</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No sources yet. Add a company board (Greenhouse, Lever, Ashby) or an MCP source.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <Table aria-label="Discovery sources">
            <TableHeader>
              <TableRow>
                <TableHead>Source</TableHead>
                <TableHead>Role target</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Last run</TableHead>
                <TableHead>Next run</TableHead>
                <TableHead>Enabled</TableHead>
                <TableHead>
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((s) => {
                const name = `${sourceKindLabel(s.kind)} ${sourceSummary(s)}`;
                return (
                  <TableRow key={s.id}>
                    <TableCell>
                      <div className="grid gap-0.5">
                        <span className="font-medium">{sourceKindLabel(s.kind)}</span>
                        <span className="max-w-64 truncate text-xs text-muted-foreground">
                          {sourceSummary(s)}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {s.roleTargetId === null
                        ? 'All'
                        : (targetName.get(s.roleTargetId) ?? 'Unknown')}
                    </TableCell>
                    <TableCell>
                      {s.status === 'ok' ? (
                        <Badge variant="success">OK</Badge>
                      ) : (
                        <div className="grid gap-0.5">
                          <Badge variant="destructive">Error</Badge>
                          {s.statusDetail ? (
                            <span className="max-w-64 truncate text-xs text-destructive">
                              {s.statusDetail}
                            </span>
                          ) : null}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {s.lastRunAt === null ? 'Never' : formatDateTime(s.lastRunAt)}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{scheduleText(s)}</TableCell>
                    <TableCell>
                      <input
                        type="checkbox"
                        aria-label={`${name} enabled`}
                        checked={s.enabled}
                        onChange={(e) =>
                          update.mutate({ id: s.id, patch: { enabled: e.currentTarget.checked } })
                        }
                        className="size-4 accent-primary"
                      />
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        {isRunnable(s) ? (
                          <IconButton
                            variant="ghost"
                            label={`Run ${name} now`}
                            disabled={run.isPending}
                            onClick={() => runNow(s)}
                          >
                            <Play aria-hidden="true" />
                          </IconButton>
                        ) : null}
                        <IconButton
                          variant="ghost"
                          label={`Run history for ${name}`}
                          onClick={() => setHistoryFor(s)}
                        >
                          <History aria-hidden="true" />
                        </IconButton>
                        {s.kind === 'alert_email' ? (
                          <IconButton
                            variant="ghost"
                            label="Edit alert senders"
                            onClick={() => setAlertSendersOpen(true)}
                          >
                            <Pencil aria-hidden="true" />
                          </IconButton>
                        ) : null}
                        {isUserManaged(s) ? (
                          <>
                            <IconButton
                              variant="ghost"
                              label={`Edit ${name}`}
                              onClick={() => setEditing({ mode: 'edit', source: s })}
                            >
                              <Pencil aria-hidden="true" />
                            </IconButton>
                            <IconButton
                              variant="ghost"
                              label={`Delete ${name}`}
                              onClick={() => setPendingDelete(s)}
                            >
                              <Trash2 aria-hidden="true" />
                            </IconButton>
                          </>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog
        open={editing !== null}
        onOpenChange={(o) => {
          if (!o) close();
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editing?.mode === 'edit' ? 'Edit source' : 'New source'}</DialogTitle>
            <DialogDescription>
              Company boards are read through their public job APIs. An MCP source calls a tool you
              run yourself.
            </DialogDescription>
          </DialogHeader>
          {editing !== null ? (
            <SourceForm
              key={editing.mode === 'edit' ? editing.source.id : 'new'}
              {...(editing.mode === 'edit' ? { source: editing.source } : {})}
              busy={create.isPending || update.isPending}
              serverError={formError}
              onSubmit={(input) => void save(input)}
              onCancel={close}
            />
          ) : null}
        </DialogContent>
      </Dialog>

      <RunHistoryDrawer source={historyFor} onClose={() => setHistoryFor(null)} />

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(o) => {
          if (!o) setPendingDelete(null);
        }}
        title="Delete this source?"
        description="Its run history and any results still waiting for review are removed. Opportunities you already accepted are kept."
        confirmLabel="Delete"
        onConfirm={async () => {
          if (pendingDelete !== null) await remove.mutateAsync(pendingDelete.id);
        }}
      />

      <AlertSendersDialog open={alertSendersOpen} onClose={() => setAlertSendersOpen(false)} />
    </section>
  );
}

/** Issue #15: who a job alert digest can come from. */
function AlertSendersDialog(props: { open: boolean; onClose: () => void }) {
  const state = useAlertSenders();
  const set = useSetAlertSenders();

  return (
    <Dialog
      open={props.open}
      onOpenChange={(o) => {
        if (!o) props.onClose();
      }}
    >
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Alert senders</DialogTitle>
          <DialogDescription>Which addresses a job alert digest can come from.</DialogDescription>
        </DialogHeader>
        {state.isPending ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : state.isError ? (
          <FormError message={errorMessage(state.error)} />
        ) : (
          <AlertSendersList
            senders={state.data.senders}
            usingDefaults={state.data.usingDefaults}
            defaults={state.data.defaults}
            saving={set.isPending}
            onAdd={(address) => set.mutate([...state.data.senders, address])}
            onRemove={(address) => set.mutate(state.data.senders.filter((s) => s !== address))}
            onResetToDefaults={() => set.mutate(null)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function statsText(stats: Record<string, unknown> | null): string {
  if (stats === null) return '';
  return Object.entries(stats)
    .filter(([, v]) => typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean')
    .map(([k, v]) => `${k}: ${String(v)}`)
    .join(', ');
}

/** Recent runs of one source, newest first, in a side sheet. */
export function RunHistoryDrawer(props: { source: DiscoverySource | null; onClose: () => void }) {
  const s = props.source;
  const runs = useSourceRuns(s?.id ?? null);
  return (
    <Dialog
      open={s !== null}
      onOpenChange={(o) => {
        if (!o) props.onClose();
      }}
    >
      <DialogContent className="my-0 mr-0 h-dvh max-h-dvh w-full max-w-md rounded-none rounded-l-xl">
        <DialogHeader>
          <DialogTitle>Run history</DialogTitle>
          <DialogDescription>
            {s === null ? '' : `${sourceKindLabel(s.kind)}: ${sourceSummary(s)}`}
          </DialogDescription>
        </DialogHeader>
        {runs.isPending ? (
          <p className="text-sm text-muted-foreground">Loading runs...</p>
        ) : runs.isError ? (
          <FormError message={errorMessage(runs.error)} />
        ) : runs.data.items.length === 0 ? (
          <p className="text-sm text-muted-foreground">No runs yet.</p>
        ) : (
          <ol className="grid gap-2" aria-label="Runs">
            {runs.data.items.map((r) => (
              <li key={r.id} className="grid gap-1 rounded-md border p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{formatDateTime(r.startedAt)}</span>
                  {r.error !== null ? (
                    <Badge variant="destructive">Failed</Badge>
                  ) : r.finishedAt === null ? (
                    <Badge variant="secondary">Running</Badge>
                  ) : (
                    <Badge variant="success">Done</Badge>
                  )}
                </div>
                {statsText(r.stats) ? (
                  <p className="text-muted-foreground">{statsText(r.stats)}</p>
                ) : null}
                {r.error !== null ? (
                  <p className="break-words text-destructive">{r.error}</p>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </DialogContent>
    </Dialog>
  );
}
