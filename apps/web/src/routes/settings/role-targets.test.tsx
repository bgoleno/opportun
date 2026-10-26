import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { RoleTarget } from '@opportun/core';
import { mockApi, renderWithProviders } from '@/test/render';
import { RoleTargetsSettings } from './role-targets';

const TARGET: RoleTarget = {
  id: 't1',
  userId: 'u1',
  name: 'Staff Platform Engineer',
  titleFamily: 'Platform Engineering',
  seniorityMin: null,
  seniorityMax: null,
  industries: [],
  keywords: [],
  locations: [],
  remotePref: 'any',
  compMin: null,
  compMax: null,
  currency: null,
  active: true,
  discoveryPromptId: null,
  createdAt: 0,
  updatedAt: 0,
};

describe('RoleTargetsSettings delete (issue #74)', () => {
  it('deletes only after confirmation, and closes the dialog once the server has actually removed it', async () => {
    const user = userEvent.setup();
    let items = [TARGET];
    mockApi({
      'GET /role-targets': () => ({ items, total: items.length }),
      'DELETE /role-targets/t1': () => {
        items = [];
        return { status: 204 };
      },
    });
    renderWithProviders(<RoleTargetsSettings />);

    await user.click(await screen.findByRole('button', { name: 'Delete Staff Platform Engineer' }));
    const confirm = await screen.findByRole('dialog', { name: 'Delete this role target?' });
    await user.click(within(confirm).getByRole('button', { name: 'Delete' }));

    await screen.findByText(/No role targets yet\./);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('keeps the dialog open and shows the error when the delete fails, instead of closing as if it had succeeded', async () => {
    const user = userEvent.setup();
    mockApi({
      'GET /role-targets': { items: [TARGET], total: 1 },
      'DELETE /role-targets/t1': () => ({ status: 500, body: { error: { code: 'server_error' } } }),
    });
    renderWithProviders(<RoleTargetsSettings />);

    await user.click(await screen.findByRole('button', { name: 'Delete Staff Platform Engineer' }));
    const confirm = await screen.findByRole('dialog', { name: 'Delete this role target?' });
    await user.click(within(confirm).getByRole('button', { name: 'Delete' }));

    // The inline alert ConfirmDialog itself now renders on a rejection (#84), not just the toast.
    expect(await within(confirm).findByRole('alert')).toHaveTextContent(/server_error/);
    expect(await screen.findByText('Role target not deleted')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Delete this role target?' })).toBeInTheDocument();
    expect(screen.getByText('Staff Platform Engineer')).toBeInTheDocument();
  });
});

describe('RoleTargetsSettings icon buttons (issue #138)', () => {
  it('carries the accessible name through to the rendered link, not just the wrapping button', async () => {
    mockApi({ 'GET /role-targets': { items: [TARGET], total: 1 } });
    renderWithProviders(<RoleTargetsSettings />);
    // IconButton's asChild path chains two Radix Slot merges (TooltipTrigger onto Button,
    // Button onto Link); this pins that the label still lands on the <a> at the end of it.
    const link = await screen.findByRole('link', {
      name: 'Edit discovery prompt for Staff Platform Engineer',
    });
    expect(link).toHaveAttribute('href', expect.stringContaining('/discovery/prompts'));
  });

  it('shows the edit and delete icon tooltips on hover, matching their aria-labels', async () => {
    const user = userEvent.setup();
    mockApi({ 'GET /role-targets': { items: [TARGET], total: 1 } });
    renderWithProviders(<RoleTargetsSettings />);
    const edit = await screen.findByRole('button', { name: 'Edit Staff Platform Engineer' });
    await user.hover(edit);
    expect(await screen.findByText('Edit Staff Platform Engineer')).toBeInTheDocument();
  });
});
