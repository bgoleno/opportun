import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { FormError } from '@/components/FormError';
import { FormField } from '@/components/FormField';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';
import { api, ApiError } from '@/lib/api';
import { PASSWORD_MIN } from '@/lib/auth';
import { applyServerError } from '@/lib/forms';
import { LinkedAccountsCard } from './-linkedAccounts';
import { SetPasswordCard } from './-setPassword';
import { TwoFactorCard, twoFactorQuery } from './-twoFactor';

export const Route = createFileRoute('/settings/security')({
  // ?oauth=... is the result of a Link round trip through a sign-in provider.
  validateSearch: z.object({ oauth: z.string().max(32).optional().catch(undefined) }),
  component: SecuritySettings,
});

function SecuritySettings() {
  const { user } = Route.useRouteContext();
  const { oauth } = Route.useSearch();
  const status = useQuery(twoFactorQuery);
  // An account created by OAuth sign-in has no password: it sets one instead of changing it.
  const passwordless = status.data?.hasPassword === false;
  return (
    <div className="grid gap-6">
      {passwordless ? (
        <SetPasswordCard email={user?.email ?? ''} flash={oauth} />
      ) : (
        <PasswordCard email={user?.email ?? ''} />
      )}
      <TwoFactorCard />
      <LinkedAccountsCard flash={oauth} />
    </div>
  );
}

const PasswordSchema = z
  .object({
    current: z.string().min(1, 'Enter your current password'),
    next: z.string().min(PASSWORD_MIN, `Use at least ${PASSWORD_MIN} characters`).max(1024),
    confirm: z.string(),
  })
  .refine((v) => v.next === v.confirm, { path: ['confirm'], message: 'Passwords do not match' });
type PasswordInput = z.infer<typeof PasswordSchema>;

function PasswordCard({ email }: { email: string }) {
  const [formError, setFormError] = useState<string | null>(null);
  const form = useForm<PasswordInput>({
    resolver: zodResolver(PasswordSchema),
    defaultValues: { current: '', next: '', confirm: '' },
  });
  const { errors, isSubmitting } = form.formState;

  const submit = form.handleSubmit(async ({ current, next }) => {
    setFormError(null);
    try {
      await api('/auth/password', { method: 'POST', body: { current, next } });
      form.reset();
      toast({
        title: 'Password changed',
        description: 'Other devices have been signed out.',
        variant: 'success',
      });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'invalid_current_password') {
        form.setError('current', { type: 'server', message: 'Current password is incorrect' });
        return;
      }
      setFormError(applyServerError(err, form.setError, ['current', 'next']));
    }
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Password</CardTitle>
        <CardDescription>Changing it signs out every other session.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} noValidate className="grid max-w-sm gap-4">
          {/* Lets password managers attach the new password to the right account. */}
          <input type="email" autoComplete="username" value={email} readOnly hidden />
          <FormError message={formError} />
          <FormField label="Current password" error={errors.current?.message}>
            {(p) => (
              <Input
                {...p}
                type="password"
                autoComplete="current-password"
                {...form.register('current')}
              />
            )}
          </FormField>
          <FormField
            label="New password"
            error={errors.next?.message}
            hint={`At least ${PASSWORD_MIN} characters.`}
          >
            {(p) => (
              <Input
                {...p}
                type="password"
                autoComplete="new-password"
                {...form.register('next')}
              />
            )}
          </FormField>
          <FormField label="Confirm new password" error={errors.confirm?.message}>
            {(p) => (
              <Input
                {...p}
                type="password"
                autoComplete="new-password"
                {...form.register('confirm')}
              />
            )}
          </FormField>
          <div>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Changing...' : 'Change password'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
