import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { browserCloses, pressEscapeOn } from '@/test/dialog';
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

// https://github.com/bgoleno/opportun/issues/898: a dialog that shows something once, or must wait
// for a request, refuses to close by not changing its `open`. The browser closed it all the same.
describe('DialogContent with guardClose', () => {
  function Guarded({ accepts, unguarded }: { accepts: boolean; unguarded?: true }) {
    const [open, setOpen] = useState(true);
    const [asked, setAsked] = useState(0);
    return (
      <>
        <p>asked {asked}</p>
        <Dialog
          open={open}
          onOpenChange={(next) => {
            setAsked((n) => n + 1);
            if (accepts) setOpen(next);
          }}
        >
          <DialogContent {...(unguarded ? {} : { guardClose: true })}>
            <DialogTitle>Example</DialogTitle>
            <input aria-label="File" type="file" />
          </DialogContent>
        </Dialog>
      </>
    );
  }
  function setup(props: { accepts: boolean; unguarded?: true }) {
    render(<Guarded {...props} />);
    const dialog = screen.getByRole('dialog');
    return { dialog };
  }

  it('Escape asks the parent, and a refused one leaves it open', () => {
    const { dialog } = setup({ accepts: false });
    // Refused, so it never leaves the screen (nor the focus the dialog), not shown again after.
    expect(pressEscapeOn(dialog)).toBe(true);
    expect(screen.getByText('asked 1')).toBeInTheDocument();
    expect(dialog).toHaveAttribute('open');
    expect(screen.getByLabelText('File')).toBeInTheDocument();
  });

  it('a close the browser makes on its own is shown again, every time, when refused', () => {
    const { dialog } = setup({ accepts: false });
    browserCloses(dialog);
    expect(dialog).toHaveAttribute('open');
    browserCloses(dialog);
    expect(dialog).toHaveAttribute('open');
    expect(screen.getByText('asked 2')).toBeInTheDocument();
  });

  it('Escape closes it when the parent agrees', () => {
    const { dialog } = setup({ accepts: true });
    pressEscapeOn(dialog);
    expect(dialog).not.toHaveAttribute('open');
    expect(screen.queryByLabelText('File')).toBeNull();
  });

  it('a close the browser makes on its own stays closed when the parent agrees', () => {
    const { dialog } = setup({ accepts: true });
    browserCloses(dialog);
    expect(dialog).not.toHaveAttribute('open');
  });

  it("a file picker's own cancel, which bubbles, is not Escape on the dialog", () => {
    const { dialog } = setup({ accepts: true });
    const cancel = new Event('cancel', { bubbles: true, cancelable: true });
    fireEvent(screen.getByLabelText('File'), cancel);
    expect(cancel.defaultPrevented).toBe(false);
    expect(screen.getByText('asked 0')).toBeInTheDocument();
    expect(dialog).toHaveAttribute('open');
  });

  it('without it, the browser closes the dialog on Escape as before', () => {
    const { dialog } = setup({ accepts: false, unguarded: true });
    const cancel = new Event('cancel', { cancelable: true });
    fireEvent(dialog, cancel);
    expect(cancel.defaultPrevented).toBe(false);
    expect(screen.getByText('asked 0')).toBeInTheDocument();
    browserCloses(dialog);
    expect(screen.getByText('asked 1')).toBeInTheDocument();
    expect(dialog).not.toHaveAttribute('open');
  });
});
