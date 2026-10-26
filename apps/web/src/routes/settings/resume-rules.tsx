import { zodResolver } from '@hookform/resolvers/zod';
import { RESUME_RULE_CATEGORIES, type ResumeRule } from '@opportun/core';
import { createFileRoute } from '@tanstack/react-router';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { FormError } from '@/components/FormError';
import { FormField } from '@/components/FormField';
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
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { applyServerError } from '@/lib/forms';
import {
  isTemp,
  useCreateResumeRule,
  useDeleteResumeRule,
  useResumeRules,
  useUpdateResumeRule,
  type ResumeRuleInput,
} from './-api';

export const Route = createFileRoute('/settings/resume-rules')({
  component: ResumeRulesSettings,
});

function categoryLabel(c: ResumeRule['category']): string {
  switch (c) {
    case 'content':
      return 'Content';
    case 'redaction':
      return 'Redaction';
    default:
      return 'Style';
  }
}

const RuleFormSchema = z.object({
  ruleText: z.string().trim().min(1, 'Describe the rule').max(2000),
  category: z.enum(RESUME_RULE_CATEGORIES),
  sortOrder: z
    .string()
    .trim()
    .transform((s, ctx) => {
      if (s === '') return 0;
      const n = Number(s);
      if (!Number.isInteger(n) || Math.abs(n) > 1_000_000) {
        ctx.addIssue({ code: 'custom', message: 'Enter a whole number' });
        return z.NEVER;
      }
      return n;
    }),
  active: z.boolean(),
});
type RuleFormInput = z.input<typeof RuleFormSchema>;

function RuleForm(props: {
  initial?: ResumeRule;
  nextOrder: number;
  submitLabel: string;
  onSubmit: (input: ResumeRuleInput) => Promise<void>;
  onCancel: () => void;
}) {
  const [formError, setFormError] = useState<string | null>(null);
  const form = useForm<RuleFormInput, unknown, ResumeRuleInput>({
    resolver: zodResolver(RuleFormSchema),
    defaultValues: {
      ruleText: props.initial?.ruleText ?? '',
      category: props.initial?.category ?? 'style',
      sortOrder: String(props.initial?.sortOrder ?? props.nextOrder),
      active: props.initial?.active ?? true,
    },
  });
  const { errors, isSubmitting } = form.formState;
  const submit = form.handleSubmit(async (input) => {
    setFormError(null);
    try {
      await props.onSubmit(input);
    } catch (err) {
      setFormError(
        applyServerError(err, form.setError, ['ruleText', 'category', 'sortOrder', 'active']),
      );
    }
  });

  return (
    <form onSubmit={submit} noValidate className="grid gap-4">
      <FormError message={formError} />
      <FormField label="Rule" error={errors.ruleText?.message}>
        {(p) => (
          <Textarea
            {...p}
            rows={3}
            placeholder="Never mention my current employer by name."
            {...form.register('ruleText')}
          />
        )}
      </FormField>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label="Category" error={errors.category?.message}>
          {(p) => (
            <Select {...p} {...form.register('category')}>
              {RESUME_RULE_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {categoryLabel(c)}
                </option>
              ))}
            </Select>
          )}
        </FormField>
        <FormField
          label="Order"
          error={errors.sortOrder?.message}
          hint="Lower numbers apply first."
        >
          {(p) => <Input {...p} inputMode="numeric" {...form.register('sortOrder')} />}
        </FormField>
      </div>
      <div className="flex items-center gap-2">
        <input
          id="resume-rule-active"
          type="checkbox"
          className="size-4 accent-primary"
          {...form.register('active')}
        />
        <label htmlFor="resume-rule-active" className="text-sm font-medium">
          Active
        </label>
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={props.onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? 'Saving...' : props.submitLabel}
        </Button>
      </div>
    </form>
  );
}

type Editing = { mode: 'create' } | { mode: 'edit'; rule: ResumeRule } | null;

export function ResumeRulesSettings() {
  const list = useResumeRules();
  const create = useCreateResumeRule();
  const update = useUpdateResumeRule();
  const remove = useDeleteResumeRule();
  const [editing, setEditing] = useState<Editing>(null);
  const [pendingDelete, setPendingDelete] = useState<ResumeRule | null>(null);

  const items = list.data?.items ?? [];
  const nextOrder = items.reduce((m, r) => Math.max(m, r.sortOrder + 10), 0);

  async function save(input: ResumeRuleInput) {
    if (editing?.mode === 'edit') {
      await update.mutateAsync({ id: editing.rule.id, patch: input });
      toast({ title: 'Rule updated', variant: 'success' });
    } else {
      await create.mutateAsync(input);
      toast({ title: 'Rule added', variant: 'success' });
    }
    setEditing(null);
  }

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-start justify-between gap-4">
        <div className="grid gap-1.5">
          <CardTitle>Resume rules</CardTitle>
          <CardDescription>
            Standing instructions applied every time a resume is tailored.
          </CardDescription>
        </div>
        <Button onClick={() => setEditing({ mode: 'create' })}>
          <Plus aria-hidden="true" />
          New rule
        </Button>
      </CardHeader>
      <CardContent>
        {list.isPending ? (
          <p className="text-sm text-muted-foreground">Loading rules...</p>
        ) : list.isError ? (
          <p role="alert" className="text-sm text-destructive">
            Could not load rules.
          </p>
        ) : items.length === 0 ? (
          <p className="text-sm text-muted-foreground">No rules yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-16">Order</TableHead>
                <TableHead>Rule</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Active</TableHead>
                <TableHead className="w-24">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((r) => {
                const pending = isTemp(r.id);
                return (
                  <TableRow
                    key={r.id}
                    aria-busy={pending || undefined}
                    className={pending ? 'opacity-60' : undefined}
                  >
                    <TableCell className="text-muted-foreground tabular-nums">
                      {r.sortOrder}
                    </TableCell>
                    <TableCell className="max-w-md whitespace-pre-wrap">{r.ruleText}</TableCell>
                    <TableCell>
                      <Badge variant={r.category === 'redaction' ? 'destructive' : 'secondary'}>
                        {categoryLabel(r.category)}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <input
                        type="checkbox"
                        aria-label={`Rule ${r.sortOrder} active`}
                        checked={r.active}
                        disabled={pending}
                        onChange={(e) =>
                          update.mutate({ id: r.id, patch: { active: e.target.checked } })
                        }
                        className="size-4 accent-primary"
                      />
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        <IconButton
                          variant="ghost"
                          label={`Edit rule ${r.sortOrder}`}
                          disabled={pending}
                          onClick={() => setEditing({ mode: 'edit', rule: r })}
                        >
                          <Pencil aria-hidden="true" />
                        </IconButton>
                        <IconButton
                          variant="ghost"
                          label={`Delete rule ${r.sortOrder}`}
                          disabled={pending}
                          onClick={() => setPendingDelete(r)}
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
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing?.mode === 'edit' ? 'Edit rule' : 'New rule'}</DialogTitle>
            <DialogDescription>
              Style shapes tone and format, content adds or emphasizes facts, redaction removes
              information.
            </DialogDescription>
          </DialogHeader>
          {editing !== null ? (
            <RuleForm
              key={editing.mode === 'edit' ? editing.rule.id : 'new'}
              {...(editing.mode === 'edit' ? { initial: editing.rule } : {})}
              nextOrder={nextOrder}
              submitLabel={editing.mode === 'edit' ? 'Save changes' : 'Add rule'}
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
        title="Delete this rule?"
        description="It will no longer be applied to new resumes."
        confirmLabel="Delete"
        onConfirm={async () => {
          if (pendingDelete !== null) await remove.mutateAsync(pendingDelete.id);
        }}
      />
    </Card>
  );
}
