import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';
import { FormError } from '@/components/FormError';
import { FormField } from '@/components/FormField';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { applyServerError, splitList } from '@/lib/forms';
import { activityKindLabel, safeHttpUrl } from '@/lib/opportunities';
import { useCreateActivity, type ActivityInput } from './api';

const COMPOSER_KINDS = ['note', 'meeting', 'interview', 'link'] as const;

const FormSchema = z
  .object({
    kind: z.enum(COMPOSER_KINDS),
    title: z.string().trim().min(1, 'Enter a title').max(300),
    bodyMd: z.string().trim().max(100_000),
    participants: z.string(),
    externalUrl: z.string().trim().max(2048),
    occurredAt: z.string(),
  })
  .superRefine((v, ctx) => {
    if (v.kind === 'link' && safeHttpUrl(v.externalUrl) === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['externalUrl'],
        message: 'Enter an http or https URL',
      });
    }
  });
type FormValues = z.infer<typeof FormSchema>;
const FIELDS = ['kind', 'title', 'bodyMd', 'participants', 'externalUrl', 'occurredAt'] as const;
const EMPTY: FormValues = {
  kind: 'note',
  title: '',
  bodyMd: '',
  participants: '',
  externalUrl: '',
  occurredAt: '',
};

/** Adds a note, meeting, interview or link to the opportunity's timeline. */
export function ActivityComposer({ opportunityId }: { opportunityId: string }) {
  const create = useCreateActivity(opportunityId);
  const [formError, setFormError] = useState<string | null>(null);
  const form = useForm<FormValues>({ resolver: zodResolver(FormSchema), defaultValues: EMPTY });
  const { errors } = form.formState;
  const kind = useWatch({ control: form.control, name: 'kind' });
  const withPeople = kind === 'meeting' || kind === 'interview';

  const submit = form.handleSubmit(async (v) => {
    setFormError(null);
    const body: ActivityInput = { kind: v.kind, title: v.title };
    if (v.bodyMd) body.bodyMd = v.bodyMd;
    if (withPeople) {
      const people = splitList(v.participants);
      if (people.length > 0) body.participants = people;
      const at = v.occurredAt ? new Date(v.occurredAt).getTime() : Number.NaN;
      if (!Number.isNaN(at)) body.occurredAt = at;
    }
    if (v.kind === 'link') body.externalUrl = v.externalUrl;
    try {
      await create.mutateAsync(body);
      form.reset({ ...EMPTY, kind: v.kind });
    } catch (err) {
      setFormError(applyServerError(err, form.setError, FIELDS));
    }
  });

  return (
    <form
      aria-labelledby="activity-composer-heading"
      noValidate
      onSubmit={submit}
      className="grid gap-3 rounded-xl border bg-card p-4"
    >
      <h2 id="activity-composer-heading" className="text-sm font-semibold">
        Add to timeline
      </h2>
      <FormError message={formError} />
      <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
        <FormField label="Type">
          {(c) => (
            <Select {...c} {...form.register('kind')}>
              {COMPOSER_KINDS.map((k) => (
                <option key={k} value={k}>
                  {activityKindLabel(k)}
                </option>
              ))}
            </Select>
          )}
        </FormField>
        <FormField label="Title" error={errors.title?.message}>
          {(c) => <Input autoComplete="off" {...c} {...form.register('title')} />}
        </FormField>
      </div>
      {kind === 'link' ? (
        <FormField label="URL" error={errors.externalUrl?.message}>
          {(c) => <Input type="url" inputMode="url" {...c} {...form.register('externalUrl')} />}
        </FormField>
      ) : null}
      {withPeople ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Participants" hint="Separate names with commas.">
            {(c) => <Input autoComplete="off" {...c} {...form.register('participants')} />}
          </FormField>
          <FormField label="When" hint="Leave empty for now.">
            {(c) => <Input type="datetime-local" {...c} {...form.register('occurredAt')} />}
          </FormField>
        </div>
      ) : null}
      <FormField label="Details" hint="Markdown is supported." error={errors.bodyMd?.message}>
        {(c) => <Textarea rows={3} {...c} {...form.register('bodyMd')} />}
      </FormField>
      <div className="flex justify-end">
        <Button type="submit" disabled={create.isPending}>
          Add
        </Button>
      </div>
    </form>
  );
}
