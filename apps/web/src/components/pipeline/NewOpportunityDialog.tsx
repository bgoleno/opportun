import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { FormError } from '@/components/FormError';
import { FormField } from '@/components/FormField';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { api, ApiError } from '@/lib/api';
import { applyServerError, optionalString } from '@/lib/forms';
import { qk, stageLabel, type OpportunityView } from '@/lib/opportunities';

const optionalUrl = z
  .string()
  .trim()
  .max(2048, 'Use at most 2048 characters')
  .refine((s) => {
    if (s === '') return true;
    try {
      const u = new URL(s);
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
      return false;
    }
  }, 'Enter an http or https URL')
  .transform((s) => (s === '' ? null : s));

const FormSchema = z.object({
  companyName: z.string().trim().min(1, 'Enter the company').max(200),
  title: z.string().trim().min(1, 'Enter the title').max(300),
  postingUrl: optionalUrl,
  location: optionalString(200),
  descriptionMd: optionalString(100_000),
});
type FormInput = z.input<typeof FormSchema>;
type FormOutput = z.output<typeof FormSchema>;
const FIELDS = ['companyName', 'title', 'postingUrl', 'location', 'descriptionMd'] as const;

const EMPTY: FormInput = {
  companyName: '',
  title: '',
  postingUrl: '',
  location: '',
  descriptionMd: '',
};

/**
 * Manual opportunity entry. A 409 duplicate shows the existing opportunity and offers
 * "Create anyway", which retries with ?force=true.
 */
export function NewOpportunityDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (opp: OpportunityView) => void;
}) {
  const qc = useQueryClient();
  const [formError, setFormError] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState<{ existingId: string; body: unknown } | null>(null);
  const [busy, setBusy] = useState(false);
  const form = useForm<FormInput, unknown, FormOutput>({
    resolver: zodResolver(FormSchema),
    defaultValues: EMPTY,
  });
  const { errors } = form.formState;

  function close(open: boolean) {
    if (!open) {
      form.reset(EMPTY);
      setDuplicate(null);
      setFormError(null);
    }
    props.onOpenChange(open);
  }

  async function create(body: unknown, force: boolean) {
    setBusy(true);
    setFormError(null);
    try {
      const opp = await api<OpportunityView>(`/opportunities${force ? '?force=true' : ''}`, {
        method: 'POST',
        body,
      });
      await Promise.all([
        qc.invalidateQueries({ queryKey: qk.opportunities }),
        qc.invalidateQueries({ queryKey: qk.dashboard }),
      ]);
      toast({
        title: 'Opportunity added',
        description: `${opp.companyName}: ${opp.title}`,
        variant: 'success',
      });
      close(false);
      props.onCreated?.(opp);
    } catch (err) {
      const existingId = err instanceof ApiError ? err.details.existingId : undefined;
      if (err instanceof ApiError && err.code === 'duplicate' && typeof existingId === 'string') {
        setDuplicate({ existingId, body });
      } else {
        setFormError(applyServerError(err, form.setError, FIELDS));
      }
    } finally {
      setBusy(false);
    }
  }

  const submit = form.handleSubmit((v) => create({ ...v, sourceKind: 'manual' }, false));

  return (
    <Dialog open={props.open} onOpenChange={close}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>New opportunity</DialogTitle>
          <DialogDescription>
            Add a role you found yourself. It starts in {stageLabel('discovered')}.
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" noValidate onSubmit={submit}>
          <FormError message={formError} />
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Company" error={errors.companyName?.message}>
              {(c) => <Input autoComplete="off" {...c} {...form.register('companyName')} />}
            </FormField>
            <FormField label="Title" error={errors.title?.message}>
              {(c) => <Input autoComplete="off" {...c} {...form.register('title')} />}
            </FormField>
          </div>
          <FormField label="Posting URL" error={errors.postingUrl?.message}>
            {(c) => <Input type="url" inputMode="url" {...c} {...form.register('postingUrl')} />}
          </FormField>
          <FormField label="Location" error={errors.location?.message}>
            {(c) => <Input {...c} {...form.register('location')} />}
          </FormField>
          <FormField
            label="Description"
            hint="Markdown is supported."
            error={errors.descriptionMd?.message}
          >
            {(c) => <Textarea rows={5} {...c} {...form.register('descriptionMd')} />}
          </FormField>
          {duplicate ? (
            <div
              role="alert"
              className="grid gap-2 rounded-md border border-primary/40 bg-accent px-3 py-2 text-sm text-accent-foreground"
            >
              <p>This looks like an opportunity you already track.</p>
              <div className="flex flex-wrap items-center gap-3">
                <Link
                  to="/opportunities/$id"
                  params={{ id: duplicate.existingId }}
                  className="font-medium underline underline-offset-2"
                >
                  View the existing opportunity
                </Link>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void create(duplicate.body, true)}
                >
                  Create anyway
                </Button>
              </div>
            </div>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => close(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
