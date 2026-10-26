// Settings > Users (admins only): whether every account has signed in since the pepper was last
// rotated, so install.md's "once every account has signed in, the previous OPPORTUN_PEPPER_V#
// can be dropped" step can be verified instead of guessed at (issue #64).
import { useQuery } from '@tanstack/react-query';
import { FormError } from '@/components/FormError';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { api, errorMessage } from '@/lib/api';

interface PendingAccount {
  id: string;
  email: string;
  displayName: string;
  /** Most recent auth.login audit event for this account; null if it has never signed in. */
  lastSignInAt: number | null;
}

const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

interface PepperStatus {
  /** The pepper version new hashes are stamped with; 0 means no pepper is configured. */
  currentVersion: number;
  /** Accounts with a usable password not yet stamped with currentVersion. */
  pending: PendingAccount[];
}

const pepperStatusQuery = {
  queryKey: ['admin', 'peppers'] as const,
  queryFn: () => api<PepperStatus>('/admin/peppers'),
};

export function PepperRotationCard() {
  const status = useQuery(pepperStatusQuery);

  if (status.isError) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Password pepper</CardTitle>
        </CardHeader>
        <CardContent>
          <FormError message={errorMessage(status.error)} />
        </CardContent>
      </Card>
    );
  }

  // No pepper configured: nothing to rotate, so the card has nothing useful to say.
  if (status.data === undefined || status.data.currentVersion === 0) return null;

  const { currentVersion, pending } = status.data;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Password pepper</CardTitle>
        <CardDescription>
          {pending.length === 0 ? (
            <>
              Every account has signed in since pepper version {currentVersion} was set. It is safe
              to drop any older <code>OPPORTUN_PEPPER_V#</code> secret.
            </>
          ) : (
            <>
              The accounts below have not signed in since pepper version {currentVersion} was set.
              Keep the previous <code>OPPORTUN_PEPPER_V#</code> secret until they have, or dropping
              it locks them out.
            </>
          )}
        </CardDescription>
      </CardHeader>
      {pending.length === 0 ? null : (
        <CardContent>
          <ul
            aria-label="Accounts not yet signed in since the pepper rotation"
            className="grid gap-1 text-sm"
          >
            {pending.map((u) => (
              <li key={u.id}>
                {u.displayName} ({u.email}):{' '}
                {u.lastSignInAt === null
                  ? 'never signed in'
                  : `last signed in ${dateFmt.format(new Date(u.lastSignInAt))}`}
              </li>
            ))}
          </ul>
        </CardContent>
      )}
    </Card>
  );
}
