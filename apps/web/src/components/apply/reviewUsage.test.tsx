// The daily review usage and the user's own cap (https://github.com/bgoleno/opportun/issues/130),
// against a stubbed API: the numbers come from GET /settings/applications, never from the
// client; where that route is 404 (flag off, demo) neither part renders.
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { formatDateTime } from '@/lib/opportunities';
import { mockApi, renderWithProviders, type ApiCall } from '@/test/render';
import type { ReviewUsage } from './api';
import { ReviewCapCard, ReviewUsageLine, usageText } from './ReviewUsage';

const NOW = Date.now();
const HOUR = 60 * 60 * 1000;

const usage = (over: Partial<ReviewUsage> = {}): ReviewUsage => ({
  used: 3,
  cap: 10,
  instanceCap: 10,
  userCap: null,
  nextFreeAt: NOW + 5 * HOUR,
  ...over,
});

const OFF = () => ({ status: 404, body: { error: { code: 'feature_unavailable' } } });

describe('usageText', () => {
  it('under the cap: the count, and when the next place frees up', () => {
    expect(usageText(usage())).toBe(
      `3 of 10 reviews used in the last 24 hours. The next place frees up at ${formatDateTime(NOW + 5 * HOUR)}.`,
    );
  });

  it('at the cap: when another can be confirmed', () => {
    expect(usageText(usage({ used: 10 }))).toBe(
      `10 of 10 reviews used in the last 24 hours. You can confirm another after ${formatDateTime(NOW + 5 * HOUR)}.`,
    );
  });

  it('nothing used: the count alone', () => {
    expect(usageText(usage({ used: 0, nextFreeAt: null }))).toBe(
      '0 of 10 reviews used in the last 24 hours.',
    );
  });
});

describe('the usage line on the review screen', () => {
  it('shows the server’s numbers', async () => {
    mockApi({ 'GET /settings/applications': usage({ used: 7, cap: 8 }) });
    renderWithProviders(<ReviewUsageLine />);
    expect(await screen.findByRole('status')).toHaveTextContent(
      '7 of 8 reviews used in the last 24 hours.',
    );
  });

  it('renders nothing where the feature is off', async () => {
    const api = mockApi({ 'GET /settings/applications': OFF });
    const { container } = renderWithProviders(<ReviewUsageLine />);
    await waitFor(() => expect(api.calls).toHaveLength(1));
    expect(container.textContent).toBe('');
  });
});

describe('the user’s own limit in Settings', () => {
  function setup(u: ReviewUsage, put?: (c: ApiCall) => unknown) {
    // A stateful stub: what a PUT sets, the next GET returns, as the server does.
    let current = u;
    const api = mockApi({
      'GET /settings/applications': () => current,
      'PUT /settings/applications':
        put ??
        ((c: ApiCall) => {
          const cap = (c.body as { dailyReviewCap: number | null }).dailyReviewCap;
          current = { ...current, userCap: cap, cap: cap ?? current.instanceCap };
          return current;
        }),
    });
    const user = userEvent.setup();
    renderWithProviders(<ReviewCapCard />);
    return { api, user };
  }

  const puts = (calls: ApiCall[]) =>
    calls.filter((c) => c.method === 'PUT' && c.path === '/settings/applications');

  it('shows the current limit, the server’s ceiling and the usage', async () => {
    setup(usage({ userCap: 4, cap: 4 }));
    const input = await screen.findByLabelText('Reviews allowed per 24 hours');
    expect(input).toHaveValue(4);
    expect(input).toHaveAttribute('max', '10');
    expect(input).toHaveAccessibleDescription(/up to the limit your server sets \(10\)/);
    expect(screen.getByText(/3 of 4 reviews used in the last 24 hours/)).toBeVisible();
  });

  it('lowers it: sends the number, and the server’s answer shows', async () => {
    const { api, user } = setup(usage());
    const input = await screen.findByLabelText('Reviews allowed per 24 hours');
    await user.clear(input);
    await user.type(input, '3');
    await user.click(screen.getByRole('button', { name: 'Save limit' }));
    await waitFor(() => expect(puts(api.calls)).toHaveLength(1));
    expect(puts(api.calls)[0]?.body).toEqual({ dailyReviewCap: 3 });
    expect(await screen.findByText(/3 of 3 reviews used/)).toBeVisible();
  });

  const ABOVE = 'This server allows at most 10 reviews per 24 hours. Choose 10 or fewer.';
  it.each([
    ['above the server’s limit', '11', ABOVE],
    ['zero', '0', 'Choose a whole number from 1 to 10.'],
    ['not a whole number', '2.5', 'Choose a whole number from 1 to 10.'],
  ])('refuses a value %s before sending anything', async (_n, typed, message) => {
    const { api, user } = setup(usage());
    const input = await screen.findByLabelText('Reviews allowed per 24 hours');
    await user.clear(input);
    await user.type(input, typed);
    await user.click(screen.getByRole('button', { name: 'Save limit' }));
    expect(await screen.findByText(message)).toBeVisible();
    expect(puts(api.calls)).toHaveLength(0);
  });

  it('"Use the server’s limit" clears the user’s own value', async () => {
    const { api, user } = setup(usage({ userCap: 4, cap: 4 }));
    await user.click(await screen.findByRole('button', { name: 'Use the server’s limit' }));
    await waitFor(() => expect(puts(api.calls)).toHaveLength(1));
    expect(puts(api.calls)[0]?.body).toEqual({ dailyReviewCap: null });
  });

  it('no own value: no "use the server’s limit" button', async () => {
    setup(usage());
    await screen.findByLabelText('Reviews allowed per 24 hours');
    expect(
      screen.queryByRole('button', { name: 'Use the server’s limit' }),
    ).not.toBeInTheDocument();
  });

  it('a refusal from the server is said in words', async () => {
    const { user } = setup(usage(), () => ({
      status: 422,
      body: { error: { code: 'cap_out_of_range', max: 10 } },
    }));
    await user.click(await screen.findByRole('button', { name: 'Save limit' }));
    expect(await screen.findByText(ABOVE)).toBeVisible();
  });

  it('renders nothing where the feature is off (no Settings control)', async () => {
    const api = mockApi({ 'GET /settings/applications': OFF });
    const { container } = renderWithProviders(<ReviewCapCard />);
    await waitFor(() => expect(api.calls).toHaveLength(1));
    expect(container.textContent).toBe('');
  });
});

describe('a saved limit above the server’s (#160)', () => {
  // An admin lowered the instance cap below what the user had saved: 15 saved, 10 applies.
  const above = usage({ userCap: 15, cap: 10, instanceCap: 10 });

  it('the input shows the limit in force, and a line says why', async () => {
    mockApi({ 'GET /settings/applications': above });
    renderWithProviders(<ReviewCapCard />);
    const input = await screen.findByLabelText('Reviews allowed per 24 hours');
    expect(input).toHaveValue(10);
    expect(
      screen.getByText('Your saved limit of 15 is above this server’s limit, so 10 applies.'),
    ).toBeVisible();
  });

  it('saving a value above the server’s limit is refused with that explanation', async () => {
    const api = mockApi({ 'GET /settings/applications': above });
    const user = userEvent.setup();
    renderWithProviders(<ReviewCapCard />);
    const input = await screen.findByLabelText('Reviews allowed per 24 hours');
    await user.clear(input);
    await user.type(input, '15');
    await user.click(screen.getByRole('button', { name: 'Save limit' }));
    expect(
      await screen.findByText(
        'This server allows at most 10 reviews per 24 hours. Choose 10 or fewer.',
      ),
    ).toBeVisible();
    expect(api.calls.filter((c) => c.method === 'PUT')).toHaveLength(0);
  });

  it('no line when the saved limit is within the server’s', async () => {
    mockApi({ 'GET /settings/applications': usage({ userCap: 4, cap: 4 }) });
    renderWithProviders(<ReviewCapCard />);
    await screen.findByLabelText('Reviews allowed per 24 hours');
    expect(screen.queryByText(/above this server’s limit/)).not.toBeInTheDocument();
  });
});
