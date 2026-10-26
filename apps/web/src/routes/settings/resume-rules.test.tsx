import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { ResumeRule } from '@opportun/core';
import { mockApi, renderWithProviders } from '@/test/render';
import { ResumeRulesSettings } from './resume-rules';

const RULE: ResumeRule = {
  id: 'r1',
  userId: 'u1',
  ruleText: 'Never mention the layoff.',
  category: 'redaction',
  active: true,
  sortOrder: 1,
  createdAt: 0,
  updatedAt: 0,
};

describe('ResumeRulesSettings delete (issue #74)', () => {
  it('deletes only after confirmation, and closes the dialog once the server has actually removed it', async () => {
    const user = userEvent.setup();
    let items = [RULE];
    mockApi({
      'GET /resume-rules': () => ({ items, total: items.length }),
      'DELETE /resume-rules/r1': () => {
        items = [];
        return { status: 204 };
      },
    });
    renderWithProviders(<ResumeRulesSettings />);

    await user.click(await screen.findByRole('button', { name: 'Delete rule 1' }));
    const confirm = await screen.findByRole('dialog', { name: 'Delete this rule?' });
    await user.click(within(confirm).getByRole('button', { name: 'Delete' }));

    await screen.findByText('No rules yet.');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('keeps the dialog open and shows the error when the delete fails, instead of closing as if it had succeeded', async () => {
    const user = userEvent.setup();
    mockApi({
      'GET /resume-rules': { items: [RULE], total: 1 },
      'DELETE /resume-rules/r1': () => ({ status: 500, body: { error: { code: 'server_error' } } }),
    });
    renderWithProviders(<ResumeRulesSettings />);

    await user.click(await screen.findByRole('button', { name: 'Delete rule 1' }));
    const confirm = await screen.findByRole('dialog', { name: 'Delete this rule?' });
    await user.click(within(confirm).getByRole('button', { name: 'Delete' }));

    // The inline alert ConfirmDialog itself now renders on a rejection (#84), not just the toast.
    expect(await within(confirm).findByRole('alert')).toHaveTextContent(/server_error/);
    expect(await screen.findByText('Rule not deleted')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Delete this rule?' })).toBeInTheDocument();
    expect(screen.getByText('Never mention the layoff.')).toBeInTheDocument();
  });
});
