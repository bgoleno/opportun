import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { mockApi, renderWithProviders } from '@/test/render';
import { UsageTable } from './UsageTable';

const row = (taskKey: string, estimated: boolean, estCostUsd: number) => ({
  day: '2026-10-15',
  taskKey,
  runs: 1,
  errors: 0,
  inputTokens: 1000,
  outputTokens: 100,
  estCostUsd,
  estimated,
});

describe('UsageTable', () => {
  it('marks fallback-priced costs as estimated, including the total', async () => {
    mockApi({
      'GET /ai/usage': {
        days: 30,
        items: [row('comms.classify', false, 0.0002), row('capture.extract', true, 0.048)],
        totals: [
          { ...row('capture.extract', true, 0.048), day: undefined },
          { ...row('comms.classify', false, 0.0002), day: undefined },
        ],
      },
    });
    renderWithProviders(<UsageTable />);
    const table = await screen.findByRole('table', { name: 'AI usage by day and task' });
    const priced = within(table).getByRole('row', { name: /comms\.classify/ });
    const fallback = within(table).getByRole('row', { name: /capture\.extract/ });
    const total = within(table).getByRole('row', { name: /Total/ });
    expect(within(priced).queryByText('(estimated)')).not.toBeInTheDocument();
    expect(within(fallback).getByText('(estimated)')).toBeInTheDocument();
    expect(within(total).getByText('(estimated)')).toBeInTheDocument();
  });
});
