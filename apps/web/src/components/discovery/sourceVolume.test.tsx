// Discovery > Sources: each board's posting volume and the ranking it implies (#209). Made-up.
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { mockApi, renderWithProviders } from '@/test/render';
import type { DiscoverySource } from './api';
import { SourceVolume } from './SourceVolume';

const NOW = Date.now();
const source = (id: string, org: string): DiscoverySource =>
  ({
    id,
    kind: 'ats_greenhouse',
    config: { org },
    enabled: true,
    scheduleCron: '0 7 * * *',
    roleTargetId: null,
    companyId: null,
    lastRunAt: NOW,
    status: 'ok',
    statusDetail: null,
    createdAt: NOW,
    updatedAt: NOW,
  }) as unknown as DiscoverySource;

const volume = (sourceId: string, over: Record<string, unknown>) => ({
  sourceId,
  kind: 'ats_greenhouse',
  openJobs: null,
  newPerDay: null,
  days: 0,
  rankCallsPerDay: null,
  costPerDayUsd: null,
  ...over,
});

function setup(sources: unknown[]) {
  mockApi({
    'GET /discovery/sources': {
      items: [source('s1', 'initech'), source('s2', 'globex'), source('s3', 'hooli')],
      total: 3,
    },
    'GET /discovery/cost-figures': { rank: [], sources },
  });
  renderWithProviders(<SourceVolume />);
}

describe('#209: posting volume and ranking cost for each board source', () => {
  it('a full 14 days: open jobs, new a day, ranking calls and their cost a day', async () => {
    setup([
      volume('s1', {
        openJobs: 120,
        newPerDay: 0.5,
        days: 14,
        rankCallsPerDay: 0.5,
        costPerDayUsd: 0.002,
      }),
    ]);
    const row = await screen.findByRole('listitem', { name: /initech/i });
    expect(within(row).getByText('120')).toBeVisible();
    expect(within(row).getAllByText('0.5')).toHaveLength(2);
    expect(within(row).getByText('$0.002')).toBeVisible();
    expect(row).not.toHaveTextContent(/days\)/);
  });

  it('under 14 days: the rate says over how many days', async () => {
    setup([volume('s2', { openJobs: 306, newPerDay: 1.5, days: 6, rankCallsPerDay: 1.5 })]);
    const row = await screen.findByRole('listitem', { name: /globex/i });
    expect(row).toHaveTextContent('1.5 (6 days)');
    // No ranking calls in 30 days: the cost cannot be said yet.
    expect(row).toHaveTextContent(/no cost data yet/i);
  });

  it('no rate yet, or no runs at all: "no data yet", never a zero', async () => {
    setup([volume('s1', { openJobs: 80 }), volume('s3', {})]);
    const first = await screen.findByRole('listitem', { name: /initech/i });
    expect(within(first).getByText('80')).toBeVisible();
    expect(within(first).getAllByText('no data yet')).toHaveLength(3);
    const none = screen.getByRole('listitem', { name: /hooli/i });
    expect(within(none).getAllByText('no data yet')).toHaveLength(4);
    expect(none).not.toHaveTextContent(/\b0\b/);
  });

  it('no board sources: says so', async () => {
    setup([]);
    expect(await screen.findByText(/no board sources yet/i)).toBeVisible();
  });
});
