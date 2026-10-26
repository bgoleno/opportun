import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockApi, renderWithProviders } from '@/test/render';
import { SourcesManager } from './SourcesManager';
import type { DiscoverySource } from './api';

const SOURCE: DiscoverySource = {
  id: 's1',
  kind: 'mcp',
  config: { tool: 'jobs', transport: 'stdio', command: 'mcp-jobs' },
  enabled: true,
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
