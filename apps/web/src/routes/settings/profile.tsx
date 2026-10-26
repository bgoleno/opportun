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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';
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

function ProfileSettings() {
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
  return <ProfileForm key={profile.data.userId} profile={profile.data} />;
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
            <FormField label="Location" error={errors.location?.message}>
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
