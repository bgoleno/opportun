// #432: a move that waits on the reason dialog reports its outcome once it is known, through the
// real StageReasonDialog: true when the server confirms the move, false when the dialog is
// cancelled, and nothing while a server error leaves the dialog open for another answer.
import type { OpportunityStage } from '@opportun/core';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
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

    // #476: once the request has failed, Cancel is enabled again.
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeEnabled();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(onOutcome).toHaveBeenCalledTimes(1);
    expect(onOutcome).toHaveBeenCalledWith(false);
  });

  // #476 (qa on #474): a cancel while the confirm was out closed the dialog and said "not moved",
  // and the server then made the move anyway. Until the answer comes, nothing closes the dialog.
  async function confirmAndHold(server: ReturnType<typeof deferredStage>) {
    const ctx = setup('closed', server.handler);
    await ctx.user.click(await screen.findByRole('button', { name: 'Move it' }));
    const dialog = await screen.findByRole('dialog', { name: 'Close opportunity' });
    await ctx.user.selectOptions(within(dialog).getByLabelText('Reason'), 'rejected');
    await ctx.user.click(within(dialog).getByRole('button', { name: 'Close opportunity' }));
    await waitFor(() => expect(stageCalls(ctx.api.calls)).toHaveLength(1));
    return { ...ctx, dialog };
  }

  it('while the confirm is out, Cancel, the close button and a backdrop click leave the dialog open', async () => {
    const server = deferredStage();
    const { user, onOutcome, dialog } = await confirmAndHold(server);
    const cancel = within(dialog).getByRole('button', { name: 'Cancel' });
    expect(cancel).toBeDisabled();
    await user.click(cancel);
    // The corner close button is not offered while the request is out.
    expect(within(dialog).queryByRole('button', { name: 'Close' })).toBeNull();
    // A click on the dialog element itself is a backdrop click.
    fireEvent.click(dialog);
    expect(screen.getByRole('dialog', { name: 'Close opportunity' })).toBeInTheDocument();
    expect(onOutcome).not.toHaveBeenCalled();

    await act(async () => server.answer());
    await waitFor(() => expect(onOutcome).toHaveBeenCalledTimes(1));
    expect(onOutcome).toHaveBeenCalledWith(true);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(onOutcome).toHaveBeenCalledTimes(1);
  });

  it('while the confirm is out, Escape leaves the dialog open, even when the browser closes it', async () => {
    const server = deferredStage();
    const { onOutcome, dialog } = await confirmAndHold(server);
    // Escape on a modal <dialog> fires `cancel`, which the dialog now refuses...
    const escape = new Event('cancel', { cancelable: true });
    dialog.dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(true);
    // ...and a browser may close it anyway on a second Escape: then it is shown again.
    (dialog as HTMLDialogElement).removeAttribute('open');
    fireEvent(dialog, new Event('close'));
    expect(dialog).toHaveAttribute('open');
    expect(screen.getByRole('dialog', { name: 'Close opportunity' })).toBeInTheDocument();
    expect(onOutcome).not.toHaveBeenCalled();

    await act(async () => server.answer());
    await waitFor(() => expect(onOutcome).toHaveBeenCalledWith(true));
    expect(onOutcome).toHaveBeenCalledTimes(1);
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
