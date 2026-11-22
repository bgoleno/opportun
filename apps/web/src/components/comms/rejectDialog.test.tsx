// Reject as out of scope (spec D4). The dialog's job is to make the privacy boundary legible:
// the reason code is what improves the filter, the note is the user's own and stays local
// unless they say otherwise for that note, and (#145) "removed" and "removed and blocked" are
// different promises, so the dialog must say which one the server actually confirmed.
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { mockApi, renderWithProviders } from '@/test/render';
import type { CommunicationView } from './api';
import { RejectDialog } from './RejectDialog';
import { RejectForm } from './RejectForm';

const COMM: CommunicationView = {
  id: 'c1',
  channel: 'gmail',
  externalId: 'ext-c1',
  triageDecision: 'passed',
  triageRule: 'none',
  threadKey: 't1',
  from: 'billing@clinic-a.example',
  to: ['me@example.com'],
  subject: 'Superbill',
  snippet: 'Your balance due is 42.00.',
  sentAt: Date.now(),
  classification: 'other',
  outreachKind: null,
  mismatchReason: null,
  confidence: null,
  bodySource: null,
  opportunityId: null,
  opportunityTitle: null,
  companyName: null,
  opportunityStage: null,
  needsReview: false,
  proposedTransition: null,
  createdAt: Date.now(),
};

async function reject(result: unknown, comm: CommunicationView = COMM) {
  const api = mockApi({ 'POST /communications/c1/reject': result });
  lastCalls = api.calls;
  const onOpenChange = vi.fn();
  renderWithProviders(<RejectDialog comm={comm} open onOpenChange={onOpenChange} />);
  const user = userEvent.setup();
  await user.selectOptions(
    await screen.findByLabelText('Why should this not be here?'),
    'medical_or_personal',
  );
  await user.click(screen.getByRole('button', { name: 'Reject' }));
  return onOpenChange;
}

let lastCalls: { method: string; path: string; body: unknown }[] = [];

describe('RejectDialog', () => {
  // https://github.com/bgoleno/opportun/issues/666: the link the message was seen under goes with
  // the reject, so the server leaves it alone if another session linked it meanwhile.
  it('sends the link the message was seen under', async () => {
    await reject({ blocked: null });
    await screen.findByText('Rejected and removed');
    const post = lastCalls.find(
      (c) => c.method === 'POST' && c.path === '/communications/c1/reject',
    );
    expect(post?.body).toMatchObject({ expectedOpportunityId: null });
  });

  // #678 criterion 3 (qa on #672): with only unlinked messages above, a dialog that always sent
  // null passed. A linked one sends its link.
  it('a linked message sends its own link, not null', async () => {
    await reject({ blocked: null }, { ...COMM, opportunityId: 'opp-7', opportunityTitle: 'Staff' });
    await screen.findByText('Rejected and removed');
    const post = lastCalls.find(
      (c) => c.method === 'POST' && c.path === '/communications/c1/reject',
    );
    expect(post?.body).toMatchObject({ expectedOpportunityId: 'opp-7' });
  });

  it('says "blocked" only once the server confirms a deny rule is active', async () => {
    const onOpenChange = await reject({ blocked: true });
    expect(await screen.findByText('Rejected, removed, and blocked')).toBeInTheDocument();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('does not claim "blocked" when the server reports the block could not be established', async () => {
    const onOpenChange = await reject({ blocked: false, blockFailureReason: 'unparseable_sender' });
    expect(await screen.findByText('Rejected and removed, not blocked')).toBeInTheDocument();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('says plain "Rejected and removed" when no block was asked for', async () => {
    const onOpenChange = await reject({ blocked: null });
    expect(await screen.findByText('Rejected and removed')).toBeInTheDocument();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('keeps the dialog open and reports the error on a genuine failure, rather than closing as if it had worked', async () => {
    mockApi({
      'POST /communications/c1/reject': () => ({
        status: 500,
        body: { error: { code: 'server_error' } },
      }),
    });
    const onOpenChange = vi.fn();
    renderWithProviders(<RejectDialog comm={COMM} open onOpenChange={onOpenChange} />);
    const user = userEvent.setup();
    await user.selectOptions(
      await screen.findByLabelText('Why should this not be here?'),
      'medical_or_personal',
    );
    await user.click(screen.getByRole('button', { name: 'Reject' }));

    expect(await screen.findByText('Not rejected')).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});

describe('RejectForm', () => {
  it('cannot be submitted without a reason', async () => {
    render(<RejectForm sender="billing@clinic-a.example" onReject={vi.fn()} pending={false} />);
    expect(screen.getByRole('button', { name: 'Reject' })).toBeDisabled();
  });

  it('submits the reason code', async () => {
    const user = userEvent.setup();
    const onReject = vi.fn();
    render(<RejectForm sender="x@agency-c.example" onReject={onReject} pending={false} />);

    await user.selectOptions(screen.getByLabelText('Why should this not be here?'), 'wrong_role');
    await user.click(screen.getByRole('button', { name: 'Reject' }));

    expect(onReject).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'wrong_role', shareNote: false }),
    );
  });

  it('keeps the note out of the payload flag unless the user opts in', async () => {
    const user = userEvent.setup();
    const onReject = vi.fn();
    render(<RejectForm sender="x@agency-c.example" onReject={onReject} pending={false} />);

    await user.selectOptions(screen.getByLabelText('Why should this not be here?'), 'other');
    await user.type(screen.getByLabelText('Note (optional)'), 'my chiropractor');
    await user.click(screen.getByRole('button', { name: 'Reject' }));

    expect(onReject).toHaveBeenCalledWith(
      expect.objectContaining({ note: 'my chiropractor', shareNote: false }),
    );
  });

  it('says where a shared note goes before the user shares it', async () => {
    const user = userEvent.setup();
    const onReject = vi.fn();
    render(<RejectForm sender="x@agency-c.example" onReject={onReject} pending={false} />);
    await user.selectOptions(screen.getByLabelText('Why should this not be here?'), 'other');

    const share = screen.getByRole('checkbox', { name: /use this note to improve the filter/i });
    expect(share).not.toBeChecked();
    expect(screen.getByTestId('share-note-warning')).toHaveTextContent(/to the AI/i);

    await user.click(share);
    await user.click(screen.getByRole('button', { name: 'Reject' }));
    expect(onReject).toHaveBeenCalledWith(expect.objectContaining({ shareNote: true }));
  });

  it('offers to block the sender, defaulting on for medical and financial', async () => {
    const user = userEvent.setup();
    const onReject = vi.fn();
    render(<RejectForm sender="billing@clinic-a.example" onReject={onReject} pending={false} />);

    await user.selectOptions(
      screen.getByLabelText('Why should this not be here?'),
      'medical_or_personal',
    );
    expect(screen.getByRole('checkbox', { name: /never fetch mail from/i })).toBeChecked();

    await user.click(screen.getByRole('button', { name: 'Reject' }));
    expect(onReject).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'medical_or_personal', neverIngest: 'domain' }),
    );
  });

  it('does not default to blocking for an ordinary wrong-role rejection', async () => {
    const user = userEvent.setup();
    render(<RejectForm sender="x@agency-c.example" onReject={vi.fn()} pending={false} />);
    await user.selectOptions(screen.getByLabelText('Why should this not be here?'), 'wrong_role');
    expect(screen.getByRole('checkbox', { name: /never fetch mail from/i })).not.toBeChecked();
  });

  it('can block just the one address instead of the whole domain', async () => {
    const user = userEvent.setup();
    const onReject = vi.fn();
    render(<RejectForm sender="billing@clinic-a.example" onReject={onReject} pending={false} />);

    await user.selectOptions(screen.getByLabelText('Why should this not be here?'), 'financial');
    await user.selectOptions(screen.getByLabelText('Block'), 'address');
    await user.click(screen.getByRole('button', { name: 'Reject' }));

    expect(onReject).toHaveBeenCalledWith(expect.objectContaining({ neverIngest: 'address' }));
  });

  it('warns that rejecting destroys the content', () => {
    render(<RejectForm sender="x@agency-c.example" onReject={vi.fn()} pending={false} />);
    expect(screen.getByTestId('reject-warning')).toHaveTextContent(/subject and body/i);
  });
});

// https://github.com/bgoleno/opportun/issues/678 criteria 1 and 2 (qa on #672): the rejected row
// leaves the list on the refetch, and with it this dialog. Callbacks passed to mutate() are dropped
// once the component is gone, so a single reject's success, and its refusal, were reported
// nowhere. Here the dialog is gone before the server answers, which is the case that lost them. A
// refusal also read as a raw code.
describe('RejectDialog: the outcome is reported even once the dialog is gone (#678)', () => {
  async function rejectThenUnmount(answer: unknown) {
    let answerNow!: () => void;
    const answered = new Promise<void>((r) => (answerNow = r));
    let unmount!: () => void;
    function Host() {
      const [shown, setShown] = useState(true);
      unmount = () => setShown(false);
      return shown ? <RejectDialog comm={COMM} open onOpenChange={() => {}} /> : null;
    }
    mockApi({
      'POST /communications/c1/reject': async () => {
        await answered;
        return answer;
      },
    });
    renderWithProviders(<Host />);
    const user = userEvent.setup();
    await user.selectOptions(
      await screen.findByLabelText('Why should this not be here?'),
      'medical_or_personal',
    );
    await user.click(screen.getByRole('button', { name: 'Reject' }));
    act(() => unmount());
    expect(screen.queryByRole('dialog')).toBeNull();
    answerNow();
  }

  it('a reject that went through says so', async () => {
    await rejectThenUnmount({ status: 200, body: { blocked: null } });
    expect(await screen.findByText('Rejected and removed')).toBeInTheDocument();
  });

  it('a refused one says why in plain words', async () => {
    await rejectThenUnmount({ status: 409, body: { error: { code: 'message_changed' } } });
    expect(await screen.findByText('Not rejected')).toBeInTheDocument();
    expect(
      screen.getByText('This message was linked or changed elsewhere, so it was not rejected.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/message_changed/)).toBeNull();
  });
});
