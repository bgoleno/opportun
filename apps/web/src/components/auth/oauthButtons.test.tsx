import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { oauthFlashMessage, takePendingFromHash } from '@/lib/oauth';
import { mockApi, renderWithProviders } from '@/test/render';
import { OAuthButtons } from './OAuthButtons';

describe('OAuthButtons', () => {
  it('shows a sign-in link for each configured provider only', async () => {
    mockApi({ 'GET /auth/oauth/providers': { providers: ['google', 'github'] } });
    renderWithProviders(<OAuthButtons />);
    const google = await screen.findByRole('link', { name: 'Continue with Google' });
    expect(google).toHaveAttribute('href', '/api/v1/auth/oauth/google/start?mode=login');
    expect(screen.getByRole('link', { name: 'Continue with GitHub' })).toHaveAttribute(
      'href',
      '/api/v1/auth/oauth/github/start?mode=login',
    );
    expect(screen.queryByRole('link', { name: /LinkedIn/ })).toBeNull();
  });

  it('includes LinkedIn once an admin configures it', async () => {
    mockApi({ 'GET /auth/oauth/providers': { providers: ['linkedin'] } });
    renderWithProviders(<OAuthButtons />);
    expect(await screen.findByRole('link', { name: 'Continue with LinkedIn' })).toHaveAttribute(
      'href',
      '/api/v1/auth/oauth/linkedin/start?mode=login',
    );
  });

  it('renders nothing when no provider is configured', async () => {
    const { calls } = mockApi({ 'GET /auth/oauth/providers': { providers: [] } });
    renderWithProviders(<OAuthButtons />);
    await waitFor(() => expect(calls.some((c) => c.path === '/auth/oauth/providers')).toBe(true));
    expect(screen.queryByRole('link', { name: /Continue with/ })).toBeNull();
    expect(screen.queryByText(/or continue with/i)).toBeNull();
  });
});

describe('oauth login helpers', () => {
  it('maps callback flashes to messages', () => {
    expect(oauthFlashMessage('unknown')).toMatch(/No account/);
    expect(oauthFlashMessage('existing_account')).toMatch(
      /already has an account.*sign in with your password.*Settings > Security/s,
    );
    expect(oauthFlashMessage('denied')).toMatch(/cancelled/);
    expect(oauthFlashMessage('error')).toMatch(/went wrong/);
    expect(oauthFlashMessage(undefined)).toBeNull();
    expect(oauthFlashMessage('<script>')).toMatch(/went wrong/);
  });

  it('takes the pending 2FA token from the fragment and clears it from the address bar', () => {
    window.history.replaceState(
      null,
      '',
      '/login#pending2fa=abc_DEF-123abc_DEF-123abc_DEF-123abc_DEF-1',
    );
    expect(takePendingFromHash()).toBe('abc_DEF-123abc_DEF-123abc_DEF-123abc_DEF-1');
    expect(window.location.hash).toBe('');
    expect(window.location.pathname).toBe('/login');
    expect(takePendingFromHash()).toBeNull();
    window.history.replaceState(null, '', '/login#other=1');
    expect(takePendingFromHash()).toBeNull();
  });
});
