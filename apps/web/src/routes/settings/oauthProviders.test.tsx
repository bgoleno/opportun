import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockApi, renderWithProviders } from '@/test/render';
import { OAuthProvidersCard } from './-oauthProviders';

const BASE = 'https://opportun.example.com/api/v1/auth/oauth';
/** The client the admin already saved under Settings > Integrations, if any. */
const INTEGRATION_CLIENT_ID = 'saved-client.apps.googleusercontent.com';
const items = (
  configured: { google: boolean; github: boolean },
  integrationClientId: string | null = null,
  sharesIntegrationClient = false,
) => [
  {
    provider: 'google',
    configured: configured.google,
    available: true,
    redirectUri: `${BASE}/google/callback`,
    integrationClientId,
    sharesIntegrationClient,
  },
  {
    provider: 'github',
    configured: configured.github,
    available: true,
    redirectUri: `${BASE}/github/callback`,
    integrationClientId: null,
    sharesIntegrationClient: false,
  },
  {
    provider: 'linkedin',
    configured: false,
    available: true,
    redirectUri: `${BASE}/linkedin/callback`,
    integrationClientId: null,
    sharesIntegrationClient: false,
  },
];

describe('OAuthProvidersCard', () => {
  it('shows each provider with its redirect URI to copy and its status', async () => {
    mockApi({ 'GET /admin/oauth-providers': { items: items({ google: true, github: false }) } });
    renderWithProviders(<OAuthProvidersCard />);
    const google = await screen.findByRole('region', { name: 'Google sign-in' });
    expect(within(google).getByText('Configured')).toBeInTheDocument();
    expect(within(google).getByLabelText('Redirect URI')).toHaveValue(`${BASE}/google/callback`);
    expect(within(google).getByRole('button', { name: 'Copy Redirect URI' })).toBeInTheDocument();
    const github = screen.getByRole('region', { name: 'GitHub sign-in' });
    expect(within(github).getByText('Not set up')).toBeInTheDocument();
    const linkedin = screen.getByRole('region', { name: 'LinkedIn sign-in' });
    expect(within(linkedin).getByLabelText('Redirect URI', { exact: true })).toHaveValue(
      `${BASE}/linkedin/callback`,
    );
    expect(within(linkedin).getByLabelText('Client ID')).toBeInTheDocument();
    expect(linkedin).toHaveTextContent(/official token and userinfo endpoints/);
  });

  it('saves credentials and never pre-fills or echoes the secret', async () => {
    const user = userEvent.setup();
    let configured = false;
    const { calls } = mockApi({
      'GET /admin/oauth-providers': () => ({ items: items({ google: false, github: configured }) }),
      'PUT /admin/oauth-providers/github': () => {
        configured = true;
        return items({ google: false, github: true })[1];
      },
    });
    renderWithProviders(<OAuthProvidersCard />);
    const github = await screen.findByRole('region', { name: 'GitHub sign-in' });
    await user.click(within(github).getByRole('button', { name: 'Save' }));
    expect(await within(github).findByText('Enter the client ID')).toBeInTheDocument();
    await user.type(within(github).getByLabelText('Client ID'), 'Iv1.abc');
    await user.type(within(github).getByLabelText('Client secret'), 'shh-secret');
    await user.click(within(github).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
        clientId: 'Iv1.abc',
        clientSecret: 'shh-secret',
      }),
    );
    expect(await within(github).findByText('Configured')).toBeInTheDocument();
    expect(within(github).getByLabelText('Client secret')).toHaveValue('');
  });

  it('imports the Google client already saved under Integrations, with nothing retyped', async () => {
    const user = userEvent.setup();
    let configured = false;
    const { calls } = mockApi({
      'GET /admin/oauth-providers': () => ({
        items: items({ google: configured, github: false }, INTEGRATION_CLIENT_ID),
      }),
      'POST /admin/oauth-providers/google/import': () => {
        configured = true;
        return items({ google: true, github: false }, INTEGRATION_CLIENT_ID)[0];
      },
    });
    renderWithProviders(<OAuthProvidersCard />);
    const google = await screen.findByRole('region', { name: 'Google sign-in' });
    expect(google).toHaveTextContent(INTEGRATION_CLIENT_ID);
    await user.click(within(google).getByRole('button', { name: 'Use that client' }));
    await waitFor(() =>
      expect(
        calls.some((c) => c.method === 'POST' && c.path === '/admin/oauth-providers/google/import'),
      ).toBe(true),
    );
    expect(await within(google).findByText('Configured')).toBeInTheDocument();
  });

  it('says the redirect URI must be on that client too, since the scopes differ', async () => {
    mockApi({
      'GET /admin/oauth-providers': {
        items: items({ google: false, github: false }, INTEGRATION_CLIENT_ID),
      },
    });
    renderWithProviders(<OAuthProvidersCard />);
    const google = await screen.findByRole('region', { name: 'Google sign-in' });
    expect(google).toHaveTextContent(/redirect URI above/i);
  });

  it('says when the two now share one client, and what rotating it would cost', async () => {
    mockApi({
      'GET /admin/oauth-providers': {
        items: items({ google: true, github: false }, INTEGRATION_CLIENT_ID, true),
      },
    });
    renderWithProviders(<OAuthProvidersCard />);
    const google = await screen.findByRole('region', { name: 'Google sign-in' });
    expect(google).toHaveTextContent(/same client as the one under Settings > Integrations/i);
    expect(google).toHaveTextContent(INTEGRATION_CLIENT_ID);
    expect(google).toHaveTextContent(/breaks sign-in/i);
    // Nothing left to import: the offer would be a no-op on the client already in use.
    expect(within(google).queryByRole('button', { name: 'Use that client' })).toBeNull();
  });

  it('offers nothing to reuse when no client is saved under Integrations', async () => {
    mockApi({ 'GET /admin/oauth-providers': { items: items({ google: false, github: false }) } });
    renderWithProviders(<OAuthProvidersCard />);
    const google = await screen.findByRole('region', { name: 'Google sign-in' });
    expect(within(google).queryByRole('button', { name: 'Use that client' })).toBeNull();
    expect(within(google).getByLabelText('Client ID')).toHaveValue('');
  });

  it('removes a configured provider after confirmation', async () => {
    const user = userEvent.setup();
    const { calls } = mockApi({
      'GET /admin/oauth-providers': { items: items({ google: true, github: false }) },
      'DELETE /admin/oauth-providers/google': () => ({ status: 204 }),
    });
    renderWithProviders(<OAuthProvidersCard />);
    const google = await screen.findByRole('region', { name: 'Google sign-in' });
    await user.click(within(google).getByRole('button', { name: 'Remove' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove Google sign-in?' });
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() =>
      expect(
        calls.some((c) => c.method === 'DELETE' && c.path === '/admin/oauth-providers/google'),
      ).toBe(true),
    );
  });
});
