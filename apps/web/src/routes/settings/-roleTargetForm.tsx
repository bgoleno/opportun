// Role target create/edit form (FR-P2). Field rules come from the shared core schema and
// the seniority range uses core's checkSeniorityRange, so the client rejects exactly what
// the server would.
import { zodResolver } from '@hookform/resolvers/zod';
import {
  checkSeniorityRange,
  REMOTE_PREFS,
  RoleTargetBaseSchema,
  SENIORITY_LEVELS,
  seniorityLabel,
} from '@opportun/core';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { FormError } from '@/components/FormError';
import { FormField } from '@/components/FormField';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import {
  applyServerError,
  joinList,
  numberText,
  optionalString,
  optionalWholeNumber,
  splitList,
} from '@/lib/forms';

const core = RoleTargetBaseSchema.shape;

export function remoteLabel(r: (typeof REMOTE_PREFS)[number]): string {
  switch (r) {
    case 'remote':
      return 'Remote';
    case 'hybrid':
      return 'Hybrid';
    case 'onsite':
      return 'On-site';
    default:
      return 'Any';
  }
}

/**
 * Seniority select options: "Any" (empty, an open end) plus the named ladder. A stored value
 * off the ladder (legacy or API-written) is kept as an extra "Level N" option so editing a
 * target never silently changes it.
 */
function seniorityOptions(current: number | null | undefined) {
  const options: { value: string; label: string }[] = [
    { value: '', label: 'Any' },
    ...SENIORITY_LEVELS.map((l) => ({ value: String(l.value), label: l.label })),
  ];
  if (current != null && !SENIORITY_LEVELS.some((l) => l.value === current)) {
    options.push({ value: String(current), label: seniorityLabel(current) ?? '' });
  }
  return options;
}

// Core fields are optional/defaulted for the API; the form always sends a value, so pipe
// into the unwrapped (exact) core schemas.
const listField = (coreField: typeof core.industries) =>
  z
    .string()
    .transform(splitList)
    .pipe(z.array(z.string().max(200, 'Keep each entry under 200 characters')).max(100))
    .pipe(coreField.unwrap());

const RoleTargetFormSchema = z
  .object({
    name: z.string().trim().min(1, 'Enter a name').max(200).pipe(core.name),
    titleFamily: z.string().trim().min(1, 'Enter a title family').max(200).pipe(core.titleFamily),
    seniorityMin: optionalWholeNumber.pipe(core.seniorityMin.unwrap()),
    seniorityMax: optionalWholeNumber.pipe(core.seniorityMax.unwrap()),
    industries: listField(core.industries),
    keywords: listField(core.keywords),
    locations: listField(core.locations),
    remotePref: z.enum(REMOTE_PREFS),
    compMin: optionalWholeNumber.pipe(core.compMin.unwrap()),
    compMax: optionalWholeNumber.pipe(core.compMax.unwrap()),
    currency: optionalString(3)
      .refine((s) => s === null || /^[A-Za-z]{3}$/.test(s), 'Use a 3-letter code like USD')
      .transform((s) => (s === null ? null : s.toUpperCase()))
      .pipe(core.currency.unwrap()),
    active: z.boolean(),
  })
  .superRefine((value, ctx) => {
    // Same rule as the server; only the wording is rephrased for people.
    checkSeniorityRange(value, {
      ...ctx,
      value,
      addIssue: (issue) => {
        if (typeof issue === 'string') return ctx.addIssue(issue);
        ctx.addIssue({
          ...issue,
          message: 'Minimum seniority cannot be above the maximum',
        });
      },
    } as z.RefinementCtx);
    if (value.compMin !== null && value.compMax !== null && value.compMin > value.compMax) {
      ctx.addIssue({
        code: 'custom',
        path: ['compMin'],
        message: 'Minimum compensation cannot be above the maximum',
      });
    }
  });

type FormInput = z.input<typeof RoleTargetFormSchema>;
/** The POST /role-targets (and full PATCH) body. */
export type RoleTargetPayload = z.output<typeof RoleTargetFormSchema>;

const FIELDS = Object.keys(RoleTargetFormSchema.shape);

function toFormValues(t?: RoleTargetPayload): FormInput {
  return {
    name: t?.name ?? '',
    titleFamily: t?.titleFamily ?? '',
    seniorityMin: numberText(t?.seniorityMin),
    seniorityMax: numberText(t?.seniorityMax),
    industries: joinList(t?.industries),
    keywords: joinList(t?.keywords),
    locations: joinList(t?.locations),
    remotePref: t?.remotePref ?? 'any',
    compMin: numberText(t?.compMin),
    compMax: numberText(t?.compMax),
    currency: t?.currency ?? '',
    active: t?.active ?? true,
  };
}

export function RoleTargetForm(props: {
  initial?: RoleTargetPayload;
  onSubmit: (payload: RoleTargetPayload) => Promise<void> | void;
  onCancel?: () => void;
  submitLabel: string;
}) {
  const [formError, setFormError] = useState<string | null>(null);
  const form = useForm<FormInput, unknown, RoleTargetPayload>({
    resolver: zodResolver(RoleTargetFormSchema),
    defaultValues: toFormValues(props.initial),
  });
  const { errors, isSubmitting } = form.formState;

  const submit = form.handleSubmit(async (payload) => {
    setFormError(null);
    try {
      await props.onSubmit(payload);
    } catch (err) {
      setFormError(applyServerError(err, form.setError, FIELDS));
    }
  });

  return (
    <form onSubmit={submit} noValidate className="grid gap-4">
      <FormError message={formError} />
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label="Name" error={errors.name?.message}>
          {(p) => <Input {...p} {...form.register('name')} />}
        </FormField>
        <FormField label="Title family" error={errors.titleFamily?.message}>
          {(p) => <Input {...p} placeholder="Product Manager" {...form.register('titleFamily')} />}
        </FormField>
        <FormField label="Minimum seniority" error={errors.seniorityMin?.message}>
          {(p) => (
            <Select {...p} {...form.register('seniorityMin')}>
              {seniorityOptions(props.initial?.seniorityMin).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          )}
        </FormField>
        <FormField label="Maximum seniority" error={errors.seniorityMax?.message}>
          {(p) => (
            <Select {...p} {...form.register('seniorityMax')}>
              {seniorityOptions(props.initial?.seniorityMax).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          )}
        </FormField>
      </div>
      <FormField label="Industries" error={errors.industries?.message} hint="Comma separated.">
        {(p) => <Input {...p} {...form.register('industries')} />}
      </FormField>
      <FormField label="Keywords" error={errors.keywords?.message} hint="Comma separated.">
        {(p) => <Input {...p} {...form.register('keywords')} />}
      </FormField>
      <FormField label="Locations" error={errors.locations?.message} hint="Comma separated.">
        {(p) => <Input {...p} {...form.register('locations')} />}
      </FormField>
      <div className="grid gap-4 sm:grid-cols-3">
        <FormField label="Work arrangement" error={errors.remotePref?.message}>
          {(p) => (
            <Select {...p} {...form.register('remotePref')}>
              {REMOTE_PREFS.map((r) => (
                <option key={r} value={r}>
                  {remoteLabel(r)}
                </option>
              ))}
            </Select>
          )}
        </FormField>
        <FormField label="Minimum compensation" error={errors.compMin?.message}>
          {(p) => <Input {...p} inputMode="numeric" {...form.register('compMin')} />}
        </FormField>
        <FormField label="Maximum compensation" error={errors.compMax?.message}>
          {(p) => <Input {...p} inputMode="numeric" {...form.register('compMax')} />}
        </FormField>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <FormField label="Currency" error={errors.currency?.message} hint="For example USD.">
          {(p) => <Input {...p} maxLength={3} {...form.register('currency')} />}
        </FormField>
      </div>
      <div className="flex items-center gap-2">
        <input
          id="role-target-active"
          type="checkbox"
          className="size-4 rounded border-input accent-primary focus-visible:ring-2 focus-visible:ring-ring"
          {...form.register('active')}
        />
        <label htmlFor="role-target-active" className="text-sm font-medium">
          Active
        </label>
      </div>
      <div className="flex justify-end gap-2">
        {props.onCancel ? (
          <Button variant="outline" onClick={props.onCancel}>
            Cancel
          </Button>
        ) : null}
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? 'Saving...' : props.submitLabel}
        </Button>
      </div>
    </form>
  );
}
