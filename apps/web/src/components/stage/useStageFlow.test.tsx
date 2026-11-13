// #432: a move that waits on the reason dialog reports its outcome once it is known, through the
// real StageReasonDialog: true when the server confirms the move, false when the dialog is
// cancelled, and nothing while a server error leaves the dialog open for another answer.
import type { OpportunityStage } from '@opportun/core';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { OpportunityView } from '@/lib/opportunities';
import { mockApi, renderWithProviders, type ApiCall } from '@/test/render';
import { useStageFlow, type StageSubject } from './useStageFlow';

const OPP: StageSubject = {
  id: 'opp-1',
  stage: 'applied',
  title: 'Staff PM',
  companyName: 'Acme',
};

function Harness(props: { to: OpportunityStage; onOutcome: (moved: boolean) => void }) {
  const flow = useStageFlow();
  return (
    <>
      <button type="button" onClick={() => flow.request(OPP, props.to, props.onOutcome)}>
        Move it
      </button>
      {flow.dialogs}
    </>
  );
}

/** A stage endpoint whose answer the test gives when it chooses. */
function deferredStage() {
  let answer: (v: unknown) => void = () => undefined;
  const handler = (call: ApiCall) =>
    new Promise((resolve) => {
      answer = () =>
        resolve({
          ...OPP,
          stage: (call.body as { to: OpportunityStage }).to,
          createdAt: 1,
          updatedAt: 1,
        } as unknown as OpportunityView);
    });
  return { handler, answer: () => answer(undefined) };
}

function setup(to: OpportunityStage, stage: (call: ApiCall) => unknown) {
  const api = mockApi({
    'GET /opportunities': { items: [], total: 0 },
    'POST /opportunities/opp-1/stage': stage,
  });
  const onOutcome = vi.fn();
  const user = userEvent.setup();
  renderWithProviders(<Harness to={to} onOutcome={onOutcome} />);
  return { api, user, onOutcome };
}

const stageCalls = (calls: ApiCall[]) =>
  calls.filter((c) => c.method === 'POST' && c.path.endsWith('/stage'));

describe('useStageFlow: the outcome of a move that waits for a reason (#432)', () => {
  it('reports moved once, when the server confirms, and not before', async () => {
    const server = deferredStage();
    const { api, user, onOutcome } = setup('closed', server.handler);
    await user.click(await screen.findByRole('button', { name: 'Move it' }));
    const dialog = await screen.findByRole('dialog', { name: 'Close opportunity' });
    await user.selectOptions(within(dialog).getByLabelText('Reason'), 'rejected');
    await user.click(within(dialog).getByRole('button', { name: 'Close opportunity' }));
    await waitFor(() => expect(stageCalls(api.calls)).toHaveLength(1));
    // The request is out, but the move has not happened yet.
    expect(onOutcome).not.toHaveBeenCalled();

    await act(async () => server.answer());
    await waitFor(() => expect(onOutcome).toHaveBeenCalledTimes(1));
    expect(onOutcome).toHaveBeenCalledWith(true);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(onOutcome).toHaveBeenCalledTimes(1);
  });

  it('reports not moved when the dialog is cancelled, and sends nothing', async () => {
    const { api, user, onOutcome } = setup('dismissed', () => ({}));
    await user.click(await screen.findByRole('button', { name: 'Move it' }));
    const dialog = await screen.findByRole('dialog', { name: 'Dismiss opportunity' });
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(onOutcome).toHaveBeenCalledTimes(1);
    expect(onOutcome).toHaveBeenCalledWith(false);
    expect(stageCalls(api.calls)).toHaveLength(0);
  });

  it('reports nothing on a server error and leaves the dialog open; cancel then says not moved', async () => {
    const { api, user, onOutcome } = setup('closed', () => ({
      status: 500,
      body: { error: { code: 'internal', message: 'Something went wrong' } },
    }));
    await user.click(await screen.findByRole('button', { name: 'Move it' }));
    const dialog = await screen.findByRole('dialog', { name: 'Close opportunity' });
    await user.selectOptions(within(dialog).getByLabelText('Reason'), 'rejected');
    await user.click(within(dialog).getByRole('button', { name: 'Close opportunity' }));
    await waitFor(() => expect(stageCalls(api.calls)).toHaveLength(1));
    expect(await screen.findByText('Stage not changed')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Close opportunity' })).toBeInTheDocument();
    expect(onOutcome).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(onOutcome).toHaveBeenCalledTimes(1);
    expect(onOutcome).toHaveBeenCalledWith(false);
  });

  it('does not report on a move that needs no reason', async () => {
    const { api, user, onOutcome } = setup('interested', (call: ApiCall) => ({
      ...OPP,
      stage: (call.body as { to: OpportunityStage }).to,
    }));
    await user.click(await screen.findByRole('button', { name: 'Move it' }));
    await waitFor(() => expect(stageCalls(api.calls)).toHaveLength(1));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onOutcome).not.toHaveBeenCalled();
  });
});
