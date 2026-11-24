import { fireEvent, render, screen } from '@testing-library/react';
import { StrictMode, useState, type SyntheticEvent } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { browserCloses, pressEscapeOn } from '@/test/dialog';
import { Dialog, DialogContent, DialogTitle } from './dialog';

function renderDialog(extra: {
  onCancel?: (e: SyntheticEvent) => void;
  onClose?: () => void;
  onClick?: () => void;
}) {
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
    browserCloses(dialog);
    expect(onOpenChange).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(callerClose).toHaveBeenCalledTimes(1);
  });

  // https://github.com/bgoleno/opportun/issues/975: a browser sends `close` a frame after the close
  // itself, so it can find the dialog open again.
  it('a close event that finds the dialog open again asks nobody and does not reach the caller', () => {
    const callerClose = vi.fn();
    const { onOpenChange, dialog } = renderDialog({ onClose: callerClose });
    fireEvent(dialog, new Event('close'));
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(callerClose).not.toHaveBeenCalled();
    expect(dialog).toHaveAttribute('open');
  });

  it('opened again by its parent before its close event comes, it stays open', () => {
    function Reopened() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open
          </button>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent>
              <DialogTitle>Example</DialogTitle>
              <p>Body</p>
            </DialogContent>
          </Dialog>
        </>
      );
    }
    render(<Reopened />);
    const dialog = screen.getByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(dialog).not.toHaveAttribute('open');
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    fireEvent(dialog, new Event('close'));
    expect(dialog).toHaveAttribute('open');
    expect(screen.getByText('Body')).toBeInTheDocument();
  });

  it("Escape is left alone when the caller's onCancel prevented it", () => {
    const { onOpenChange, dialog } = renderDialog({ onCancel: (e) => e.preventDefault() });
    expect(pressEscapeOn(dialog)).toBe(true);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(dialog).toHaveAttribute('open');
  });

  it("Escape asks the parent once, after the caller's own onCancel", () => {
    const callerCancel = vi.fn();
    const { onOpenChange, dialog } = renderDialog({ onCancel: callerCancel });
    expect(pressEscapeOn(dialog)).toBe(true);
    expect(callerCancel).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
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

// A parent may take the dialog out as it answers (`{asked ? <Dialog open ...> : null}`): an element
// that goes while it is open gives the focus back to nobody (#975). jsdom has no close().
describe('DialogContent taken out by its parent', () => {
  const proto = HTMLDialogElement.prototype;
  afterEach(() => {
    Reflect.deleteProperty(proto, 'close');
  });

  function setup(open: boolean) {
    /** One entry per close(): whether the element was still in the page. */
    const closes: boolean[] = [];
    proto.close = function (this: HTMLDialogElement) {
      closes.push(this.isConnected);
      this.removeAttribute('open');
    };
    function Parent({ shown }: { shown: boolean }) {
      return shown ? (
        <Dialog open={open} onOpenChange={() => undefined}>
          <DialogContent>
            <DialogTitle>Example</DialogTitle>
          </DialogContent>
        </Dialog>
      ) : null;
    }
    const { rerender } = render(<Parent shown />);
    expect(closes).toEqual([]);
    rerender(<Parent shown={false} />);
    expect(document.querySelector('dialog')).toBeNull();
    return closes;
  }

  it('is closed once, before it leaves the page', () => {
    expect(setup(true)).toEqual([true]);
  });

  it('is not closed when it was not open', () => {
    expect(setup(false)).toEqual([]);
  });

  it('is open after the extra mount of StrictMode', () => {
    proto.close = function (this: HTMLDialogElement) {
      this.removeAttribute('open');
    };
    const onOpenChange = vi.fn();
    render(
      <StrictMode>
        <Dialog open onOpenChange={onOpenChange}>
          <DialogContent>
            <DialogTitle>Example</DialogTitle>
          </DialogContent>
        </Dialog>
      </StrictMode>,
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('open');
    // The close event of the extra unmount.
    fireEvent(dialog, new Event('close'));
    expect(onOpenChange).not.toHaveBeenCalled();
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

  it('without it, Escape asks the parent all the same, and a refused one leaves it open', () => {
    const { dialog } = setup({ accepts: false, unguarded: true });
    expect(pressEscapeOn(dialog)).toBe(true);
    expect(screen.getByText('asked 1')).toBeInTheDocument();
    expect(dialog).toHaveAttribute('open');
    expect(screen.getByLabelText('File')).toBeInTheDocument();
  });

  it('without it, Escape closes it when the parent agrees', () => {
    const { dialog } = setup({ accepts: true, unguarded: true });
    expect(pressEscapeOn(dialog)).toBe(true);
    expect(screen.getByText('asked 1')).toBeInTheDocument();
    expect(dialog).not.toHaveAttribute('open');
    expect(screen.queryByLabelText('File')).toBeNull();
  });

  it("without it, a file picker's own cancel is not Escape on the dialog either", () => {
    const { dialog } = setup({ accepts: true, unguarded: true });
    const cancel = new Event('cancel', { bubbles: true, cancelable: true });
    fireEvent(screen.getByLabelText('File'), cancel);
    expect(cancel.defaultPrevented).toBe(false);
    expect(screen.getByText('asked 0')).toBeInTheDocument();
    expect(dialog).toHaveAttribute('open');
  });

  it('without it, a close the browser makes on its own is not shown again, whatever the parent says', () => {
    const { dialog } = setup({ accepts: false, unguarded: true });
    browserCloses(dialog);
    expect(screen.getByText('asked 1')).toBeInTheDocument();
    expect(dialog).not.toHaveAttribute('open');
  });
});
