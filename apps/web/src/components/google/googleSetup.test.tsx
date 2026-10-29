import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { useGoogleStatus, type GoogleStatus } from '@/components/resume/api';
import { mockApi, renderWithProviders } from '@/test/render';
import { GOOGLE_LINKS, GoogleQuickLinks, GoogleSetupGuide } from './GoogleSetup';

const REDIRECT = 'https://opportun.example.ts.net/api/v1/integrations/google/callback';
const ORIGIN = 'https://opportun.example.ts.net';
const FIX_INVALID =
  'The ID and secret do not match a live OAuth client. Re-copy both from the SAME client in the console, and check for truncation.';

function status(over: Partial<GoogleStatus> = {}): GoogleStatus {
  return {
    connected: false,
    scopes: [],
    clientConfigured: false,
    clientId: null,
    redirectUri: REDIRECT,
    jsOrigin: ORIGIN,
    signInRedirectUri: `${ORIGIN}/api/v1/auth/oauth/google/callback`,
    aiAvailable: false,
    validation: null,
    ...over,
  };
}

/** The Google card's setup half, fed by the status endpoint like the real card. */
function Harness() {
  const s = useGoogleStatus();
  return (
    <>
      <GoogleQuickLinks />
      {s.data ? <GoogleSetupGuide status={s.data} /> : null}
    </>
  );
}

async function fillAndSave(user: ReturnType<typeof userEvent.setup>) {
  await user.type(await screen.findByLabelText('Client id'), 'x.apps.googleusercontent.com');
  await user.type(screen.getByLabelText('Client secret'), 'GOCSPX-abc');
  await user.click(screen.getByRole('button', { name: 'Save client' }));
}

describe('GoogleSetupGuide', () => {
  it('renders every console step with new-tab links and the server-reported values to copy', async () => {
    const user = userEvent.setup();
    mockApi({ 'GET /integrations/google': status() });
    renderWithProviders(<Harness />);

    expect(await screen.findByLabelText('Authorized redirect URI')).toHaveValue(REDIRECT);
    // Sign in with Google reuses this client, so its callback must be registered too.
    expect(screen.getByLabelText('Second redirect URI, for Sign in with Google')).toHaveValue(
      'https://opportun.example.ts.net/api/v1/auth/oauth/google/callback',
    );
    expect(screen.getByLabelText('Authorized JavaScript origin')).toHaveValue(ORIGIN);
    expect(screen.getByLabelText('Application type')).toHaveValue('Web application');
    for (const [i, name] of [
      'Choose your Google account',
      'Create or select a project',
      'Enable the required APIs',
      'Set up branding (the consent screen)',
      'Choose the audience and add yourself as a test user',
      'Create the OAuth client',
      'Paste the Client ID and secret',
      "Connect: what Google's consent looks like",
    ].entries()) {
      expect(
        screen.getByRole('heading', {
          // The sr-only "Step n:" prefix; jsdom drops the space between the two spans.
          name: (acc) => acc.startsWith(`Step ${i}:`) && acc.endsWith(name),
        }),
      ).toBeInTheDocument();
    }

    const hrefs = screen.getAllByRole('link').map((a) => {
      expect(a).toHaveAttribute('target', '_blank');
      expect(a.getAttribute('rel')).toContain('noopener');
      expect(a.getAttribute('rel')).toContain('noreferrer');
      return a.getAttribute('href');
    });
    for (const href of Object.values(GOOGLE_LINKS)) expect(hrefs).toContain(href);

    await user.click(screen.getByRole('button', { name: 'Copy Authorized redirect URI' }));
    expect(await navigator.clipboard.readText()).toBe(REDIRECT);
  });

  it('the API step links Drive, Docs and Gmail enable pages and says which features need them', async () => {
    mockApi({ 'GET /integrations/google': status() });
    renderWithProviders(<Harness />);
    const heading = await screen.findByRole('heading', {
      name: (acc) => acc.endsWith('Enable the required APIs'),
    });
    const step = within(heading.closest('li')!);
    for (const [name, href] of [
      ['Google Drive API', GOOGLE_LINKS.driveApi],
      ['Google Docs API', GOOGLE_LINKS.docsApi],
      ['Gmail API', GOOGLE_LINKS.gmailApi],
    ] as const) {
      const link = step.getByRole('link', { name: (acc) => acc.startsWith(name) });
      expect(link).toHaveAttribute('href', href);
      expect(link).toHaveAttribute('target', '_blank');
    }
    expect(step.getByText(/needed for resume flows/)).toBeInTheDocument();
    expect(step.getByText(/needed for inbox sync/)).toBeInTheDocument();
    expect(step.getByText(/accessNotConfigured/)).toBeInTheDocument();
  });

  it('tells the user to add themselves as a test user and warns about the 7-day Testing expiry', async () => {
    mockApi({ 'GET /integrations/google': status() });
    renderWithProviders(<Harness />);
    expect(await screen.findByText(/ADD YOURSELF/)).toHaveTextContent(/access_denied at consent/);
    expect(screen.getByText(/NOT in that wizard/)).toHaveTextContent(
      /Publishing status and Test users/,
    );
    const note = screen.getByTestId('google-testing-expiry');
    expect(note).toHaveTextContent(/about 7 days/);
    expect(note).toHaveTextContent(/In production/);
    expect(note).toHaveTextContent(/Advanced, then Continue/);
    expect(screen.getByText(/project limit/)).toBeInTheDocument();
    expect(screen.getByText(/ONCE in a dialog/)).toBeInTheDocument();
    expect(screen.getByText(/AI-powered agent/)).toHaveTextContent(/unchecked/);
    expect(screen.getByText(/chip at the top/)).toHaveTextContent(/wrong project/);
    expect(screen.getByText(/PORT INCLUDED/)).toHaveTextContent(/always uses the values above/);
    expect(screen.getByText(/Check the avatar/)).toBeInTheDocument();
  });

  it('always offers troubleshooting for the four classic errors, without an AI key', async () => {
    const user = userEvent.setup();
    mockApi({
      'GET /integrations/google': status({
        clientConfigured: true,
        aiAvailable: false,
        validation: { ok: true, status: 'valid', checkedAt: Date.now() },
      }),
    });
    renderWithProviders(<Harness />);
    await user.click(await screen.findByText('Troubleshooting'));
    const list = within(screen.getByTestId('google-troubleshooting'));
    for (const code of [
      'redirect_uri_mismatch',
      'access_denied',
      /^accessNotConfigured/,
      'invalid_client',
    ]) {
      expect(list.getByText(code)).toBeVisible();
    }
    expect(list.getByText(/match the copy value above EXACTLY/)).toBeInTheDocument();
    expect(screen.queryByText('Diagnose an error')).not.toBeInTheDocument();
  });

  it('keeps the console and help links visible when the console steps are collapsed', async () => {
    mockApi({
      'GET /integrations/google': status({
        clientConfigured: true,
        validation: { ok: true, status: 'valid', checkedAt: Date.now() },
      }),
    });
    renderWithProviders(<Harness />);
    expect(await screen.findByRole('button', { name: 'Show console steps' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Authorized redirect URI')).not.toBeInTheDocument();
    const hrefs = screen.getAllByRole('link').map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(expect.arrayContaining([GOOGLE_LINKS.createClient, GOOGLE_LINKS.help]));
    expect(screen.getByLabelText('Client id')).toBeInTheDocument();
  });

  it('save shows Valid in green', async () => {
    const user = userEvent.setup();
    const { calls } = mockApi({
      'GET /integrations/google': status(),
      'POST /integrations/google/client': {
        stored: true,
        validation: { ok: true, status: 'valid', checkedAt: Date.now() },
      },
    });
    renderWithProviders(<Harness />);
    await fillAndSave(user);
    const result = await screen.findByTestId('google-validation');
    const chip = within(result).getByText('Valid');
    expect(chip.className).toContain('bg-success');
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      clientId: 'x.apps.googleusercontent.com',
      clientSecret: 'GOCSPX-abc',
    });
    // The form keeps reflecting the stored client: id stays, only the secret clears.
    expect(screen.getByLabelText('Client id')).toHaveValue('x.apps.googleusercontent.com');
    expect(screen.getByLabelText('Client secret')).toHaveValue('');
  });

  it('a configured client prefills its id and marks the secret as saved and hidden', async () => {
    mockApi({
      'GET /integrations/google': status({
        clientConfigured: true,
        clientId: 'stored.apps.googleusercontent.com',
        validation: { ok: true, status: 'valid', checkedAt: Date.now() },
      }),
    });
    renderWithProviders(<Harness />);
    expect(await screen.findByLabelText('Client id')).toHaveValue(
      'stored.apps.googleusercontent.com',
    );
    expect(screen.getByLabelText('Client secret')).toHaveValue('');
    expect(screen.getByTestId('google-secret-saved')).toHaveTextContent(/never shown again/);
  });

  it('save shows Invalid in red with the error and the proposed fix', async () => {
    const user = userEvent.setup();
    mockApi({
      'GET /integrations/google': status(),
      'POST /integrations/google/client': {
        stored: true,
        validation: {
          ok: false,
          status: 'invalid',
          error: 'invalid_client',
          fix: FIX_INVALID,
          checkedAt: Date.now(),
        },
      },
    });
    renderWithProviders(<Harness />);
    await fillAndSave(user);
    const result = within(await screen.findByTestId('google-validation'));
    expect(result.getByText('Invalid').className).toContain('bg-destructive');
    expect(result.getByText(/invalid_client/)).toBeInTheDocument();
    expect(result.getByText(`Fix: ${FIX_INVALID}`)).toBeInTheDocument();
  });

  it('save shows Unverified in yellow with a retry that revalidates', async () => {
    const user = userEvent.setup();
    const { calls } = mockApi({
      'GET /integrations/google': status(),
      'POST /integrations/google/client': {
        stored: true,
        validation: {
          ok: false,
          status: 'unverified',
          error: 'unreachable',
          fix: 'Google could not be reached to check the client. It is saved; retry the check in a minute.',
          checkedAt: Date.now(),
        },
      },
      'POST /integrations/google/client/validate': {
        validation: { ok: true, status: 'valid', checkedAt: Date.now() },
      },
    });
    renderWithProviders(<Harness />);
    await fillAndSave(user);
    const result = within(await screen.findByTestId('google-validation'));
    expect(result.getByText('Unverified').className).toContain('bg-warning');
    expect(
      result.getByText('Google could not be reached to check the credentials.'),
    ).toBeInTheDocument();
    expect(result.getByText(/^Fix: Google could not be reached/)).toBeInTheDocument();
    await user.click(result.getByRole('button', { name: 'Retry check' }));
    await waitFor(() =>
      expect(calls.some((c) => c.path === '/integrations/google/client/validate')).toBe(true),
    );
    expect(await screen.findByText('Valid')).toBeInTheDocument();
  });

  it('hides the diagnose assist without an AI key', async () => {
    mockApi({ 'GET /integrations/google': status({ aiAvailable: false }) });
    renderWithProviders(<Harness />);
    await screen.findByLabelText('Client id');
    expect(screen.queryByText('Diagnose an error')).not.toBeInTheDocument();
  });

  it('with an AI key, diagnoses a pasted error and renders hostile output as inert text', async () => {
    const user = userEvent.setup();
    const hostile = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=1</script>';
    const { calls } = mockApi({
      'GET /integrations/google': status({ aiAvailable: true }),
      'POST /integrations/google/diagnose': {
        explanation: `Redirect mismatch. ${hostile}`,
        fix: `Add ${REDIRECT} under Authorized redirect URIs. <b>now</b>`,
      },
    });
    const { container } = renderWithProviders(<Harness />);
    await user.click(await screen.findByText('Diagnose an error'));
    await user.type(
      screen.getByLabelText('Paste the error Google showed you'),
      'Error 400: redirect_uri_mismatch',
    );
    await user.click(screen.getByRole('button', { name: 'Diagnose' }));

    const out = await screen.findByTestId('diagnosis');
    expect(calls.find((c) => c.path === '/integrations/google/diagnose')?.body).toEqual({
      text: 'Error 400: redirect_uri_mismatch',
    });
    expect(out.textContent).toContain(hostile);
    expect(out.textContent).toContain('<b>now</b>');
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(out.querySelector('b')).toBeNull();
    expect((window as { __pwned?: number }).__pwned).toBeUndefined();
  });
});
