import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Dialog, DialogContent, DialogTitle } from './dialog';

function renderDialog(extra: { onClose?: () => void; onClick?: () => void }) {
  const onOpenChange = vi.fn();
  render(
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent {...extra}>
        <DialogTitle>Example</DialogTitle>
        <p>Body</p>
      </DialogContent>
    </Dialog>,
  );
  const dialog = document.querySelector('dialog');
  if (dialog === null) throw new Error('no dialog');
  return { onOpenChange, dialog };
}

describe('DialogContent', () => {
  it('closes on the native close event even when the caller passes onClose', () => {
    const callerClose = vi.fn();
    const { onOpenChange, dialog } = renderDialog({ onClose: callerClose });
    fireEvent(dialog, new Event('close'));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(callerClose).toHaveBeenCalledTimes(1);
  });

  it('closes on a backdrop click even when the caller passes onClick', () => {
    const callerClick = vi.fn();
    const { onOpenChange, dialog } = renderDialog({ onClick: callerClick });
    fireEvent.click(screen.getByText('Body'));
    expect(onOpenChange).not.toHaveBeenCalled();
    fireEvent.click(dialog);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(callerClick).toHaveBeenCalledTimes(2);
  });

  it('closes from the close button', () => {
    const { onOpenChange } = renderDialog({});
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
