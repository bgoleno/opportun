import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockApi, renderWithProviders } from '@/test/render';
import type { ModelPolicy, PoliciesResponse } from './api';
import { PolicyEditor } from './PolicyEditor';

const DEFAULT: ModelPolicy = {
  provider: 'anthropic',
  model: 'claude-haiku-5-5',
  maxOutputTokens: 1000,
};

function setup() {
  const data: PoliciesResponse = {
    items: [
      {
        taskKey: 'comms.classify',
        description: 'Classify a message',
        defaultPolicy: DEFAULT,
        override: null,
      },
    ],
    budget: { perTaskDailyUsd: 5 },
  };
  const api = mockApi({
    'GET /ai/policies': () => data,
    'PUT /ai/policies/comms.classify': (call: { body: unknown }) => ({
      ...data.items[0],
      override: call.body,
    }),
  });
  renderWithProviders(<PolicyEditor />);
  return api;
}

describe('PolicyEditor price overrides', () => {
  it('sends a price that is set and omits a blank one', async () => {
    const user = userEvent.setup();
    const { calls } = setup();
    await user.click(await screen.findByRole('button', { name: 'Edit model for comms.classify' }));
    await user.type(screen.getByLabelText(/input price/i), '0.5');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    const put = calls.find((c) => c.method === 'PUT');
    expect(put?.body).toEqual({ ...DEFAULT, inputUsdPerMTok: 0.5 });
  });

  it('rejects a negative price without saving', async () => {
    const user = userEvent.setup();
    const { calls } = setup();
    await user.click(await screen.findByRole('button', { name: 'Edit model for comms.classify' }));
    await user.type(screen.getByLabelText(/output price/i), '-1');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/leave blank, or enter 0 to 10000/i)).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });
});
