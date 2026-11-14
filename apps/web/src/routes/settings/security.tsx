import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { LinkedAccountsCard } from './-linkedAccounts';
import { PasswordCard } from './-password';
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
