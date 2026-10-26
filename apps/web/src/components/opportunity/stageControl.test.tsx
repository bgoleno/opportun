import type { OpportunityStage } from '@opportun/core';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { useStageFlow } from '@/components/stage/useStageFlow';
import type { OpportunityView } from '@/lib/opportunities';
import { mockApi, renderWithProviders, type ApiCall } from '@/test/render';
import { StageControl } from './StageControl';

function fixture(stage: OpportunityStage): OpportunityView {
  return {
    id: 'opp-1',
    userId: 'u1',
    companyId: 'c1',
    companyName: 'Acme',
    title: 'Staff PM',
    stage,
    sourceKind: 'manual',
    priority: 2,
    createdAt: 1,
    updatedAt: 1,
  } as OpportunityView;
}

function Harness({ opp }: { opp: OpportunityView }) {
  const flow = useStageFlow();
  return (
    <>
      <StageControl opp={opp} flow={flow} />
      {flow.dialogs}
    </>
  );
}

function setup(stage: OpportunityStage) {
  const api = mockApi({
    'POST /opportunities/opp-1/stage': (call: ApiCall) => ({
      ...fixture(stage),
      stage: (call.body as { to: OpportunityStage }).to,
    }),
  });
  const user = userEvent.setup();
  renderWithProviders(<Harness opp={fixture(stage)} />);
  return { api, user };
}

const items = (menu: HTMLElement) =>
  within(menu)
    .getAllByRole('menuitem')
    .map((m) => m.textContent);

describe('StageControl', () => {
  it('offers exactly the valid targets for an opportunity in applied', async () => {
    const { user } = setup('applied');
    await user.click(await screen.findByRole('button', { name: 'Stage: Applied' }));
    expect(items(await screen.findByRole('menu'))).toEqual([
      'Preparing',
      'In process',
      'Offer',
      'Dismissed',
      'Closed',
    ]);
    expect(screen.queryByRole('button', { name: /Reopen/ })).toBeNull();
  });

  it('sends a plain move for a chain target', async () => {
    const { api, user } = setup('applied');
    await user.click(await screen.findByRole('button', { name: 'Stage: Applied' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Offer' }));
    await waitFor(() => expect(api.calls).toHaveLength(1));
    expect(api.calls[0]?.body).toEqual({ to: 'offer' });
  });

  it('opens the closed sub-dialog and sends the reason', async () => {
    const { api, user } = setup('applied');
    await user.click(await screen.findByRole('button', { name: 'Stage: Applied' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Closed' }));
    const dialog = await screen.findByRole('dialog', { name: 'Close opportunity' });
    expect(api.calls).toHaveLength(0);
    await user.selectOptions(within(dialog).getByLabelText('Reason'), 'ghosted');
    await user.type(within(dialog).getByLabelText('Note (optional)'), 'No reply in 6 weeks');
    await user.click(within(dialog).getByRole('button', { name: 'Close opportunity' }));
    await waitFor(() => expect(api.calls).toHaveLength(1));
    expect(api.calls[0]?.body).toEqual({
      to: 'closed',
      closedReason: 'ghosted',
      note: 'No reply in 6 weeks',
    });
  });

  it('opens the dismiss sub-dialog with the dismiss reasons', async () => {
    const { user } = setup('applied');
    await user.click(await screen.findByRole('button', { name: 'Stage: Applied' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Dismissed' }));
    const dialog = await screen.findByRole('dialog', { name: 'Dismiss opportunity' });
    const options = within(within(dialog).getByLabelText('Reason'))
      .getAllByRole('option')
      .map((o) => o.getAttribute('value'))
      .filter(Boolean);
    expect(options).toEqual([
      'seniority',
      'compensation',
      'location',
      'industry',
      'role_fit',
      'company',
      'stale',
      'not_interested',
      'duplicate',
      'other',
    ]);
  });

  it('keeps reopen out of the stage menu and behind a separate Reopen action', async () => {
    const { api, user } = setup('closed');
    await user.click(await screen.findByRole('button', { name: 'Stage: Closed' }));
    expect(items(await screen.findByRole('menu'))).toEqual(['Dismissed']);
    await user.keyboard('{Escape}');

    await user.click(screen.getByRole('button', { name: 'Reopen' }));
    const menu = await screen.findByRole('menu');
    expect(items(menu)).toEqual([
      'New',
      'Interested',
      'Preparing',
      'Applied',
      'In process',
      'Offer',
    ]);
    await user.click(within(menu).getByRole('menuitem', { name: 'In process' }));
    await waitFor(() => expect(api.calls).toHaveLength(1));
    expect(api.calls[0]?.body).toEqual({ to: 'in_process', reopen: true });
  });
});
