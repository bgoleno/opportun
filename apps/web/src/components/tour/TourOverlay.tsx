// The tour layer (FR-U11, design section 6): one native <dialog> opened with showModal(), which
// gives the focus trap, the inert page underneath, Esc via `cancel`, the top layer (no z-index
// fight with the sticky header or Radix portals) and useHotkeys' dialog[open] suppression, all
// without a library. Every position is written through React's style prop (CSSOM), which the
// CSP allows; nothing here creates a <style> element. See components/ui/README.md.
import {
  arrow,
  autoUpdate,
  flip,
  hide,
  offset,
  shift,
  size,
  useFloating,
  type Placement as FloatingPlacement,
} from '@floating-ui/react-dom';
import { X } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { STEP_COUNT, type Placement } from './steps';

const SPOT_PAD = 6;
const EDGE = 16;

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** The target's rect plus padding, clamped to the viewport so a wide or tall target never
 *  produces a shadow box larger than the screen (section 9). */
function spotlightRect(el: Element): Rect {
  const r = el.getBoundingClientRect();
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  const left = Math.max(0, r.left - SPOT_PAD);
  const top = Math.max(0, r.top - SPOT_PAD);
  const right = Math.min(vw, r.right + SPOT_PAD);
  const bottom = Math.min(vh, r.bottom + SPOT_PAD);
  return { top, left, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

export interface TourAction {
  label: string;
  onClick: () => void;
  variant: 'default' | 'outline';
  /** Receives focus when the step opens, so Enter does the expected thing. */
  initialFocus?: boolean;
}

export interface TourOverlayProps {
  open: boolean;
  /** null: centered (welcome, a fallback, or still searching when `searching`). */
  target: Element | null;
  searching: boolean;
  sheet: boolean;
  placement?: Placement | undefined;
  /** 1..9, or null for the welcome screen (not counted). */
  step: number | null;
  /** Changes on every step, so focus moves to the new primary action. */
  stepKey: string;
  title: string;
  body: string;
  extra?: ReactNode;
  /** In DOM (= visual) order: Back, Do it now, Next. */
  actions: TourAction[];
  /** ArrowRight / ArrowLeft while focus is on a card button. */
  onNext: () => void;
  onBack?: (() => void) | undefined;
  /** Skip tour, the X and Esc. */
  onSkip: () => void;
  skipLabel?: string;
  busy: boolean;
}

export function TourOverlay(props: TourOverlayProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const arrowRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const bodyId = useId();
  const [spot, setSpot] = useState<Rect | null>(null);
  const { open, target, sheet } = props;
  const anchored = target !== null && !sheet;

  useEffect(() => {
    const el = dialogRef.current;
    if (el === null) return;
    if (open && !el.open) {
      if (typeof el.showModal === 'function') el.showModal();
      else el.setAttribute('open', '');
    } else if (!open && el.open) {
      if (typeof el.close === 'function') el.close();
      else el.removeAttribute('open');
    }
  }, [open]);

  const { refs, floatingStyles, middlewareData, placement, isPositioned, update } = useFloating({
    placement: (props.placement ?? 'bottom') as FloatingPlacement,
    strategy: 'fixed',
    middleware: [
      offset(12),
      flip({ padding: EDGE }),
      shift({ padding: EDGE }),
      size({
        padding: EDGE,
        apply({ availableHeight, elements }) {
          elements.floating.style.maxHeight = `${Math.max(160, availableHeight)}px`;
        },
      }),
      hide({ strategy: 'referenceHidden' }),
      arrow({ element: arrowRef }),
    ],
  });

  // The floating reference is the spotlight, not the raw target (offset from the padded
  // rect). A target taller than 60% of the viewport is referenced by its top edge, so the card
  // sits inside the viewport over the target rather than off-screen beyond it (section 6.2).
  useLayoutEffect(() => {
    if (!open || target === null) {
      setSpot(null);
      refs.setReference(null);
      return;
    }
    const virtual = {
      contextElement: target,
      getBoundingClientRect: () => {
        const s = spotlightRect(target);
        const large = s.height > window.innerHeight * 0.6;
        const h = large ? 0 : s.height;
        return {
          x: s.left,
          y: s.top,
          width: s.width,
          height: h,
          top: s.top,
          left: s.left,
          right: s.left + s.width,
          bottom: s.top + h,
        };
      },
    };
    refs.setReference(virtual);
    setSpot(spotlightRect(target));
    const floating = refs.floating.current;
    if (floating === null) return;
    // Follows scroll, resize and the target's own size changes; the page is not scroll-locked.
    return autoUpdate(
      target,
      floating,
      () => {
        setSpot(spotlightRect(target));
        update();
      },
      // Every supported browser has both observers; a test DOM may not.
      {
        elementResize: typeof ResizeObserver !== 'undefined',
        layoutShift: typeof IntersectionObserver !== 'undefined',
      },
    );
  }, [open, target, refs, sheet, update]);

  useEffect(() => {
    if (open && !props.searching) primaryRef.current?.focus();
  }, [open, props.searching, props.stepKey]);

  const hidden = middlewareData.hide?.referenceHidden === true;
  const docked = sheet || target === null ? sheet : hidden;
  const centered = !docked && (target === null || props.searching);
  // A target taller than the room beside the sheet: the spotlight is clamped to the part the
  // sheet leaves visible, so what is highlighted is never under the card (section 9).
  const [drawn, setDrawn] = useState<Rect | null>(null);
  useLayoutEffect(() => {
    const card = refs.floating.current;
    if (spot === null || !docked || card === null) {
      setDrawn(spot);
      return;
    }
    const c = card.getBoundingClientRect();
    const bottom = Math.min(spot.top + spot.height, c.top - SPOT_PAD);
    setDrawn({ ...spot, height: Math.max(0, bottom - spot.top) });
  }, [spot, docked, refs, props.stepKey]);
  const side = placement.split('-')[0] as Placement;
  const arrowSide = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' }[side];

  function onKeyDown(e: React.KeyboardEvent) {
    if (!(e.target instanceof HTMLButtonElement)) return;
    if (props.busy) return;
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      props.onNext();
    } else if (e.key === 'ArrowLeft' && props.onBack !== undefined) {
      e.preventDefault();
      props.onBack();
    }
  }

  return (
    <dialog
      ref={dialogRef}
      data-tour-layer=""
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      onCancel={(e) => {
        // Esc is Skip; the dialog closes when the skip is recorded, not before.
        e.preventDefault();
        if (!props.busy) props.onSkip();
      }}
      className="fixed inset-0 m-0 h-dvh max-h-none w-dvw max-w-none overflow-hidden bg-transparent p-0 text-popover-foreground backdrop:bg-transparent"
    >
      {open ? (
        <>
          {drawn !== null && drawn.height > 0 && !hidden && !props.searching ? (
            <div
              aria-hidden="true"
              data-tour-spotlight=""
              className="pointer-events-none fixed rounded-lg shadow-[0_0_0_9999px_var(--tour-scrim)] ring-2 ring-ring transition-[top,left,width,height] duration-200 ease-out motion-reduce:transition-none motion-reduce:duration-0"
              style={{ top: drawn.top, left: drawn.left, width: drawn.width, height: drawn.height }}
            />
          ) : (
            <div aria-hidden="true" className="fixed inset-0 bg-[var(--tour-scrim)]" />
          )}
          <div
            ref={refs.setFloating}
            onKeyDown={onKeyDown}
            data-tour-card=""
            data-layout={
              props.searching ? 'searching' : docked ? 'sheet' : centered ? 'centered' : 'anchored'
            }
            className={cn(
              'grid gap-3 overflow-y-auto rounded-lg border bg-popover p-4 text-popover-foreground shadow-lg motion-reduce:duration-0 motion-reduce:**:transition-none motion-reduce:**:duration-0',
              docked
                ? 'fixed inset-x-4 bottom-4 max-h-[calc(100dvh-2rem)] pb-[max(1rem,env(safe-area-inset-bottom))]'
                : 'w-[min(22rem,calc(100vw-2rem))]',
              centered &&
                'fixed top-1/2 left-1/2 max-h-[calc(100dvh-2rem)] -translate-x-1/2 -translate-y-1/2',
              anchored &&
                !docked &&
                !centered &&
                'transition-opacity duration-150 motion-reduce:transition-none motion-reduce:duration-0',
              anchored && !docked && !centered && !isPositioned && 'opacity-0',
              props.searching && 'invisible',
            )}
            style={anchored && !docked && !centered ? floatingStyles : undefined}
          >
            {anchored && !docked && !centered ? (
              <div
                ref={arrowRef}
                aria-hidden="true"
                className={cn(
                  'absolute size-2 rotate-45 border bg-popover',
                  arrowSide === 'top' && 'border-r-0 border-b-0',
                  arrowSide === 'bottom' && 'border-t-0 border-l-0',
                  arrowSide === 'left' && 'border-t-0 border-r-0',
                  arrowSide === 'right' && 'border-b-0 border-l-0',
                )}
                style={{
                  left: middlewareData.arrow?.x,
                  top: middlewareData.arrow?.y,
                  [arrowSide ?? 'top']: -5,
                }}
              />
            ) : null}
            <div className="flex items-center justify-between gap-2">
              {props.step === null ? (
                <span />
              ) : (
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-muted-foreground">
                    Step {props.step} of {STEP_COUNT}
                  </span>
                  <span aria-hidden="true" className="flex gap-1">
                    {Array.from({ length: STEP_COUNT }, (_, i) => (
                      <span
                        key={i}
                        className={cn(
                          'size-1.5 rounded-full',
                          i + 1 === props.step ? 'bg-primary' : 'bg-muted-foreground/40',
                        )}
                      />
                    ))}
                  </span>
                </div>
              )}
              <button
                type="button"
                aria-label="Close tour"
                disabled={props.busy}
                onClick={props.onSkip}
                className="-m-1 flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:size-11"
              >
                <X className="size-4" aria-hidden="true" />
              </button>
            </div>
            <h2 id={titleId} className="text-base font-semibold [overflow-wrap:anywhere]">
              {props.step === null ? null : (
                <span className="sr-only">
                  Step {props.step} of {STEP_COUNT}:{' '}
                </span>
              )}
              {props.title}
            </h2>
            <p id={bodyId} className="text-sm text-muted-foreground [overflow-wrap:anywhere]">
              {props.body}
            </p>
            {props.extra}
            {docked && hidden && target !== null ? (
              <button
                type="button"
                className="justify-self-start text-sm text-primary underline underline-offset-2"
                onClick={() => target.scrollIntoView({ block: 'center', behavior: 'instant' })}
              >
                Show me
              </button>
            ) : null}
            <div className="flex flex-wrap items-center justify-end gap-2 [&_button]:pointer-coarse:h-11">
              {props.actions.map((a) => (
                <Button
                  key={a.label}
                  ref={a.initialFocus === true ? primaryRef : undefined}
                  variant={a.variant}
                  disabled={props.busy}
                  onClick={a.onClick}
                >
                  {a.label}
                </Button>
              ))}
            </div>
            {props.step === null ? null : (
              <button
                type="button"
                disabled={props.busy}
                onClick={props.onSkip}
                className="justify-self-start text-sm text-muted-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11"
              >
                {props.skipLabel ?? 'Skip tour'}
              </button>
            )}
          </div>
        </>
      ) : null}
    </dialog>
  );
}
