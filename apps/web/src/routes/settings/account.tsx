import { createFileRoute, Link } from '@tanstack/react-router';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useTheme, type ThemePref } from '@/lib/theme';

export const Route = createFileRoute('/settings/account')({
  component: AccountSettings,
});

const THEME_CHOICES: { value: ThemePref; label: string; hint: string }[] = [
  { value: 'light', label: 'Light', hint: 'Always light.' },
  { value: 'dark', label: 'Dark', hint: 'Always dark.' },
  { value: 'auto', label: 'Auto', hint: 'Follow your operating system setting.' },
];

function AccountSettings() {
  const { user } = Route.useRouteContext();
  if (user === null) return null;
  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Account</CardTitle>
          <CardDescription>Who you are signed in as.</CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-3 text-sm sm:grid-cols-[8rem_1fr]">
            <dt className="text-muted-foreground">Name</dt>
            <dd>{user.displayName}</dd>
            <dt className="text-muted-foreground">Email</dt>
            <dd className="break-all">{user.email}</dd>
            <dt className="text-muted-foreground">Role</dt>
            <dd>
              {user.isAdmin ? (
                <Badge>Administrator</Badge>
              ) : (
                <Badge variant="secondary">Member</Badge>
              )}
            </dd>
          </dl>
        </CardContent>
      </Card>
      <AppearanceCard />
      {user.isAdmin ? (
        <Card>
          <CardHeader>
            <CardTitle>Users and registration</CardTitle>
            <CardDescription>
              Accounts, password resets and the registration toggle are under{' '}
              <Link
                to="/settings/users"
                className="font-medium text-primary underline-offset-4 hover:underline"
              >
                Settings, Users
              </Link>
              .
            </CardDescription>
          </CardHeader>
        </Card>
      ) : null}
    </div>
  );
}

function AppearanceCard() {
  const { pref, setPref } = useTheme();
  return (
    <Card>
      <CardHeader>
        <CardTitle>Appearance</CardTitle>
        <CardDescription>Saved to your account and applied on every device.</CardDescription>
      </CardHeader>
      <CardContent>
        <fieldset className="grid gap-2 sm:grid-cols-3">
          <legend className="sr-only">Theme</legend>
          {THEME_CHOICES.map((c) => (
            <label
              key={c.value}
              className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm transition-colors has-[:checked]:border-primary has-[:checked]:bg-accent has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring"
            >
              <input
                type="radio"
                name="theme"
                value={c.value}
                checked={pref === c.value}
                onChange={() => setPref(c.value)}
                className="mt-0.5 accent-primary outline-none"
              />
              <span className="grid gap-0.5">
                <span className="font-medium">{c.label}</span>
                <span className="text-muted-foreground">{c.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>
      </CardContent>
    </Card>
  );
}
