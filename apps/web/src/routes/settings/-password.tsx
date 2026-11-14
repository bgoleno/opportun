// Changing a password that exists (an account created by OAuth sign-in sets one instead, in
// -setPassword.tsx). Moved here from security.tsx so it can be tested on its own (#523).
import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { FormError } from '@/components/FormError';
import { FormField } from '@/components/FormField';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from '@/components/ui/toast';
import { api, ApiError } from '@/lib/api';
import { PASSWORD_MIN } from '@/lib/auth';
import { applyServerError } from '@/lib/forms';

const PasswordSchema = z
  .object({
    current: z.string().min(1, 'Enter your current password'),
    next: z.string().min(PASSWORD_MIN, `Use at least ${PASSWORD_MIN} characters`).max(1024),
    confirm: z.string(),
    revokeDeviceTokens: z.boolean(),
  })
  .refine((v) => v.next === v.confirm, { path: ['confirm'], message: 'Passwords do not match' });
type PasswordInput = z.infer<typeof PasswordSchema>;

export function PasswordCard({ email }: { email: string }) {
  const [formError, setFormError] = useState<string | null>(null);
  const form = useForm<PasswordInput>({
    resolver: zodResolver(PasswordSchema),
    // Checked by default (#523): someone changing a password because they suspect a compromise
    // should not have to know that device tokens are a separate credential.
    defaultValues: { current: '', next: '', confirm: '', revokeDeviceTokens: true },
  });
  const { errors, isSubmitting } = form.formState;

  const submit = form.handleSubmit(async ({ current, next, revokeDeviceTokens }) => {
    setFormError(null);
    try {
      await api('/auth/password', {
        method: 'POST',
        body: { current, next, revokeDeviceTokens },
      });
      form.reset();
      toast({
        title: 'Password changed',
        description: revokeDeviceTokens
          ? 'Other devices have been signed out, and the extension and Mail connector were signed out too: pair them again from Settings.'
          : 'Other devices have been signed out.',
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
          <div className="grid gap-1">
            <div className="flex items-start gap-2">
              <input
                id="revoke-device-tokens"
                type="checkbox"
                className="mt-0.5 size-4"
                aria-describedby="revoke-device-tokens-hint"
                {...form.register('revokeDeviceTokens')}
              />
              <Label htmlFor="revoke-device-tokens">
                Also sign out the browser extension and the Mail connector
              </Label>
            </div>
            <p id="revoke-device-tokens-hint" className="text-xs text-muted-foreground">
              This revokes their device tokens: pair them again from Settings afterwards. Leave it
              on if you are changing your password because you think someone else has it.
            </p>
          </div>
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
