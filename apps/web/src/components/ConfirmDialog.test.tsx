import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/api';
import { renderWithProviders } from '@/test/render';
import { ConfirmDialog } from './ConfirmDialog';

function Harness({ onConfirm }: { onConfirm: () => Promise<void> }) {
  const [open, setOpen] = useState(true);
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={setOpen}
      title="Delete this thing?"
      description="It is gone for good."
      confirmLabel="Delete"
      onConfirm={onConfirm}
    />
  );
}

describe('ConfirmDialog', () => {
  it('closes only once onConfirm resolves', async () => {
    const user = userEvent.setup();
    let resolve!: () => void;
    const pending = new Promise<void>((r) => {
      resolve = r;
    });
    renderWithProviders(<Harness onConfirm={() => pending} />);
    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    expect(screen.getByText('Delete this thing?')).toBeInTheDocument();
    resolve();
    await waitFor(() => expect(screen.queryByText('Delete this thing?')).not.toBeInTheDocument());
  });

  it('stays open and shows the failure when onConfirm rejects, instead of closing as if it worked', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <Harness onConfirm={() => Promise.reject(new ApiError(500, 'internal'))} />,
    );
    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Request failed (internal).');
    expect(screen.getByText('Delete this thing?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeEnabled();
  });

  it('clears the error on cancel, so a reopened dialog starts clean', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness onConfirm={() => Promise.reject(new Error('boom'))} />);
    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText('Delete this thing?')).not.toBeInTheDocument();
  });

  // https://github.com/bgoleno/opportun/issues/678 (qa's B1, tl's review): while the action was in
  // flight, Cancel, Escape and a backdrop click closed the dialog and its failure was shown
  // nowhere. It stays closable (a request has no time limit, so a dialog that could not be left
  // could trap the user), and a failure that lands after it was left is reported in a toast.
  it('can always be left, even in flight, and a failure that lands afterwards is still reported', async () => {
    const user = userEvent.setup();
    let fail!: (err: Error) => void;
    const pending = new Promise<void>((_, reject) => {
      fail = reject;
    });
    renderWithProviders(<Harness onConfirm={() => pending} />);
    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    expect(cancel).toBeEnabled();
    const escape = new Event('cancel', { cancelable: true });
    screen.getByRole('dialog').dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(false);
    await user.click(cancel);
    await waitFor(() => expect(screen.queryByText('Delete this thing?')).not.toBeInTheDocument());
    fail(new ApiError(500, 'internal'));
    expect(await screen.findByText('Delete failed')).toBeInTheDocument();
    expect(screen.getByText('Request failed (internal).')).toBeInTheDocument();
  });

  it('a failure while it is still open stays in it, with no toast', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <Harness onConfirm={() => Promise.reject(new ApiError(500, 'internal'))} />,
    );
    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Request failed (internal).');
    expect(screen.queryByText('Delete failed')).toBeNull();
  });

  it('closes on Escape when nothing is in flight', async () => {
    renderWithProviders(<Harness onConfirm={() => Promise.resolve()} />);
    const dialog = await screen.findByRole('dialog');
    const escape = new Event('cancel', { cancelable: true });
    dialog.dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(false);
  });
});
