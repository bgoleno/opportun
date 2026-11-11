import { zodResolver } from '@hookform/resolvers/zod';
import type { Profile } from '@opportun/core';
import { createFileRoute } from '@tanstack/react-router';
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useFieldArray, useForm } from 'react-hook-form';
import { z } from 'zod';
import { FormError } from '@/components/FormError';
import { FormField } from '@/components/FormField';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { DETAIL_FIELDS, detailProblemText, LOCATION_HINT } from '@/components/apply/api';
import { ReviewCapCard } from '@/components/apply/ReviewUsage';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';
import { errorMessage } from '@/lib/api';
import { applyServerError, optionalString } from '@/lib/forms';
import { useProfile, useSaveProfile, type ProfileInput } from './-api';

export const Route = createFileRoute('/settings/profile')({
  component: ProfileSettings,
});

const ProfileFormSchema = z.object({
  fullName: optionalString(200),
  headline: optionalString(300),
  email: optionalString(254).pipe(z.email('Enter a valid email').nullable()),
  phone: optionalString(50),
  location: optionalString(200),
  workAuth: optionalString(200),
  links: z
    .array(
      z.object({
        label: z.string().trim().min(1, 'Add a label').max(100),
        url: z
          .string()
          .trim()
          .max(2048)
          .pipe(z.httpUrl('Use a full http(s) address, like https://example.com')),
      }),
    )
    .max(50),
});
type FormInput = z.input<typeof ProfileFormSchema>;

const FIELDS = ['fullName', 'headline', 'email', 'phone', 'location', 'workAuth', 'links'];

function toForm(p: Profile): FormInput {
  return {
    fullName: p.fullName ?? '',
    headline: p.headline ?? '',
    email: p.email ?? '',
    phone: p.phone ?? '',
    location: p.location ?? '',
    workAuth: p.workAuth ?? '',
    links: p.links.map((l) => ({ label: l.label, url: l.url })),
  };
}

export function ProfileSettings() {
  const profile = useProfile();
  if (profile.isPending) return <p className="text-sm text-muted-foreground">Loading profile...</p>;
  if (profile.isError) {
    return (
      <p role="alert" className="text-sm text-destructive">
        Could not load your profile.
      </p>
    );
  }
  // Keyed on load so the form takes fresh defaults if the profile is replaced elsewhere.
  return (
    // grid-cols-1 (minmax(0, 1fr)): an implicit column would not shrink below its widest content,
    // and the page would scroll sideways at 320 px.
    <div className="grid grid-cols-1 gap-6">
      <ProfileForm key={profile.data.userId} profile={profile.data} />
      <ApplicationDetailsCard key={`details-${profile.data.userId}`} profile={profile.data} />
      {/* Assisted apply's daily review limit (#130); renders nothing where the feature is off. */}
      <ReviewCapCard />
    </div>
  );
}

function ProfileForm({ profile }: { profile: Profile }) {
  const save = useSaveProfile();
  const [formError, setFormError] = useState<string | null>(null);
  const form = useForm<FormInput, unknown, ProfileInput>({
    resolver: zodResolver(ProfileFormSchema),
    defaultValues: toForm(profile),
  });
  const links = useFieldArray({ control: form.control, name: 'links' });
  const { errors, isSubmitting, isDirty } = form.formState;

  const submit = form.handleSubmit(async (input) => {
    setFormError(null);
    try {
      const saved = await save.mutateAsync(input);
      form.reset(toForm(saved));
      toast({ title: 'Profile saved', variant: 'success' });
    } catch (err) {
      setFormError(applyServerError(err, form.setError, FIELDS));
    }
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Profile</CardTitle>
        <CardDescription>
          Contact details used on generated resumes and applications.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} noValidate className="grid gap-4">
          <FormError message={formError} />
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Full name" error={errors.fullName?.message}>
              {(p) => <Input {...p} autoComplete="name" {...form.register('fullName')} />}
            </FormField>
            <FormField label="Headline" error={errors.headline?.message}>
              {(p) => (
                <Input
                  {...p}
                  placeholder="Product leader for developer platforms"
                  {...form.register('headline')}
                />
              )}
            </FormField>
            <FormField label="Contact email" error={errors.email?.message}>
              {(p) => (
                <Input {...p} type="email" autoComplete="email" {...form.register('email')} />
              )}
            </FormField>
            <FormField label="Phone" error={errors.phone?.message}>
              {(p) => <Input {...p} type="tel" autoComplete="tel" {...form.register('phone')} />}
            </FormField>
            <FormField
              label="Location (city)"
              hint={LOCATION_HINT}
              error={errors.location?.message}
            >
              {(p) => <Input {...p} placeholder="Seattle, WA" {...form.register('location')} />}
            </FormField>
            <FormField label="Work authorization" error={errors.workAuth?.message}>
              {(p) => <Input {...p} placeholder="US citizen" {...form.register('workAuth')} />}
            </FormField>
          </div>

          <fieldset className="grid gap-3">
            <legend className="mb-2 text-sm font-medium">Links</legend>
            {links.fields.length === 0 ? (
              <p className="text-sm text-muted-foreground">No links yet.</p>
            ) : null}
            {links.fields.map((field, i) => (
              <div key={field.id} className="grid gap-3 sm:grid-cols-[1fr_2fr_auto] sm:items-start">
                <FormField
                  label={`Link ${i + 1} label`}
                  error={form.getFieldState(`links.${i}.label`, form.formState).error?.message}
                >
                  {(p) => (
                    <Input {...p} placeholder="LinkedIn" {...form.register(`links.${i}.label`)} />
                  )}
                </FormField>
                <FormField
                  label={`Link ${i + 1} URL`}
                  error={form.getFieldState(`links.${i}.url`, form.formState).error?.message}
                >
                  {(p) => (
                    <Input
                      {...p}
                      type="url"
                      placeholder="https://"
                      {...form.register(`links.${i}.url`)}
                    />
                  )}
                </FormField>
                <IconButton
                  variant="ghost"
                  className="sm:mt-5.5"
                  label={`Remove link ${i + 1}`}
                  onClick={() => links.remove(i)}
                >
                  <Trash2 aria-hidden="true" />
                </IconButton>
              </div>
            ))}
            <div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => links.append({ label: '', url: '' })}
                disabled={links.fields.length >= 50}
              >
                <Plus aria-hidden="true" />
                Add link
              </Button>
            </div>
          </fieldset>

          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              disabled={!isDirty || isSubmitting}
              onClick={() => form.reset()}
            >
              Discard changes
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Saving...' : 'Save profile'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

/** The details whose home is the profile's Application details (#401): the rest are columns. */
const OWN_DETAILS = DETAIL_FIELDS.filter((f) => f.home === 'details');

function detailsOf(p: Profile): Record<string, string> {
  const saved = new Map(Object.entries(p.applicationDetails ?? {}));
  return Object.fromEntries(OWN_DETAILS.map((f) => [f.key, saved.get(f.key) ?? '']));
}

/** The profile's columns as stored, for a PUT that changes only the details (a full replace). */
function columnsOf(p: Profile): ProfileInput {
  return {
    fullName: p.fullName ?? null,
    headline: p.headline ?? null,
    email: p.email ?? null,
    phone: p.phone ?? null,
    location: p.location ?? null,
    workAuth: p.workAuth ?? null,
    links: p.links.map((l) => ({ label: l.label, url: l.url })),
  };
}

/**
 * Settings > Profile > Application details (#401): the details an application asks for that have
 * no column of their own, so they can be seen and changed outside an application. A new
 * application starts filled with them; the details step's Save to my profile writes here too.
 */
function ApplicationDetailsCard({ profile }: { profile: Profile }) {
  const save = useSaveProfile();
  const [values, setValues] = useState(() => detailsOf(profile));
  const [problems, setProblems] = useState<ReadonlyMap<string, string>>(new Map());
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const stored = detailsOf(profile);
  const dirty = OWN_DETAILS.some((f) => (values[f.key] ?? '').trim() !== (stored[f.key] ?? ''));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    const next = Object.fromEntries(
      OWN_DETAILS.map((f) => [f.key, (values[f.key] ?? '').trim()] as const).filter(
        ([, v]) => v !== '',
      ),
    );
    const found = new Map(
      Object.entries(next).flatMap(([k, v]) => {
        const text = detailProblemText(k, v);
        return text === null ? [] : [[k, text] as const];
      }),
    );
    setProblems(found);
    if (found.size > 0) return;
    setSaving(true);
    try {
      const saved = await save.mutateAsync({ ...columnsOf(profile), applicationDetails: next });
      setValues(detailsOf(saved));
      toast({ title: 'Application details saved', variant: 'success' });
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Application details</CardTitle>
        <CardDescription>
          A new application starts filled with these and your profile above. Changes on an
          application stay on that application unless you tick Save to my profile there.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {/* grid-cols-1 and a row that wraps: at 320 px the two buttons are wider than the card,
            and an implicit grid column would not shrink below them (mobile.spec). */}
        <form onSubmit={submit} noValidate className="grid grid-cols-1 gap-4">
          <FormError message={formError} />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {OWN_DETAILS.map((f) => (
              <FormField
                key={f.key}
                label={f.label}
                error={problems.get(f.key)}
                {...(f.hint === undefined ? {} : { hint: f.hint })}
              >
                {(p) => (
                  <Input
                    {...p}
                    type={f.type}
                    autoComplete={f.autoComplete}
                    value={values[f.key] ?? ''}
                    onChange={(e) => setValues((prev) => ({ ...prev, [f.key]: e.target.value }))}
                  />
                )}
              </FormField>
            ))}
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              variant="outline"
              disabled={!dirty || saving}
              onClick={() => {
                setValues(stored);
                setProblems(new Map());
              }}
            >
              Discard changes
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? 'Saving...' : 'Save application details'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
