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
});
