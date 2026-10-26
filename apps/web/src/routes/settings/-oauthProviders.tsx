// Settings > Users (admins only): OAuth sign-in providers (FR-S4). One section per provider
// with the redirect URI to register (copy field, as in the Google integration wizard) and the
// client credentials. The server never returns the secret, so the fields always start empty
// and saving replaces what is stored. When a Google client is already on file for the
// Drive/Gmail integration, the section offers to reuse it instead: the server copies both
// values internally, so the secret is never sent to the browser to be sent back again.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { FormError } from '@/components/FormError';
import { FormField } from '@/components/FormField';
import { CopyField } from '@/components/google/GoogleSetup';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { providerLabel, type OAuthProvider } from '@/lib/oauth';

interface ProviderStatus {
  provider: OAuthProvider;
  configured: boolean;
  available: boolean;
  redirectUri: string;
  /** A client already saved for the Google integration, reusable here. Null for the rest. */
  integrationClientId: string | null;
  /** True once sign-in and that integration are running on one and the same client. */
  sharesIntegrationClient: boolean;
}

const adminProvidersQuery = {
  queryKey: ['admin', 'oauth-providers'] as const,
  queryFn: () => api<{ items: ProviderStatus[] }>('/admin/oauth-providers'),
};

function consoleHint(provider: OAuthProvider): string {
  switch (provider) {
    case 'google':
      return 'Google Cloud console > APIs & Services > Credentials: an OAuth client of type Web application. Sign-in needs only the openid, email and profile scopes.';
    case 'github':
      return 'GitHub > Settings > Developer settings > OAuth Apps: a new OAuth App. Paste the redirect URI as its authorization callback URL.';
    case 'linkedin':
      return 'LinkedIn Developer portal > My apps: an app with the "Sign In with LinkedIn using OpenID Connect" product. Add the redirect URI under Auth > Authorized redirect URLs. The server calls only LinkedIn\'s official token and userinfo endpoints for sign-in.';
  }
}

/**
 * The one-click reuse of the client already saved under Settings > Integrations. One Google
 * client serves both: a web client holds several redirect URIs, and scopes are asked for per
 * flow. The import is a POST with no body; the secret is copied server side.
 */
function ReuseIntegrationClient({
  provider,
  clientId,
  label,
}: {
  provider: OAuthProvider;
  clientId: string;
  label: string;
}) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function reuse() {
    setBusy(true);
    setError(null);
    try {
      await api(`/admin/oauth-providers/${provider}/import`, { method: 'POST' });
      void qc.invalidateQueries({ queryKey: adminProvidersQuery.queryKey });
      void qc.invalidateQueries({ queryKey: ['auth', 'oauth'] });
      toast({ title: `${label} sign-in saved`, variant: 'success' });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid max-w-md gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm">
      <p>
        You already saved a {label} client under Settings &gt; Integrations:{' '}
        <span className="font-mono text-xs break-all">{clientId}</span>
      </p>
      <FormError message={error} />
      <div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => void reuse()}
        >
          {busy ? 'Saving...' : 'Use that client'}
        </Button>
      </div>
      <p className="text-muted-foreground">
        One client can do both jobs. Add the redirect URI above to it in the Google console first,
        or sign-in fails with redirect_uri_mismatch.
      </p>
    </div>
  );
}

export function OAuthProvidersCard() {
  const providers = useQuery(adminProvidersQuery);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Sign-in providers</CardTitle>
        <CardDescription>
          Let people sign in with Google, GitHub or LinkedIn. Register this instance with the
          provider using the redirect URI shown, then paste the client ID and secret it gives you.
          New accounts from a provider are created only while registration is open.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {providers.isError ? <FormError message={errorMessage(providers.error)} /> : null}
        {providers.data?.items.map((p) => (
          <ProviderSection key={p.provider} status={p} />
        ))}
      </CardContent>
    </Card>
  );
}

function ProviderSection({ status }: { status: ProviderStatus }) {
  const qc = useQueryClient();
  const label = providerLabel(status.provider);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [errors, setErrors] = useState<{ clientId?: string; clientSecret?: string }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    const next: typeof errors = {};
    if (clientId.trim() === '') next.clientId = 'Enter the client ID';
    if (clientSecret.trim() === '') next.clientSecret = 'Enter the client secret';
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    setBusy(true);
    setFormError(null);
    try {
      await api(`/admin/oauth-providers/${status.provider}`, {
        method: 'PUT',
        body: { clientId: clientId.trim(), clientSecret: clientSecret.trim() },
      });
      setClientId('');
      setClientSecret('');
      void qc.invalidateQueries({ queryKey: adminProvidersQuery.queryKey });
      void qc.invalidateQueries({ queryKey: ['auth', 'oauth'] });
      toast({ title: `${label} sign-in saved`, variant: 'success' });
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label={`${label} sign-in`} className="grid gap-3 rounded-md border p-4">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        <span>{label} sign-in</span>
        {!status.available ? (
          <Badge variant="secondary">Unavailable</Badge>
        ) : status.configured ? (
          <Badge variant="success">Configured</Badge>
        ) : (
          <Badge variant="secondary">Not set up</Badge>
        )}
      </h3>
      {!status.available ? (
        <p className="text-sm text-muted-foreground">
          {label} sign-in is switched off in this build of Opportun.
        </p>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">{consoleHint(status.provider)}</p>
          {status.sharesIntegrationClient ? (
            <p
              className="max-w-md rounded-md border bg-muted/40 px-3 py-2 text-sm"
              data-testid={`oauth-${status.provider}-shared-client`}
            >
              Sign-in uses the same client as the one under Settings &gt; Integrations:{' '}
              <span className="font-mono text-xs break-all">{status.integrationClientId}</span>.
              Rotating or revoking it there breaks sign-in too.
            </p>
          ) : null}
          <CopyField
            id={`oauth-${status.provider}-redirect`}
            label="Redirect URI"
            value={status.redirectUri}
          />
          {status.integrationClientId === null || status.sharesIntegrationClient ? null : (
            <>
              <ReuseIntegrationClient
                provider={status.provider}
                clientId={status.integrationClientId}
                label={label}
              />
              <p className="text-sm text-muted-foreground">Or paste a different client:</p>
            </>
          )}
          <form onSubmit={(e) => void save(e)} noValidate className="grid max-w-md gap-3">
            <FormError message={formError} />
            <FormField label="Client ID" error={errors.clientId}>
              {(p) => (
                <Input
                  {...p}
                  autoComplete="off"
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                />
              )}
            </FormField>
            <FormField
              label="Client secret"
              error={errors.clientSecret}
              hint={
                status.configured ? 'A secret is stored. Saving replaces it.' : 'Stored encrypted.'
              }
            >
              {(p) => (
                <Input
                  {...p}
                  type="password"
                  autoComplete="new-password"
                  value={clientSecret}
                  onChange={(e) => setClientSecret(e.target.value)}
                />
              )}
            </FormField>
            <div className="flex gap-2">
              <Button type="submit" disabled={busy}>
                {busy ? 'Saving...' : 'Save'}
              </Button>
              {status.configured ? (
                <Button variant="outline" onClick={() => setRemoving(true)}>
                  Remove
                </Button>
              ) : null}
            </div>
          </form>
          <ConfirmDialog
            open={removing}
            onOpenChange={setRemoving}
            title={`Remove ${label} sign-in?`}
            description={`The ${label} button leaves the login page. Linked accounts stay linked and work again if you set it up later.`}
            confirmLabel="Remove"
            onConfirm={async () => {
              try {
                await api(`/admin/oauth-providers/${status.provider}`, { method: 'DELETE' });
                void qc.invalidateQueries({ queryKey: adminProvidersQuery.queryKey });
                void qc.invalidateQueries({ queryKey: ['auth', 'oauth'] });
              } catch (err) {
                toast({
                  title: 'Could not remove it',
                  description: errorMessage(err),
                  variant: 'destructive',
                });
              }
            }}
          />
        </>
      )}
    </section>
  );
}
