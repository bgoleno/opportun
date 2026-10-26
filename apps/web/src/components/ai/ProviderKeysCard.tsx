// Provider keys: add (validated on add), list with status, expiry and per-model results,
// revalidate, edit name and expiry, remove. Provider-derived error strings are rendered as
// text nodes only.
import { zodResolver } from '@hookform/resolvers/zod';
import { KeyRound, Pencil, RefreshCw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { FormError } from '@/components/FormError';
import { FormField } from '@/components/FormField';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { IconButton } from '@/components/ui/icon-button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { toast } from '@/components/ui/toast';
import { applyServerError } from '@/lib/forms';
import { cn } from '@/lib/utils';
import {
  isProvider,
  providerLabel,
  PROVIDERS,
  useAiKeys,
  useCreateAiKey,
  useDeleteAiKey,
  useUpdateKeyMeta,
  useValidateKey,
  type AiKey,
  type KeyValidation,
} from './api';
import {
  dateInputToEpoch,
  degradedLabel,
  epochToDateInput,
  expiryText,
  keyChip,
} from './keyStatus';

const DateInput = z
  .string()
  .trim()
  .refine((v) => v === '' || dateInputToEpoch(v) !== null, 'Enter a valid date');

const KeySchema = z.object({
  provider: z.enum(PROVIDERS),
  value: z.string().trim().min(1, 'Paste the key').max(16_384),
  displayName: z.string().trim().max(100, 'At most 100 characters'),
  expires: DateInput,
});
type KeyInput = z.infer<typeof KeySchema>;

const addedFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

/** One-line summary of a validation for a toast. */
function validationSummary(v: KeyValidation): {
  title: string;
  description: string;
  variant: 'success' | 'destructive' | 'default';
} {
  if (!v.ok)
    return {
      title: 'Key stored, but it failed validation',
      description: v.error ?? '',
      variant: 'destructive',
    };
  const degraded = degradedLabel(v);
  if (degraded === null)
    return {
      title: 'Key stored and valid',
      description: 'It is encrypted and never shown again.',
      variant: 'success',
    };
  const bad = v.models.filter((m) => !m.ok).length;
  return {
    title: `Key stored, but it has ${degraded === 'Bad scope' ? 'a bad scope' : 'model errors'}`,
    description: `${bad} of ${v.models.length} models could not be confirmed. See the key row.`,
    variant: 'default',
  };
}

export function ProviderKeysCard({ now = Date.now() }: { now?: number }) {
  const keys = useAiKeys();
  const create = useCreateAiKey();
  const remove = useDeleteAiKey();
  const [pendingDelete, setPendingDelete] = useState<AiKey | null>(null);
  const [editing, setEditing] = useState<AiKey | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const form = useForm<KeyInput>({
    resolver: zodResolver(KeySchema),
    defaultValues: { provider: 'anthropic', value: '', displayName: '', expires: '' },
  });
  const { errors, isSubmitting } = form.formState;
  const selectedProvider = form.watch('provider');

  const submit = form.handleSubmit(async ({ provider, value, displayName, expires }) => {
    setFormError(null);
    try {
      // The label is the provider id: that is how AI calls find the key for a provider.
      const created = await create.mutateAsync({
        label: provider,
        value,
        ...(displayName === '' ? {} : { displayName }),
        expiresAt: dateInputToEpoch(expires),
      });
      form.reset({ provider, value: '', displayName: '', expires: '' });
      if (created.validation === undefined) {
        toast({ title: 'Key stored', variant: 'success' });
      } else {
        toast(validationSummary(created.validation));
      }
    } catch (err) {
      setFormError(applyServerError(err, form.setError, ['value', 'displayName']));
    }
  });

  const items = keys.data ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Provider keys</CardTitle>
        <CardDescription>
          Keys are encrypted at rest and sent only to their own provider. Each key is checked when
          you add it and whenever you press Validate. When a provider has several keys, the newest
          is used.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6">
        {keys.isPending ? (
          <p className="text-sm text-muted-foreground">Loading keys...</p>
        ) : keys.isError ? (
          <p role="alert" className="text-sm text-destructive">
            Could not load keys.
          </p>
        ) : items.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No keys stored yet. AI features stay off until you add one.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Key</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead>Added</TableHead>
                <TableHead className="w-32">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((k) => (
                <KeyRow
                  key={k.id}
                  k={k}
                  now={now}
                  onEdit={() => setEditing(k)}
                  onDelete={() => setPendingDelete(k)}
                />
              ))}
            </TableBody>
          </Table>
        )}

        <form onSubmit={submit} noValidate className="grid gap-4 border-t pt-6 sm:grid-cols-2">
          <FormError message={formError} className="sm:col-span-2" />
          <FormField label="Provider" error={errors.provider?.message}>
            {(p) => (
              <Select {...p} {...form.register('provider')}>
                {PROVIDERS.map((id) => (
                  <option key={id} value={id}>
                    {providerLabel(id)}
                  </option>
                ))}
              </Select>
            )}
          </FormField>
          <FormField
            label="API key"
            hint={
              selectedProvider === 'anthropic'
                ? 'Use a key scoped to a workspace, or a user key mapped to a default workspace. Organization-scoped keys authenticate but every model call fails with a workspace error.'
                : undefined
            }
            error={errors.value?.message}
          >
            {(p) => (
              <Input
                {...p}
                type="password"
                autoComplete="off"
                spellCheck={false}
                {...form.register('value')}
              />
            )}
          </FormField>
          <FormField
            label="Key name (optional)"
            hint="The name the key has in the provider console."
            error={errors.displayName?.message}
          >
            {(p) => (
              <Input {...p} maxLength={100} autoComplete="off" {...form.register('displayName')} />
            )}
          </FormField>
          <FormField
            label="Expires (optional)"
            hint="From the provider console; providers do not report it."
            error={errors.expires?.message}
          >
            {(p) => <Input {...p} type="date" {...form.register('expires')} />}
          </FormField>
          <div className="sm:col-span-2">
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Saving and checking...' : 'Add key'}
            </Button>
          </div>
        </form>
      </CardContent>
      <EditKeyDialog k={editing} onClose={() => setEditing(null)} />
      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(o) => {
          if (!o) setPendingDelete(null);
        }}
        title="Remove this key?"
        description={`The ${pendingDelete === null ? '' : providerLabel(pendingDelete.label)} key will be deleted from the vault. AI features that use it stop working until you add another key.`}
        confirmLabel="Remove key"
        onConfirm={async () => {
          if (pendingDelete !== null) await remove.mutateAsync(pendingDelete.id);
        }}
      />
    </Card>
  );
}

function KeyRow({
  k,
  now,
  onEdit,
  onDelete,
}: {
  k: AiKey;
  now: number;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const validate = useValidateKey();
  const chip = keyChip(k, now);
  const expiry = expiryText(k.expiresAt, now);
  const name = providerLabel(k.label);
  const models = k.validation?.models ?? [];

  return (
    <TableRow data-testid={`key-row-${k.id}`}>
      <TableCell className="align-top font-medium">
        <span className="flex items-center gap-2">
          <KeyRound aria-hidden="true" className="size-4 text-muted-foreground" />
          {name}
          {isProvider(k.label) ? null : (
            <span className="text-xs font-normal text-muted-foreground">
              (not linked to a provider)
            </span>
          )}
        </span>
        {k.displayName === null ? null : (
          <span className="block pl-6 text-xs font-normal text-muted-foreground">
            {k.displayName}
          </span>
        )}
      </TableCell>
      <TableCell className="align-top">
        <div className="grid gap-1">
          <Badge variant={chip.variant}>{chip.label}</Badge>
          {chip.detail === null ? null : (
            <span className="max-w-xs text-xs break-words text-muted-foreground">
              {chip.detail}
            </span>
          )}
          {models.length === 0 ? null : (
            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">
                Models ({models.filter((m) => m.ok).length}/{models.length} confirmed)
              </summary>
              <ul className="mt-1 grid gap-1">
                {models.map((m) => (
                  <li key={m.model} className="grid gap-0.5">
                    <span className="flex items-center gap-2">
                      <span className="font-mono">{m.model}</span>
                      <span className={m.ok ? 'text-success' : 'text-destructive'}>
                        {m.ok ? 'ok' : 'failed'}
                      </span>
                    </span>
                    {m.error === null ? null : (
                      <span className="max-w-xs break-words text-muted-foreground">{m.error}</span>
                    )}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      </TableCell>
      <TableCell
        className={cn(
          'align-top',
          expiry.expired ? 'font-medium text-destructive' : 'text-muted-foreground',
        )}
        title={expiry.title ?? undefined}
      >
        {expiry.text}
      </TableCell>
      <TableCell className="align-top text-muted-foreground">
        {addedFmt.format(k.createdAt)}
      </TableCell>
      <TableCell className="align-top">
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            aria-label={`Validate ${name} key`}
            disabled={validate.isPending}
            onClick={() =>
              validate.mutate(k.id, {
                onSuccess: (v) => {
                  const degraded = v.ok ? degradedLabel(v) : null;
                  toast(
                    !v.ok
                      ? {
                          title: `${name} key failed validation`,
                          description: v.error ?? '',
                          variant: 'destructive',
                        }
                      : degraded === null
                        ? { title: `${name} key is valid`, variant: 'success' }
                        : {
                            title: `${name} key works, but: ${degraded.toLowerCase()}`,
                            description: 'See the per-model results on the key row.',
                          },
                  );
                },
              })
            }
          >
            <RefreshCw aria-hidden="true" className={cn(validate.isPending && 'animate-spin')} />
            {validate.isPending ? 'Checking...' : 'Validate'}
          </Button>
          <IconButton variant="ghost" label={`Edit key ${name}`} onClick={onEdit}>
            <Pencil aria-hidden="true" />
          </IconButton>
          <IconButton variant="ghost" label={`Remove key ${name}`} onClick={onDelete}>
            <Trash2 aria-hidden="true" />
          </IconButton>
        </div>
      </TableCell>
    </TableRow>
  );
}

const EditSchema = z.object({
  displayName: z.string().trim().max(100, 'At most 100 characters'),
  expires: DateInput,
});
type EditInput = z.infer<typeof EditSchema>;

/** Name and expiry only: the key value is never re-entered or shown. */
function EditKeyDialog({ k, onClose }: { k: AiKey | null; onClose: () => void }) {
  return (
    <Dialog
      open={k !== null}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent>
        {k === null ? null : <EditKeyForm key={k.id} k={k} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

function EditKeyForm({ k, onClose }: { k: AiKey; onClose: () => void }) {
  const update = useUpdateKeyMeta();
  const form = useForm<EditInput>({
    resolver: zodResolver(EditSchema),
    defaultValues: { displayName: k.displayName ?? '', expires: epochToDateInput(k.expiresAt) },
  });
  const { errors, isSubmitting } = form.formState;
  const submit = form.handleSubmit(async ({ displayName, expires }) => {
    try {
      await update.mutateAsync({
        id: k.id,
        patch: {
          displayName: displayName === '' ? null : displayName,
          expiresAt: dateInputToEpoch(expires),
        },
      });
      onClose();
    } catch {
      // The mutation's onError already showed a toast; keep the dialog open.
    }
  });
  return (
    <form onSubmit={submit} noValidate className="grid gap-4">
      <DialogHeader>
        <DialogTitle>Edit {providerLabel(k.label)} key</DialogTitle>
        <DialogDescription>Set the name and expiry date shown for this key.</DialogDescription>
      </DialogHeader>
      <FormField label="Key name" error={errors.displayName?.message}>
        {(p) => (
          <Input {...p} maxLength={100} autoComplete="off" {...form.register('displayName')} />
        )}
      </FormField>
      <FormField label="Expires" error={errors.expires?.message}>
        {(p) => <Input {...p} type="date" {...form.register('expires')} />}
      </FormField>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? 'Saving...' : 'Save'}
        </Button>
      </DialogFooter>
    </form>
  );
}
