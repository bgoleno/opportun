import { createFileRoute } from '@tanstack/react-router';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { OAuthProvidersCard } from './-oauthProviders';
import { PepperRotationCard } from './-pepperRotation';
import { RegistrationCard, UsersCard } from './-users';

export const Route = createFileRoute('/settings/users')({
  component: UsersSettings,
});

function UsersSettings() {
  const { user } = Route.useRouteContext();
  if (user === null) return null;
  // The server refuses non-admins too; this only spares them a page of errors.
  if (!user.isAdmin) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Users</CardTitle>
          <CardDescription>Only an administrator can manage accounts.</CardDescription>
        </CardHeader>
      </Card>
    );
  }
  return (
    // grid-cols-1: the accounts table scrolls inside its card only if the card may be narrower
    // than the table, which a bare grid's auto track does not allow.
    <div className="grid grid-cols-1 gap-6">
      <UsersCard currentUserId={user.id} />
      <PepperRotationCard />
      <RegistrationCard />
      <OAuthProvidersCard />
    </div>
  );
}
