// Settings > Security: sign-in providers linked to this account (FR-S4). Linking and unlinking
// both take the current password like every other credential change (Wave-1 re-auth): Link
// posts it, then leaves for the provider, which sends the browser back here with ?oauth=....
// An account created by OAuth sign-in has no password, so it sets one first (the card above).
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { FormError } from '@/components/FormError';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { toast } from '@/components/ui/toast';
import { api, ApiError } from '@/lib/api';
import { oauthProvidersQuery, providerLabel, type OAuthProvider } from '@/lib/oauth';
import { PasswordDialog, passwordError } from './-twoFactor';

interface LinkedAccounts {
  hasPassword: boolean;
  accounts: { provider: OAuthProvider; createdAt: number }[];
}

export const linkedAccountsQuery = {
  queryKey: ['auth', 'oauth', 'accounts'] as const,
  queryFn: () => api<LinkedAccounts>('/auth/oauth/accounts'),
};

const FLASH = new Map<string, { text: string; error: boolean }>([
  ['linked', { text: 'Account linked. You can now sign in with it.', error: false }],
  [
    'conflict',
    {
      text: 'That provider account could not be linked: it is already linked to another account on this instance, or you already have a different account from that provider linked (unlink it first).',
      error: true,
    },
  ],
  ['denied', { text: 'Linking was cancelled at the provider.', error: true }],
  ['error', { text: 'Something went wrong linking that account. Try again.', error: true }],
]);

const LAST_METHOD =
  'This is the only way to sign in to your account, so it cannot be unlinked. Set a password first.';
const PASSWORD_REQUIRED = 'Set a password first: linking and unlinking ask for it.';

const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

type Pending = { action: 'link' | 'unlink'; provider: OAuthProvider };

export function LinkedAccountsCard(props: {
  flash?: string | undefined;
  /** Leaves for the provider (tests replace it; jsdom cannot navigate). */
  navigate?: (url: string) => void;
}) {
  const navigate = props.navigate ?? ((url: string) => window.location.assign(url));
  const qc = useQueryClient();
  const providers = useQuery(oauthProvidersQuery);
  const linked = useQuery(linkedAccountsQuery);
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState<string | null>(null);

  const configured = providers.data ?? [];
  const accounts = linked.data?.accounts ?? [];
  // Linked accounts stay listed (to unlink) even if an admin later removed the provider.
  const shown = [
    ...configured,
    ...accounts.map((a) => a.provider).filter((p) => !configured.includes(p)),
  ];
  if (providers.data === undefined || linked.data === undefined || shown.length === 0) {
    return null;
  }
  const hasPassword = linked.data.hasPassword;
  const notice = props.flash === undefined ? undefined : FLASH.get(props.flash);

  /** Runs the pending action; resolves to a message for the password dialog, or null. */
  async function run(p: Pending, password?: string): Promise<string | null> {
    try {
      if (p.action === 'link') {
        const { authUrl } = await api<{ authUrl: string }>(`/auth/oauth/${p.provider}/link`, {
          method: 'POST',
          body: { password },
        });
        navigate(authUrl);
        return null;
      }
      await api(`/auth/oauth/${p.provider}`, {
        method: 'DELETE',
        body: password === undefined ? {} : { password },
      });
      setPending(null);
      void qc.invalidateQueries({ queryKey: linkedAccountsQuery.queryKey });
      toast({ title: `${providerLabel(p.provider)} unlinked`, variant: 'success' });
      return null;
    } catch (err) {
      if (
        err instanceof ApiError &&
        (err.code === 'last_method' || err.code === 'password_required')
      ) {
        setPending(null);
        setError(err.code === 'last_method' ? LAST_METHOD : PASSWORD_REQUIRED);
        return null;
      }
      return passwordError(err);
    }
  }

  const label = pending === null ? '' : providerLabel(pending.provider);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Linked accounts</CardTitle>
        <CardDescription>
          Sign in with a Google, GitHub or LinkedIn account instead of your password. Two-factor
          sign-in, when on, still asks for a code.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {notice === undefined ? null : notice.error ? (
          <FormError message={notice.text} />
        ) : (
          <p role="status" className="text-sm text-success">
            {notice.text}
          </p>
        )}
        <FormError message={error} />
        {hasPassword ? null : (
          <p className="text-sm text-muted-foreground">
            Set a password above to link another provider.
          </p>
        )}
        <ul className="grid gap-2">
          {shown.map((p) => {
            const account = accounts.find((a) => a.provider === p);
            return (
              <li
                key={p}
                aria-label={providerLabel(p)}
                className="flex items-center justify-between gap-3 rounded-md border p-3"
              >
                <div className="flex items-center gap-2 text-sm font-medium">
                  {providerLabel(p)}
                  {account === undefined ? null : (
                    <Badge variant="success">
                      Linked {dateFmt.format(new Date(account.createdAt))}
                    </Badge>
                  )}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={account === undefined && !hasPassword}
                  aria-label={`${account === undefined ? 'Link' : 'Unlink'} ${providerLabel(p)}`}
                  onClick={() => {
                    setError(null);
                    setPending({ action: account === undefined ? 'link' : 'unlink', provider: p });
                  }}
                >
                  {account === undefined ? 'Link' : 'Unlink'}
                </Button>
              </li>
            );
          })}
        </ul>
      </CardContent>
      {hasPassword ? (
        <PasswordDialog
          open={pending !== null}
          onOpenChange={(open) => {
            if (!open) setPending(null);
          }}
          description={
            pending?.action === 'link'
              ? `Linking ${label} adds a way to sign in to your account, so confirm it is you.`
              : `Unlinking ${label} changes how you can sign in, so confirm it is you.`
          }
          onConfirm={(password) =>
            pending === null ? Promise.resolve(null) : run(pending, password)
          }
        />
      ) : (
        <ConfirmDialog
          open={pending !== null}
          onOpenChange={(open) => {
            if (!open) setPending(null);
          }}
          title={`Unlink ${label}?`}
          description={`You will no longer be able to sign in with ${label}.`}
          confirmLabel="Unlink"
          onConfirm={async () => {
            if (pending === null) return;
            const message = await run(pending);
            if (message !== null) setError(message);
          }}
        />
      )}
    </Card>
  );
}
