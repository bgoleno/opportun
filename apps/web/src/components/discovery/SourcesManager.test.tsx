import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockApi, renderWithProviders } from '@/test/render';
import { SourcesManager } from './SourcesManager';
import { discoveryKeys, type DiscoverySource } from './api';

const SOURCE: DiscoverySource = {
  id: 's1',
  kind: 'mcp',
  config: { tool: 'jobs', transport: 'stdio', command: 'mcp-jobs' },
  enabled: true,
  prefilterEnabled: true,
  scheduleCron: null,
  roleTargetId: null,
  companyId: null,
  lastRunAt: null,
  status: 'ok',
  statusDetail: null,
  createdAt: 0,
  updatedAt: 0,
};

const baseRoutes = {
  'GET /role-targets': { items: [], total: 0 },
};

describe('SourcesManager delete (issue #74)', () => {
  it('deletes only after confirmation, and closes the dialog once the server has actually removed it', async () => {
    const user = userEvent.setup();
    let items = [SOURCE];
    mockApi({
      ...baseRoutes,
      'GET /discovery/sources': () => ({ items, total: items.length }),
      'DELETE /discovery/sources/s1': () => {
        items = [];
        return { status: 204 };
      },
    });
    renderWithProviders(<SourcesManager />);

    await user.click(await screen.findByRole('button', { name: 'Delete MCP jobs via mcp-jobs' }));
    const confirm = await screen.findByRole('dialog', { name: 'Delete this source?' });
    await user.click(within(confirm).getByRole('button', { name: 'Delete' }));

    await screen.findByText(/No sources yet\./);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('keeps the dialog open and shows the error when the delete fails, instead of closing as if it had succeeded', async () => {
    const user = userEvent.setup();
    mockApi({
      ...baseRoutes,
      'GET /discovery/sources': { items: [SOURCE], total: 1 },
      'DELETE /discovery/sources/s1': () => ({
        status: 500,
        body: { error: { code: 'server_error' } },
      }),
    });
    renderWithProviders(<SourcesManager />);

    await user.click(await screen.findByRole('button', { name: 'Delete MCP jobs via mcp-jobs' }));
    const confirm = await screen.findByRole('dialog', { name: 'Delete this source?' });
    await user.click(within(confirm).getByRole('button', { name: 'Delete' }));

    // The inline alert ConfirmDialog itself now renders on a rejection (#84), not just the toast.
    expect(await within(confirm).findByRole('alert')).toHaveTextContent(/server_error/);
    expect(await screen.findByText('Source not removed')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Delete this source?' })).toBeInTheDocument();
    // Still there: the server never removed it.
    expect(screen.getByText('jobs via mcp-jobs')).toBeInTheDocument();
  });
});

describe('Rank these (#215)', () => {
  const BOARD: DiscoverySource = {
    ...SOURCE,
    id: 'b1',
    kind: 'ats_lever',
    config: { org: 'initech' },
  };
  const OTHER: DiscoverySource = {
    ...SOURCE,
    id: 'b2',
    kind: 'ats_ashby',
    config: { org: 'globex' },
  };
  const NAME = /Rank these: 175 postings from Lever initech/;

  const volume = (sourceId: string, belowCut: number, belowCutCostUsd: number | null) => ({
    sourceId,
    kind: 'ats_lever',
    openJobs: 200,
    newPerDay: null,
    days: 0,
    rankCallsPerDay: null,
    costPerDayUsd: null,
    belowCut,
    belowCutCostUsd,
  });
  const window30 = (avgCostUsd: number | null) => ({
    days: 30,
    calls: 25,
    errors: 0,
    inputTokens: null,
    outputTokens: null,
    avgCostUsd,
    totalCostUsd: 0,
  });

  function figures(belowCut: number, costUsd: number | null, avg: number | null = 0.01) {
    return {
      rank: [window30(avg)],
      sources: [volume('b1', belowCut, costUsd), volume('b2', 0, 0)],
    };
  }

  function setup(over: Record<string, unknown> = {}) {
    return mockApi({
      ...baseRoutes,
      'GET /discovery/sources': { items: [BOARD, OTHER], total: 2 },
      'GET /discovery/cost-figures': figures(175, 1.75),
      ...over,
    });
  }

  it('shows on the source that has postings below the cut, with their count, and on no other', async () => {
    setup();
    renderWithProviders(<SourcesManager />);
    expect(await screen.findByRole('button', { name: NAME })).toHaveTextContent('Rank these');
    expect(screen.getByText('175 not ranked: below the cut')).toBeVisible();
    expect(screen.getAllByRole('button', { name: /^Rank these/ })).toHaveLength(1);
  });

  it('shows nothing when no posting is below the cut', async () => {
    setup({ 'GET /discovery/cost-figures': figures(0, 0) });
    renderWithProviders(<SourcesManager />);
    await screen.findByRole('button', { name: 'Delete Lever initech' });
    expect(screen.queryByRole('button', { name: /^Rank these/ })).toBeNull();
    expect(screen.queryByText(/below the cut/)).toBeNull();
  });

  it('says one posting, not "1 postings"', async () => {
    setup({ 'GET /discovery/cost-figures': figures(1, 0.01) });
    renderWithProviders(<SourcesManager />);
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole('button', { name: /Rank these: 1 posting from Lever initech/ }),
    );
    expect(await screen.findByRole('dialog', { name: 'Rank 1 posting?' })).toBeVisible();
  });

  it('shows the count and the estimated cost before anything runs, and Cancel sends nothing', async () => {
    const user = userEvent.setup();
    const { calls } = setup();
    renderWithProviders(<SourcesManager />);
    await user.click(await screen.findByRole('button', { name: NAME }));

    const dialog = await screen.findByRole('dialog', { name: 'Rank 175 postings?' });
    expect(dialog).toHaveTextContent('Estimated cost: $1.75');
    expect(dialog).toHaveTextContent('$0.01 a call');
    expect(dialog).toHaveTextContent(/discovery budget/);
    expect(calls.some((c) => c.path.endsWith('/rank-below-cut'))).toBe(false);

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(calls.some((c) => c.path.endsWith('/rank-below-cut'))).toBe(false);
  });

  it('with no cost data it says the cost is not known, and never $0', async () => {
    const user = userEvent.setup();
    setup({ 'GET /discovery/cost-figures': figures(175, null, null) });
    renderWithProviders(<SourcesManager />);
    await user.click(await screen.findByRole('button', { name: NAME }));
    const dialog = await screen.findByRole('dialog', { name: 'Rank 175 postings?' });
    expect(dialog).toHaveTextContent(/Estimated cost: not known yet/);
    expect(dialog).not.toHaveTextContent('$');
  });

  it('sends the count it showed, then the button goes and it says how many were queued', async () => {
    const user = userEvent.setup();
    let current = figures(175, 1.75);
    const { calls } = setup({
      'GET /discovery/cost-figures': () => current,
      'POST /discovery/sources/b1/rank-below-cut': () => {
        current = figures(0, 0);
        return { status: 202, body: { queued: 175 } };
      },
    });
    renderWithProviders(<SourcesManager />);
    await user.click(await screen.findByRole('button', { name: NAME }));
    const dialog = await screen.findByRole('dialog', { name: 'Rank 175 postings?' });
    const confirm = within(dialog).getByRole('button', { name: 'Rank 175 postings' });
    // Spending within a budget the user set is not a destructive act, so it does not look like one.
    expect(confirm.className).not.toMatch(/destructive/);
    await user.click(confirm);

    expect(await screen.findByText('175 postings queued for ranking')).toBeInTheDocument();
    expect(calls.find((c) => c.path.endsWith('/rank-below-cut'))?.body).toEqual({ count: 175 });
    await waitFor(() => expect(screen.queryByRole('button', { name: NAME })).toBeNull());
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('sends the queue to be read again, so its cards stop saying "below the cut"', async () => {
    const user = userEvent.setup();
    setup({
      'POST /discovery/sources/b1/rank-below-cut': () => ({
        status: 202,
        body: { queued: 175 },
      }),
    });
    const { queryClient } = renderWithProviders(<SourcesManager />);
    queryClient.setQueryData(discoveryKeys.queue, { items: [], total: 0 });
    await user.click(await screen.findByRole('button', { name: NAME }));
    const dialog = await screen.findByRole('dialog', { name: 'Rank 175 postings?' });
    await user.click(within(dialog).getByRole('button', { name: 'Rank 175 postings' }));
    await screen.findByText('175 postings queued for ranking');
    expect(queryClient.getQueryState(discoveryKeys.queue)?.isInvalidated).toBe(true);
  });

  it('a failure stays in the dialog, and the count stands', async () => {
    const user = userEvent.setup();
    setup({
      'POST /discovery/sources/b1/rank-below-cut': () => ({
        status: 500,
        body: { error: { code: 'server_error' } },
      }),
    });
    renderWithProviders(<SourcesManager />);
    await user.click(await screen.findByRole('button', { name: NAME }));
    const dialog = await screen.findByRole('dialog', { name: 'Rank 175 postings?' });
    await user.click(within(dialog).getByRole('button', { name: 'Rank 175 postings' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/server_error/);
    expect(screen.getByRole('button', { name: NAME })).toBeInTheDocument();
  });

  it('when the figures cannot load, the sources still list', async () => {
    setup({
      'GET /discovery/cost-figures': () => ({
        status: 500,
        body: { error: { code: 'server_error' } },
      }),
    });
    renderWithProviders(<SourcesManager />);
    expect(await screen.findByRole('button', { name: 'Delete Lever initech' })).toBeVisible();
    expect(screen.queryByRole('button', { name: /^Rank these/ })).toBeNull();
  });
});
