import { seniorityLabel, type RoleTarget } from '@opportun/core';
import { createFileRoute, Link } from '@tanstack/react-router';
import { Pencil, Plus, Sparkles, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { toast } from '@/components/ui/toast';
import {
  isTemp,
  useCreateRoleTarget,
  useDeleteRoleTarget,
  useRoleTargets,
  useUpdateRoleTarget,
} from './-api';
import { remoteLabel, RoleTargetForm, type RoleTargetPayload } from './-roleTargetForm';

export const Route = createFileRoute('/settings/role-targets')({
  component: RoleTargetsSettings,
});

function seniority(t: RoleTarget): string {
  const { seniorityMin: lo, seniorityMax: hi } = t;
  if (lo == null && hi == null) return 'Any';
  const a = seniorityLabel(lo);
  const b = seniorityLabel(hi);
  if (a !== null && b !== null) return lo === hi ? a : `${a} to ${b}`;
  return a !== null ? `${a} and up` : `Up to ${b}`;
}

function toPayload(t: RoleTarget): RoleTargetPayload {
  return {
    name: t.name,
    titleFamily: t.titleFamily,
    seniorityMin: t.seniorityMin ?? null,
    seniorityMax: t.seniorityMax ?? null,
    industries: t.industries,
    keywords: t.keywords,
    locations: t.locations,
    remotePref: t.remotePref,
    compMin: t.compMin ?? null,
    compMax: t.compMax ?? null,
    currency: t.currency ?? null,
    active: t.active,
  };
}

type Editing = { mode: 'create' } | { mode: 'edit'; target: RoleTarget } | null;

export function RoleTargetsSettings() {
  const list = useRoleTargets();
  const create = useCreateRoleTarget();
  const update = useUpdateRoleTarget();
  const remove = useDeleteRoleTarget();
  const [editing, setEditing] = useState<Editing>(null);
  const [pendingDelete, setPendingDelete] = useState<RoleTarget | null>(null);

  async function save(payload: RoleTargetPayload) {
    if (editing?.mode === 'edit') {
      await update.mutateAsync({ id: editing.target.id, patch: payload });
      toast({ title: 'Role target updated', variant: 'success' });
    } else {
      await create.mutateAsync(payload);
      toast({ title: 'Role target added', variant: 'success' });
    }
    setEditing(null);
  }

  const items = list.data?.items ?? [];

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-start justify-between gap-4">
        <div className="grid gap-1.5">
          <CardTitle>Role targets</CardTitle>
          <CardDescription>
            The kinds of roles you want. Discovery and scoring use the active ones.
          </CardDescription>
        </div>
        <Button onClick={() => setEditing({ mode: 'create' })}>
          <Plus aria-hidden="true" />
          New role target
        </Button>
      </CardHeader>
      <CardContent>
        {list.isPending ? (
          <p className="text-sm text-muted-foreground">Loading role targets...</p>
        ) : list.isError ? (
          <p role="alert" className="text-sm text-destructive">
            Could not load role targets.
          </p>
        ) : items.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No role targets yet. Add one to describe what you are looking for.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Title family</TableHead>
                <TableHead>Seniority</TableHead>
                <TableHead>Arrangement</TableHead>
                <TableHead>Active</TableHead>
                <TableHead className="w-32">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((t) => {
                const pending = isTemp(t.id);
                return (
                  <TableRow
                    key={t.id}
                    aria-busy={pending || undefined}
                    className={pending ? 'opacity-60' : undefined}
                  >
                    <TableCell className="font-medium">{t.name}</TableCell>
                    <TableCell>{t.titleFamily}</TableCell>
                    <TableCell>{seniority(t)}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{remoteLabel(t.remotePref)}</Badge>
                    </TableCell>
                    <TableCell>
                      <input
                        type="checkbox"
                        aria-label={`${t.name} active`}
                        checked={t.active}
                        disabled={pending}
                        onChange={(e) =>
                          update.mutate({ id: t.id, patch: { active: e.target.checked } })
                        }
                        className="size-4 accent-primary"
                      />
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        <IconButton
                          asChild
                          variant="ghost"
                          label={`Edit discovery prompt for ${t.name}`}
                        >
                          <Link
                            to="/discovery/prompts"
                            search={{ roleTargetId: t.id }}
                            disabled={pending}
                          >
                            <Sparkles aria-hidden="true" />
                          </Link>
                        </IconButton>
                        <IconButton
                          variant="ghost"
                          label={`Edit ${t.name}`}
                          disabled={pending}
                          onClick={() => setEditing({ mode: 'edit', target: t })}
                        >
                          <Pencil aria-hidden="true" />
                        </IconButton>
                        <IconButton
                          variant="ghost"
                          label={`Delete ${t.name}`}
                          disabled={pending}
                          onClick={() => setPendingDelete(t)}
                        >
                          <Trash2 aria-hidden="true" />
                        </IconButton>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>

      <Dialog
        open={editing !== null}
        onOpenChange={(o) => {
          if (!o) setEditing(null);
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {editing?.mode === 'edit' ? 'Edit role target' : 'New role target'}
            </DialogTitle>
            <DialogDescription>Leave either end on Any for an open range.</DialogDescription>
          </DialogHeader>
          {editing !== null ? (
            <RoleTargetForm
              key={editing.mode === 'edit' ? editing.target.id : 'new'}
              {...(editing.mode === 'edit' ? { initial: toPayload(editing.target) } : {})}
              submitLabel={editing.mode === 'edit' ? 'Save changes' : 'Add role target'}
              onSubmit={save}
              onCancel={() => setEditing(null)}
            />
          ) : null}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(o) => {
          if (!o) setPendingDelete(null);
        }}
        title="Delete this role target?"
        description={`"${pendingDelete?.name ?? ''}" will be removed. Opportunities already found are kept.`}
        confirmLabel="Delete"
        onConfirm={async () => {
          if (pendingDelete !== null) await remove.mutateAsync(pendingDelete.id);
        }}
      />
    </Card>
  );
}
