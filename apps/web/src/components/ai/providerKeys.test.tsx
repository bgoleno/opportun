import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockApi, renderWithProviders } from '@/test/render';
import type { AiKey, KeyValidation } from './api';
import { aiReason } from '../resume/api';
import { ProviderKeysCard } from './ProviderKeysCard';

const NOW = Date.UTC(2026, 9, 16, 12);
const DAY = 24 * 60 * 60 * 1000;

const valid: KeyValidation = {
  ok: true,
  provider: 'anthropic',
  models: [
    { model: 'claude-sonnet-5-5', ok: true, error: null },
    { model: 'claude-opus-5-5', ok: false, error: 'model: not_found <b>x</b>' },
  ],
  expiresAt: null,
  checkedAt: NOW - DAY,
  error: null,
};

const THREE = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];
const allOk: KeyValidation = {
  ...valid,
  models: THREE.map((model) => ({ model, ok: true, error: null })),
};
// The org-scoped Anthropic key: it authenticates, every model call fails on workspace scope.
const badScope: KeyValidation = {
  ...valid,
  models: THREE.map((model) => ({
    model,
    ok: false,
    error: 'workspace scoping: HTTP 400: This API key is not scoped to a workspace.',
  })),
};

function key(id: string, over: Partial<AiKey> = {}): AiKey {
  return {
    id,
    label: 'anthropic',
    displayName: null,
    expiresAt: null,
    createdAt: NOW - 10 * DAY,
    validation: null,
    ...over,
  };
}

const row = (id: string) => screen.findByTestId(`key-row-${id}`);

describe('ProviderKeysCard', () => {
  it('renders the chip states, expiry text and per-model results as text', async () => {
    mockApi({
      'GET /ai/keys': {
        items: [
          key('allok', { validation: allOk }),
          key('scope', { validation: badScope }),
          key('valid', { validation: valid, displayName: 'prod', expiresAt: NOW + 60 * DAY }),
          key('invalid', {
            label: 'openai',
            validation: { ...valid, ok: false, models: [], error: 'HTTP 401: bad key' },
          }),
          key('unchecked'),
        ],
      },
    });
    renderWithProviders(<ProviderKeysCard now={NOW} />);

    const ok = within(await row('allok'));
    expect(ok.getByText('Valid')).toBeInTheDocument();
    expect(ok.getByText('Models (3/3 confirmed)')).toBeInTheDocument();

    // Authenticates but 0/3 models work, all on workspace scope: yellow, never green.
    const sc = within(await row('scope'));
    const scopeChip = sc.getByText('Bad scope');
    expect(scopeChip.className).toContain('bg-warning');
    expect(sc.queryByText('Valid')).not.toBeInTheDocument();
    expect(sc.getByText(/^Checked /)).toBeInTheDocument();
    expect(sc.getByText('Models (0/3 confirmed)')).toBeInTheDocument();

    // Mixed: one model ok, one failing with a non-workspace error.
    const v = within(await row('valid'));
    expect(v.getByText('Model errors').className).toContain('bg-warning');
    expect(v.queryByText('Valid')).not.toBeInTheDocument();
    expect(v.getByText(/^Checked /)).toBeInTheDocument();
    expect(v.getByText('prod')).toBeInTheDocument();
    expect(v.getByText('in 60 days')).toBeInTheDocument();
    expect(v.getByText('Models (1/2 confirmed)')).toBeInTheDocument();
    // Provider text is a text node, never markup.
    expect(v.getByText('model: not_found <b>x</b>')).toBeInTheDocument();

    const i = within(await row('invalid'));
    expect(i.getByText('Invalid')).toBeInTheDocument();
    expect(i.getByText('HTTP 401: bad key')).toBeInTheDocument();

    const u = within(await row('unchecked'));
    expect(u.getByText('Not checked')).toBeInTheDocument();
    expect(u.getByText('Not provided')).toBeInTheDocument();
  });

  it('warns within 14 days of expiry and flags a past expiry', async () => {
    mockApi({
      'GET /ai/keys': {
        items: [
          key('soon', { validation: allOk, expiresAt: NOW + 5 * DAY }),
          key('past', { validation: allOk, expiresAt: NOW - 3 * DAY }),
          key('both', { validation: badScope, expiresAt: NOW + 5 * DAY }),
        ],
      },
    });
    renderWithProviders(<ProviderKeysCard now={NOW} />);
    const soon = within(await row('soon'));
    expect(soon.getByText('Valid, expires in 5 days')).toBeInTheDocument();
    const past = within(await row('past'));
    const expired = past.getByText('Expired 3 days ago');
    expect(expired.className).toContain('text-destructive');
    // Degraded and near expiry: the model label wins, the Expires column still shows.
    const both = within(await row('both'));
    expect(both.getByText('Bad scope')).toBeInTheDocument();
    expect(both.queryByText(/expires in/)).not.toBeInTheDocument();
    expect(both.getByText('in 5 days')).toBeInTheDocument();
  });

  it('the Validate button calls the endpoint and shows the result', async () => {
    const user = userEvent.setup();
    let current: KeyValidation | null = null;
    const { calls } = mockApi({
      'GET /ai/keys': () => ({ items: [key('k1', { validation: current })] }),
      'POST /ai/keys/k1/validate': () => {
        current = { ...valid, ok: false, models: [], error: 'HTTP 401: rejected' };
        return current;
      },
    });
    renderWithProviders(<ProviderKeysCard now={NOW} />);
    await user.click(await screen.findByRole('button', { name: 'Validate Anthropic key' }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.path === '/ai/keys/k1/validate')).toBe(
        true,
      ),
    );
    expect(await screen.findByText('Anthropic key failed validation')).toBeInTheDocument();
    expect(within(await row('k1')).getByText('Invalid')).toBeInTheDocument();
  });

  it('Validate on an existing row updates the chip and checked time from a 3/3 result', async () => {
    const user = userEvent.setup();
    const CHECKED = NOW - 2 * 60 * 60 * 1000;
    const all: KeyValidation = {
      ...valid,
      checkedAt: CHECKED,
      models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'].map((model) => ({
        model,
        ok: true,
        error: null,
      })),
    };
    let current: KeyValidation = {
      ...valid,
      ok: false,
      models: [],
      error: 'HTTP 401: old failure',
    };
    const { calls } = mockApi({
      'GET /ai/keys': () => ({ items: [key('k2', { validation: current })] }),
      'POST /ai/keys/k2/validate': () => {
        current = all;
        return current;
      },
    });
    renderWithProviders(<ProviderKeysCard now={NOW} />);
    expect(within(await row('k2')).getByText('Invalid')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Validate Anthropic key' }));
    expect(await screen.findByText('Anthropic key is valid')).toBeInTheDocument();
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.path)).toEqual([
      '/ai/keys/k2/validate',
    ]);
    await waitFor(() => expect(within(screen.getByTestId('key-row-k2')).getByText('Valid')));
    const r = within(screen.getByTestId('key-row-k2'));
    expect(r.queryByText('Invalid')).not.toBeInTheDocument();
    expect(r.queryByText('HTTP 401: old failure')).not.toBeInTheDocument();
    expect(r.getByText('Models (3/3 confirmed)')).toBeInTheDocument();
    const fmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    expect(r.getByText(`Checked ${fmt.format(CHECKED)}`)).toBeInTheDocument();
  });

  it('Validate on a previously valid row replaces it with the invalid result', async () => {
    const user = userEvent.setup();
    let current: KeyValidation = allOk;
    mockApi({
      'GET /ai/keys': () => ({ items: [key('k3', { validation: current })] }),
      'POST /ai/keys/k3/validate': () => {
        current = { ...valid, ok: false, models: [], error: 'HTTP 403: revoked', checkedAt: NOW };
        return current;
      },
    });
    renderWithProviders(<ProviderKeysCard now={NOW} />);
    const before = within(await row('k3'));
    expect(before.getByText('Valid')).toBeInTheDocument();
    expect(before.getByText(/^Checked /)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Validate Anthropic key' }));
    // Toasts from earlier tests can still be mounted, so assert on the row itself.
    await waitFor(() => expect(within(screen.getByTestId('key-row-k3')).getByText('Invalid')));
    const r = within(screen.getByTestId('key-row-k3'));
    expect(r.getByText('HTTP 403: revoked')).toBeInTheDocument();
    expect(r.queryByText('Valid')).not.toBeInTheDocument();
    expect(r.queryByText(/^Checked /)).not.toBeInTheDocument();
    expect(r.queryByText(/^Models \(/)).not.toBeInTheDocument();
  });

  it('delete confirms first: Cancel keeps the row, Remove key deletes it and its data', async () => {
    const user = userEvent.setup();
    let items: AiKey[] = [
      key('gone', { validation: valid, displayName: 'doomed' }),
      key('kept', { label: 'openai' }),
    ];
    const { calls } = mockApi({
      'GET /ai/keys': () => ({ items }),
      'DELETE /secrets/gone': () => {
        items = items.filter((k) => k.id !== 'gone');
        return { status: 204 };
      },
    });
    renderWithProviders(<ProviderKeysCard now={NOW} />);
    await row('gone');

    await user.click(screen.getByRole('button', { name: 'Remove key Anthropic' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Remove this key?')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByTestId('key-row-gone')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Remove key Anthropic' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove key' }),
    );
    await waitFor(() => expect(screen.queryByTestId('key-row-gone')).not.toBeInTheDocument());
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.path)).toEqual([
      '/secrets/gone',
    ]);
    expect(screen.getByTestId('key-row-kept')).toBeInTheDocument();
    // Nothing from the removed key's validation is left on screen.
    expect(screen.queryByText('doomed')).not.toBeInTheDocument();
    expect(screen.queryByText(/^Models \(/)).not.toBeInTheDocument();
    expect(screen.queryByText('model: not_found <b>x</b>')).not.toBeInTheDocument();
    expect(screen.queryByText(/^Checked /)).not.toBeInTheDocument();
  });

  it('an add whose auto-validation authenticates with 0/3 models reads Bad scope', async () => {
    const user = userEvent.setup();
    const items: AiKey[] = [];
    mockApi({
      'GET /ai/keys': () => ({ items }),
      'POST /secrets': () => {
        items.push(key('org', { validation: badScope }));
        return { status: 201, body: { ...items[0], validation: badScope } };
      },
    });
    renderWithProviders(<ProviderKeysCard now={NOW} />);
    await user.type(await screen.findByLabelText('API key'), 'sk-ant-org');
    await user.click(screen.getByRole('button', { name: 'Add key' }));
    expect(await screen.findByText('Key stored, but it has a bad scope')).toBeInTheDocument();
    const r = within(await row('org'));
    expect(r.getByText('Bad scope')).toBeInTheDocument();
    expect(r.queryByText('Valid')).not.toBeInTheDocument();
  });

  it('the add flow sends name and expiry and surfaces the auto-validation result', async () => {
    const user = userEvent.setup();
    const items: AiKey[] = [];
    const { calls } = mockApi({
      'GET /ai/keys': () => ({ items }),
      'POST /secrets': (call: { body: Record<string, unknown> }) => {
        const validation = {
          ...valid,
          ok: false,
          models: [],
          error: 'HTTP 401: invalid x-api-key',
        };
        items.push(
          key('new', {
            displayName: String(call.body.displayName),
            expiresAt: call.body.expiresAt as number,
            validation,
          }),
        );
        return { status: 201, body: { ...items[0], validation } };
      },
    });
    renderWithProviders(<ProviderKeysCard now={NOW} />);
    await user.type(await screen.findByLabelText('API key'), 'sk-ant-whatever');
    await user.type(screen.getByLabelText('Key name (optional)'), 'console name');
    await user.type(screen.getByLabelText('Expires (optional)'), '2026-12-31');
    await user.click(screen.getByRole('button', { name: 'Add key' }));

    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      kind: 'ai_api_key',
      label: 'anthropic',
      value: 'sk-ant-whatever',
      displayName: 'console name',
      expiresAt: Date.UTC(2026, 11, 31),
    });
    expect(await screen.findByText('Key stored, but it failed validation')).toBeInTheDocument();
    const r = within(await row('new'));
    expect(r.getByText('Invalid')).toBeInTheDocument();
    expect(r.getByText('console name')).toBeInTheDocument();
  });

  it('shows the workspace key note for Anthropic and not for OpenAI', async () => {
    const user = userEvent.setup();
    mockApi({ 'GET /ai/keys': { items: [] } });
    renderWithProviders(<ProviderKeysCard now={NOW} />);
    const note = /Organization-scoped keys authenticate but every model call fails/;
    expect(await screen.findByText(note)).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Provider'), 'openai');
    expect(screen.queryByText(note)).not.toBeInTheDocument();
  });
});

describe('aiReason', () => {
  it('appends the expired-key hint', () => {
    expect(aiReason('provider_error', 'the stored key expired on 2026-05-01')).toBe(
      'The AI provider failed. Your message is saved; try again. (the stored key expired on 2026-05-01)',
    );
  });
});
