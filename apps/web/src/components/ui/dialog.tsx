// Adapted from shadcn/ui's Dialog (MIT). See README.md in this folder: built on the native
// <dialog> element, which gives a focus trap, Escape to close, inert background and a
// top-layer backdrop without injecting styles (Radix Dialog's scroll lock does, and the
// CSP blocks it).
import { X } from 'lucide-react';
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type * as React from 'react';
import { cn } from '@/lib/utils';

interface DialogCtx {
  open: boolean;
  setOpen: (open: boolean) => void;
  titleId: string;
  descriptionId: string;
}

const Ctx = createContext<DialogCtx | null>(null);

function useDialog(): DialogCtx {
  const ctx = useContext(Ctx);
  if (ctx === null) throw new Error('Dialog parts must be used inside <Dialog>');
  return ctx;
}

function Dialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  const titleId = useId();
  const descriptionId = useId();
  return (
    <Ctx.Provider value={{ open: props.open, setOpen: props.onOpenChange, titleId, descriptionId }}>
      {props.children}
    </Ctx.Provider>
  );
}

function DialogContent({
  className,
  children,
  showClose = true,
  guardClose = false,
  onCancel,
  onClose,
  onClick,
  ...props
}: Omit<React.ComponentProps<'dialog'>, 'open'> & {
  showClose?: boolean;
  /**
   * For a dialog whose parent may refuse to close it: one that shows something once, or that must
   * wait for a request (#898). Escape only asks (`onOpenChange(false)`), and a close the browser
   * makes anyway is shown again unless the parent agreed to it. Without this the browser closes
   * the dialog on Escape whatever the parent answers, and the parent, still `open`, can neither
   * show it again nor show the next one.
   */
  guardClose?: boolean;
}) {
  const { open, setOpen, titleId, descriptionId } = useDialog();
  const ref = useRef<HTMLDialogElement>(null);
  // Counts the browser's own closes, so the effect below runs after one that was refused.
  const [nativeCloses, setNativeCloses] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    if (open && !el.open) {
      if (typeof el.showModal === 'function') el.showModal();
      else el.setAttribute('open', '');
    } else if (!open && el.open) {
      if (typeof el.close === 'function') el.close();
      else el.removeAttribute('open');
    }
  }, [open, nativeCloses]);

  return (
    // Caller props are spread first so they can never replace the close wiring below;
    // caller onCancel/onClose/onClick handlers still run, before the dialog's own.
    <dialog
      {...props}
      ref={ref}
      data-slot="dialog-content"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onCancel={(e) => {
        onCancel?.(e);
        // A file input's own `cancel` bubbles to here: only the dialog's is Escape.
        if (!guardClose || e.target !== e.currentTarget) return;
        e.preventDefault();
        setOpen(false);
      }}
      onClose={(e) => {
        onClose?.(e);
        setOpen(false);
        // Escape is not always refusable (a second one, with nothing clicked or typed since, is
        // not), so the browser may have closed it all the same.
        if (guardClose) setNativeCloses((n) => n + 1);
      }}
      onClick={(e) => {
        onClick?.(e);
        // A click on the dialog element itself (not its content) is a backdrop click.
        if (e.target === e.currentTarget) setOpen(false);
      }}
      className={cn(
        'm-auto w-[calc(100%-2rem)] max-w-lg rounded-xl border bg-popover p-0 text-popover-foreground shadow-lg',
        className,
      )}
    >
      {open ? (
        <div className="relative grid max-h-[85vh] gap-4 overflow-y-auto p-6">
          {children}
          {showClose ? (
            <button
              type="button"
              aria-label="Close"
              onClick={() => setOpen(false)}
              className="absolute top-4 right-4 cursor-pointer rounded-sm text-muted-foreground opacity-80 transition-opacity outline-none hover:opacity-100 focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          ) : null}
        </div>
      ) : null}
    </dialog>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="dialog-header"
      className={cn('flex flex-col gap-2 pr-6 text-left', className)}
      {...props}
    />
  );
}

function DialogFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn('flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)}
      {...props}
    />
  );
}

// Local change: the title and the description break anywhere. Either can hold someone's words (a
// name, a subject, an address), and one long word widened the dialog's content past its edge,
// buttons included (https://github.com/bgoleno/opportun/issues/921).
function DialogTitle({ className, ...props }: React.ComponentProps<'h2'>) {
  const { titleId } = useDialog();
  return (
    <h2
      id={titleId}
      data-slot="dialog-title"
      className={cn('text-lg leading-none font-semibold [overflow-wrap:anywhere]', className)}
      {...props}
    />
  );
}

function DialogDescription({ className, ...props }: React.ComponentProps<'p'>) {
  const { descriptionId } = useDialog();
  return (
    <p
      id={descriptionId}
      data-slot="dialog-description"
      className={cn('text-sm text-muted-foreground [overflow-wrap:anywhere]', className)}
      {...props}
    />
  );
}

export { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle };
