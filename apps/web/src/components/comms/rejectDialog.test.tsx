// Reject as out of scope (spec D4). The dialog's job is to make the privacy boundary legible:
// the reason code is what improves the filter, the note is the user's own and stays local
// unless they say otherwise for that note, and (#145) "removed" and "removed and blocked" are
// different promises, so the dialog must say which one the server actually confirmed.
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

async function reject(result: unknown) {
  mockApi({ 'POST /communications/c1/reject': result });
  const onOpenChange = vi.fn();
  renderWithProviders(<RejectDialog comm={COMM} open onOpenChange={onOpenChange} />);
  const user = userEvent.setup();
  await user.selectOptions(
    await screen.findByLabelText('Why should this not be here?'),
    'medical_or_personal',
  );
  await user.click(screen.getByRole('button', { name: 'Reject' }));
  return onOpenChange;
}

describe('RejectDialog', () => {
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
