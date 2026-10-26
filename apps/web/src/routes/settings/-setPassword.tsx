// Settings > Security: the first password of an account created by OAuth sign-in (it has
// none). A session alone may not set it (review M-1): the user first confirms with a linked
// provider (mode=setpw), which comes back here with ?oauth=setpw_ready and leaves a
// five-minute, single-use grant on this session; only then is the form shown. Once set, it is
// an ordinary password (change it with the current one, enroll 2FA, link and unlink with it).
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { FormError } from '@/components/FormError';
import { FormField } from '@/components/FormField';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';
import { api, ApiError, errorMessage } from '@/lib/api';
import { PASSWORD_MIN } from '@/lib/auth';
import { applyServerError } from '@/lib/forms';
import { providerLabel, type OAuthProvider } from '@/lib/oauth';
import { linkedAccountsQuery } from './-linkedAccounts';
import { twoFactorQuery } from './-twoFactor';

const SetPasswordSchema = z
  .object({
    next: z.string().min(PASSWORD_MIN, `Use at least ${PASSWORD_MIN} characters`).max(1024),
    confirm: z.string(),
  })
  .refine((v) => v.next === v.confirm, { path: ['confirm'], message: 'Passwords do not match' });
type SetPasswordInput = z.infer<typeof SetPasswordSchema>;

const FLASH = new Map<string, string>([
  [
    'setpw_mismatch',
    'That provider account is not the one linked to this account. Confirm with the linked one.',
  ],
  ['setpw_denied', 'The confirmation was cancelled at the provider.'],
  ['setpw_error', 'Something went wrong confirming with the provider. Try again.'],
]);
const EXPIRED =
  'That confirmation expired or was already used. Confirm with your provider again, then set the password within five minutes.';

export function SetPasswordCard(props: {
  email?: string;
  /** ?oauth=... on the Security page: setpw_ready after a successful confirmation. */
  flash?: string | undefined;
  /** Leaves for the provider (tests replace it; jsdom cannot navigate). */
  navigate?: (url: string) => void;
}) {
  const email = props.email ?? '';
  const navigate = props.navigate ?? ((url: string) => window.location.assign(url));
  const qc = useQueryClient();
  const status = useQuery(twoFactorQuery);
  const linked = useQuery(linkedAccountsQuery);
  const [ready, setReady] = useState(props.flash === 'setpw_ready');
  const [notice, setNotice] = useState<string | null>(
    props.flash === undefined ? null : (FLASH.get(props.flash) ?? null),
  );
  const [formError, setFormError] = useState<string | null>(null);
  const form = useForm<SetPasswordInput>({
    resolver: zodResolver(SetPasswordSchema),
    defaultValues: { next: '', confirm: '' },
  });
  const { errors, isSubmitting } = form.formState;

  if (status.data?.hasPassword !== false) return null;
  const providers: OAuthProvider[] = (linked.data?.accounts ?? []).map((a) => a.provider);

  async function confirmWith(provider: OAuthProvider) {
    setNotice(null);
    try {
      const { authUrl } = await api<{ authUrl: string }>(`/auth/oauth/${provider}/setpw`, {
        method: 'POST',
        body: {},
      });
      navigate(authUrl);
    } catch (err) {
      setNotice(errorMessage(err));
    }
  }

  const submit = form.handleSubmit(async ({ next }) => {
    setFormError(null);
    try {
      await api('/auth/password', { method: 'POST', body: { next } });
      form.reset();
      void qc.invalidateQueries({ queryKey: twoFactorQuery.queryKey });
      void qc.invalidateQueries({ queryKey: linkedAccountsQuery.queryKey });
      toast({
        title: 'Password set',
        description: 'You can now sign in with it, turn on two-factor and link providers.',
        variant: 'success',
      });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'reauth_required') {
        form.reset();
        setReady(false);
        setNotice(EXPIRED);
        return;
      }
      setFormError(applyServerError(err, form.setError, ['next']));
    }
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Set a password</CardTitle>
        <CardDescription>
          Your account signs in only through a linked provider. A password gives you another way in,
          and is needed to turn on two-factor sign-in or to link and unlink providers.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <FormError message={notice} />
        {!ready ? (
          <div className="grid gap-3">
            <p className="text-sm text-muted-foreground">
              First confirm it is you with a provider linked to this account. You then have five
              minutes to choose the password.
            </p>
            <div className="flex flex-wrap gap-2">
              {providers.map((p) => (
                <Button key={p} variant="outline" onClick={() => void confirmWith(p)}>
                  Confirm with {providerLabel(p)}
                </Button>
              ))}
            </div>
          </div>
        ) : (
          <form onSubmit={submit} noValidate className="grid max-w-sm gap-4">
            {/* Lets password managers attach the new password to the right account. */}
            <input type="email" autoComplete="username" value={email} readOnly hidden />
            <FormError message={formError} />
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
                {isSubmitting ? 'Setting...' : 'Set password'}
              </Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
