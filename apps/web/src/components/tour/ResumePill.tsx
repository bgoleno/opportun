// The paused tour (design 4.4): a plain fixed button, deliberately not a <dialog>, because
// useHotkeys suppresses every page shortcut while any dialog[open] exists and a paused tour
// must not disable j/k/i/x on the page the user was sent to use.
import { Check, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { STEP_COUNT } from './steps';

export function ResumePill(props: {
  step: number;
  done: boolean;
  busy: boolean;
  onResume: () => void;
  onDismiss: () => void;
}) {
  return (
    <div
      className={cn(
        'fixed bottom-4 left-1/2 z-40 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-1 rounded-full border bg-popover p-1 text-sm text-popover-foreground shadow-lg sm:right-4 sm:left-auto sm:translate-x-0',
        props.done && 'border-success',
      )}
    >
      <button
        type="button"
        disabled={props.busy}
        onClick={props.onResume}
        className="flex min-h-9 cursor-pointer items-center gap-2 rounded-full px-3 font-medium outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11"
      >
        {props.done ? (
          <>
            <Check aria-hidden="true" className="size-4 text-success" />
            Nice, that&apos;s done. Continue tour
          </>
        ) : (
          `Resume tour (${props.step} of ${STEP_COUNT})`
        )}
      </button>
      <button
        type="button"
        aria-label="End tour"
        disabled={props.busy}
        onClick={props.onDismiss}
        className="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:size-11"
      >
        <X aria-hidden="true" className="size-4" />
      </button>
    </div>
  );
}
