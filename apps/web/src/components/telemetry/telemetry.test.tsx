// Settings > Telemetry (design.md 14.1, 14.10; https://github.com/bgoleno/opportun/issues/342):
// the Collect switch and the export card. Every user sees whether collection and export are on,
// export's type and its signals, never its destination; an admin also gets the switch, the
// destination form (saved after their password is confirmed again), "Send a test", the last
// outcome and the drop counts. A stored credential is never shown again.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockApi, renderWithProviders } from '@/test/render';
import { TelemetrySettings } from './TelemetrySettings';

const OFF = { available: true, enabled: false, type: null, signals: [] };
const ADMIN_OFF = {
  ...OFF,
  admin: {
    destination: null,
    hasCredential: false,
    allowPrivate: true,
    lastSuccessAt: null,
    lastFailure: null,
    dropped: [],
  },
};
const ON = { available: true, enabled: true, type: 'otlp', signals: ['metrics', 'spans', 'logs'] };
const DEST = {
  type: 'otlp',
  scheme: 'https',
  host: 'otel.example.com',
  port: 4318,
  headerName: 'x-api-key',
};

describe('TelemetrySettings, as a user', () => {
  it('shows whether collection and export are on, the type and the signals, and no controls', async () => {
    mockApi({ 'GET /obs/settings': { collect: true }, 'GET /obs/export': ON });
    renderWithProviders(<TelemetrySettings isAdmin={false} />);
    const collect = await screen.findByRole('region', { name: 'Collection' });
    expect(await within(collect).findByRole('status')).toHaveTextContent('Collection is on');
    const exp = screen.getByRole('region', { name: 'Export' });
    await waitFor(() =>
      expect(within(exp).getByRole('status')).toHaveTextContent(
        'Export is on: OTLP, sending metrics, traces and logs.',
      ),
    );
    expect(exp).toHaveTextContent(/every user's telemetry/);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByLabelText('Host')).toBeNull();
  });
});

describe('TelemetrySettings, as an admin', () => {
  it('turns collection on', async () => {
    const api = mockApi({
      'GET /obs/settings': { collect: false },
      'PUT /obs/settings': { collect: true },
      'GET /obs/export': ADMIN_OFF,
    });
    renderWithProviders(<TelemetrySettings isAdmin />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Turn collection on' }));
    await waitFor(() =>
      expect(api.calls.find((c) => c.method === 'PUT' && c.path === '/obs/settings')?.body).toEqual(
        { collect: true },
      ),
    );
  });

  it('saves a destination after the password: the fields and the credential, never a URL', async () => {
    const api = mockApi({
      'GET /obs/settings': { collect: true },
      'GET /obs/export': ADMIN_OFF,
      'PUT /obs/export': {
        ...ON,
        admin: { ...ADMIN_OFF.admin, destination: DEST, hasCredential: true },
      },
    });
    renderWithProviders(<TelemetrySettings isAdmin />);
    const user = userEvent.setup();
    const exp = await screen.findByRole('region', { name: 'Export' });
    await user.selectOptions(await within(exp).findByLabelText('Destination type'), 'otlp');
    await user.type(within(exp).getByLabelText('Host'), 'otel.example.com');
    await user.clear(within(exp).getByLabelText('Port'));
    await user.type(within(exp).getByLabelText('Port'), '4318');
    await user.type(within(exp).getByLabelText('Header name'), 'x-api-key');
    await user.type(within(exp).getByLabelText('Header value'), 'tok-1');
    await user.click(within(exp).getByLabelText('Send telemetry to this destination'));
    await user.click(within(exp).getByRole('button', { name: 'Save' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/password/i), 'pw');
    await user.click(within(dialog).getByRole('button', { name: /continue|confirm/i }));
    await waitFor(() =>
      expect(api.calls.some((c) => c.method === 'PUT' && c.path === '/obs/export')).toBe(true),
    );
    const put = api.calls.find((c) => c.method === 'PUT' && c.path === '/obs/export');
    expect(put?.body).toEqual({
      password: 'pw',
      enabled: true,
      destination: DEST,
      credential: 'tok-1',
    });
  });

  it('a stored credential is never shown, and is kept unless replaced or removed', async () => {
    mockApi({
      'GET /obs/settings': { collect: true },
      'GET /obs/export': {
        ...ON,
        admin: { ...ADMIN_OFF.admin, destination: DEST, hasCredential: true },
      },
    });
    renderWithProviders(<TelemetrySettings isAdmin />);
    const exp = await screen.findByRole('region', { name: 'Export' });
    const value = await within(exp).findByLabelText('Header value');
    expect(value).toHaveValue('');
    expect(value).toHaveAttribute('placeholder', expect.stringMatching(/stored/i));
    expect(within(exp).getByLabelText('Remove the stored credential')).toBeInTheDocument();
  });

  it('says why a destination was refused, in words', async () => {
    mockApi({
      'GET /obs/settings': { collect: true },
      'GET /obs/export': { ...ADMIN_OFF, admin: { ...ADMIN_OFF.admin, destination: DEST } },
      'PUT /obs/export': () => ({
        status: 422,
        body: { error: { code: 'destination_refused', reason: 'private_not_allowed' } },
      }),
    });
    renderWithProviders(<TelemetrySettings isAdmin />);
    const user = userEvent.setup();
    const exp = await screen.findByRole('region', { name: 'Export' });
    await user.click(await within(exp).findByRole('button', { name: 'Save' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/password/i), 'pw');
    await user.click(within(dialog).getByRole('button', { name: /continue|confirm/i }));
    expect(await screen.findByText(/OPPORTUN_TELEMETRY_ALLOW_PRIVATE=1/)).toBeInTheDocument();
  });

  it('Send a test reports its outcome in words', async () => {
    mockApi({
      'GET /obs/settings': { collect: true },
      'GET /obs/export': { ...ADMIN_OFF, admin: { ...ADMIN_OFF.admin, destination: DEST } },
      'POST /obs/export/test': { outcome: 'timeout' },
    });
    renderWithProviders(<TelemetrySettings isAdmin />);
    const user = userEvent.setup();
    const exp = await screen.findByRole('region', { name: 'Export' });
    await user.click(await within(exp).findByRole('button', { name: 'Send a test' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/password/i), 'pw');
    await user.click(within(dialog).getByRole('button', { name: /continue|confirm/i }));
    expect(await screen.findByText(/did not answer within 10 seconds/)).toBeInTheDocument();
  });

  it('shows the last outcome and the drop counts', async () => {
    mockApi({
      'GET /obs/settings': { collect: true },
      'GET /obs/export': {
        ...ON,
        admin: {
          ...ADMIN_OFF.admin,
          destination: DEST,
          lastSuccessAt: Date.now() - 60_000,
          lastFailure: { outcome: 'http_5xx', at: Date.now() - 120_000 },
          dropped: [{ signal: 'spans', reason: 'buffer_full', count: 7 }],
        },
      },
    });
    renderWithProviders(<TelemetrySettings isAdmin />);
    const exp = await screen.findByRole('region', { name: 'Export' });
    expect(await within(exp).findByText(/Last failure/)).toBeInTheDocument();
    expect(exp).toHaveTextContent(/the destination had an error/i);
    const drops = within(exp).getByRole('table', { name: 'Dropped in the last 24 hours' });
    expect(drops).toHaveTextContent('spans');
    expect(drops).toHaveTextContent('7');
  });

  it('says export is blocked, and why, when a private destination meets a server without the flag (#382)', async () => {
    // Saved while OPPORTUN_TELEMETRY_ALLOW_PRIVATE=1 was set; the server now runs without it.
    mockApi({
      'GET /obs/settings': { collect: true },
      'GET /obs/export': {
        ...ON,
        admin: {
          ...ADMIN_OFF.admin,
          destination: DEST,
          allowPrivate: false,
          lastFailure: {
            outcome: 'blocked',
            reason: 'private_not_allowed',
            at: Date.now() - 30_000,
          },
        },
      },
    });
    renderWithProviders(<TelemetrySettings isAdmin />);
    const exp = await screen.findByRole('region', { name: 'Export' });
    const notice = await within(exp).findByRole('status', { name: /export is blocked/i });
    expect(notice).toHaveTextContent(/Export is blocked/);
    expect(notice).toHaveTextContent(/private network/);
    expect(notice).toHaveTextContent(/OPPORTUN_TELEMETRY_ALLOW_PRIVATE=1/);
    expect(notice).toHaveTextContent(/nothing is sent/i);
  });

  it('Send a test says why a destination is blocked (#382)', async () => {
    mockApi({
      'GET /obs/settings': { collect: true },
      'GET /obs/export': { ...ADMIN_OFF, admin: { ...ADMIN_OFF.admin, destination: DEST } },
      'POST /obs/export/test': { outcome: 'blocked', reason: 'private_not_allowed' },
    });
    renderWithProviders(<TelemetrySettings isAdmin />);
    const user = userEvent.setup();
    const exp = await screen.findByRole('region', { name: 'Export' });
    await user.click(await within(exp).findByRole('button', { name: 'Send a test' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/password/i), 'pw');
    await user.click(within(dialog).getByRole('button', { name: /continue|confirm/i }));
    expect(await screen.findByText(/OPPORTUN_TELEMETRY_ALLOW_PRIVATE=1/)).toBeInTheDocument();
  });

  it('export can be turned on only while collection is on', async () => {
    mockApi({ 'GET /obs/settings': { collect: false }, 'GET /obs/export': ADMIN_OFF });
    renderWithProviders(<TelemetrySettings isAdmin />);
    const exp = await screen.findByRole('region', { name: 'Export' });
    expect(await within(exp).findByLabelText('Send telemetry to this destination')).toBeDisabled();
    expect(exp).toHaveTextContent(/Turn collection on first/);
  });
});

describe('TelemetrySettings, on the demo deployment (#364)', () => {
  it('says both are not available there, to an admin too, and offers no controls', async () => {
    mockApi({
      'GET /obs/settings': { collect: false },
      'GET /obs/export': {
        ...ADMIN_OFF,
        available: false,
      },
    });
    renderWithProviders(<TelemetrySettings isAdmin />);
    const collect = await screen.findByRole('region', { name: 'Collection' });
    expect(await within(collect).findByRole('status')).toHaveTextContent(
      'Collection is not available on this deployment.',
    );
    const exp = screen.getByRole('region', { name: 'Export' });
    expect(await within(exp).findByRole('status')).toHaveTextContent(
      'Export is not available on this deployment.',
    );
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByLabelText('Host')).toBeNull();
  });
});
