import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/api';
import { pressEscapeOn } from '@/test/dialog';
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
  it.each(['Cancel', 'Escape'])(
    'can always be left, even in flight (%s), and a failure that lands afterwards is still reported',
    async (how) => {
      const user = userEvent.setup();
      let fail!: (err: Error) => void;
      const pending = new Promise<void>((_, reject) => {
        fail = reject;
      });
      renderWithProviders(<Harness onConfirm={() => pending} />);
      await user.click(await screen.findByRole('button', { name: 'Delete' }));
      const cancel = screen.getByRole('button', { name: 'Cancel' });
      expect(cancel).toBeEnabled();
      if (how === 'Escape') pressEscapeOn(screen.getByRole('dialog'));
      else await user.click(cancel);
      await waitFor(() => expect(screen.queryByText('Delete this thing?')).not.toBeInTheDocument());
      fail(new ApiError(500, 'internal'));
      expect(await screen.findByText('Delete failed')).toBeInTheDocument();
      expect(screen.getByText('Request failed (internal).')).toBeInTheDocument();
    },
  );

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
    pressEscapeOn(dialog);
    expect(screen.queryByText('Delete this thing?')).toBeNull();
    expect(dialog).not.toHaveAttribute('open');
  });

  // tl on #712: a dialog whose parent unmounts mid-request (the bulk bar going as its rows leave)
  // still reported a late failure into its own, now unmounted, state: shown nowhere.
  it('a failure that lands after its parent unmounted it is toasted', async () => {
    const user = userEvent.setup();
    let fail!: (err: Error) => void;
    const pending = new Promise<void>((_, reject) => {
      fail = reject;
    });
    let unmount!: () => void;
    function Host() {
      const [shown, setShown] = useState(true);
      unmount = () => setShown(false);
      return shown ? <Harness onConfirm={() => pending} /> : null;
    }
    renderWithProviders(<Host />);
    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    act(() => unmount());
    expect(screen.queryByText('Delete this thing?')).toBeNull();
    fail(new ApiError(500, 'internal'));
    expect(await screen.findByText('Delete failed')).toBeInTheDocument();
  });

  // qa's stale-error case (the EM on #712): closed while in flight, then answered 500, the dialog
  // reopened showing that old failure. A late failure is toasted, never kept for the next opening.
  it('reopened after a failure that landed while it was closed, it starts clean', async () => {
    const user = userEvent.setup();
    let fail!: (err: Error) => void;
    let calls = 0;
    function Reopenable() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open it
          </button>
          <ConfirmDialog
            open={open}
            onOpenChange={setOpen}
            title="Delete this thing?"
            description="It is gone for good."
            confirmLabel="Delete"
            onConfirm={() => {
              calls += 1;
              return new Promise<void>((_, reject) => {
                fail = reject;
              });
            }}
          />
        </>
      );
    }
    renderWithProviders(<Reopenable />);
    await user.click(await screen.findByRole('button', { name: 'Open it' }));
    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    fail(new ApiError(500, 'internal'));
    expect(await screen.findByText('Delete failed')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Open it' }));
    expect(await screen.findByText('Delete this thing?')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(calls).toBe(1);
  });
});
