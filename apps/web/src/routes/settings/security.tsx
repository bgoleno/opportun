import { useQuery } from '@tanstack/react-query';
import { createFileRoute, useRouter } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { z } from 'zod';
import { dropReason } from '@/lib/oauth';
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
  const router = useRouter();
  // As the page was sent with it: the address has it no more (#1021).
  const [reason] = useState(oauth);
  // A confirmation that is good for a password is a step, not a reason: it stays until it is used.
  const ready = reason === 'setpw_ready';
  useEffect(() => {
    if (!ready) dropReason(router, { keepHash: true });
  }, [ready, router]);
  const status = useQuery(twoFactorQuery);
  // An account created by OAuth sign-in has no password: it sets one instead of changing it.
  const passwordless = status.data?.hasPassword === false;
  return (
    <div className="grid gap-6">
      {passwordless ? (
        <SetPasswordCard
          email={user?.email ?? ''}
          flash={reason}
          onSpent={() => dropReason(router, { keepHash: true })}
        />
      ) : (
        <PasswordCard email={user?.email ?? ''} />
      )}
      <TwoFactorCard />
      <LinkedAccountsCard flash={reason} />
    </div>
  );
}
