// Adapted from shadcn/ui's Toast (MIT). See README.md in this folder: Radix Toast with a
// tiny module-level store (sonner is not used because it injects a stylesheet at runtime).
import { X } from 'lucide-react';
import { Toast as ToastPrimitive } from 'radix-ui';
import { useSyncExternalStore } from 'react';
import { cn } from '@/lib/utils';

export interface ToastInput {
  title: string;
  description?: string;
  variant?: 'default' | 'destructive' | 'success';
  /** A single action offered from the toast itself (#184: undo a bulk dismiss). Bumps the
   *  default auto-dismiss duration, since an action needs more time to act on than reading. */
  action?: { label: string; onClick: () => void };
}

interface ToastItem extends ToastInput {
  id: number;
}

let items: ToastItem[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const MAX_TOASTS = 3;

function emit(): void {
  listeners.forEach((l) => l());
}

/** Shows a toast. Announced politely to screen readers (destructive ones assertively). */
export function toast(input: ToastInput): void {
  items = [...items, { ...input, id: nextId++ }].slice(-MAX_TOASTS);
  emit();
}

function dismiss(id: number): void {
  items = items.filter((t) => t.id !== id);
  emit();
}

/** Clears every toast. The store is module-level, outside any component's lifecycle, so a
 *  toast raised in one test is otherwise still sitting in `items` (up to MAX_TOASTS) when the
 *  next test's <Toaster/> mounts; call this from a global test setup's afterEach. */
export function resetToasts(): void {
  items = [];
  emit();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const variantClass = {
  default: 'border bg-popover text-popover-foreground',
  destructive: 'border-destructive bg-destructive text-destructive-foreground',
  success: 'border bg-popover text-popover-foreground border-l-4 border-l-success',
} as const;

export function Toaster() {
  const list = useSyncExternalStore(
    subscribe,
    () => items,
    () => items,
  );
  return (
    <ToastPrimitive.Provider swipeDirection="right" duration={5000}>
      {list.map((t) => (
        <ToastPrimitive.Root
          key={t.id}
          type={t.variant === 'destructive' ? 'foreground' : 'background'}
          duration={t.action !== undefined ? 8000 : undefined}
          onOpenChange={(open) => {
            if (!open) dismiss(t.id);
          }}
          className={cn(
            'relative flex w-full items-start gap-3 rounded-lg p-4 pr-10 shadow-lg',
            variantClass[t.variant ?? 'default'],
          )}
        >
          <div className="grid flex-1 gap-1">
            <ToastPrimitive.Title className="text-sm font-semibold">{t.title}</ToastPrimitive.Title>
            {t.description ? (
              <ToastPrimitive.Description className="text-sm opacity-90">
                {t.description}
              </ToastPrimitive.Description>
            ) : null}
          </div>
          {t.action ? (
            <ToastPrimitive.Action
              altText={t.action.label}
              onClick={t.action.onClick}
              className="shrink-0 cursor-pointer rounded-md border px-2 py-1 text-xs font-medium underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            >
              {t.action.label}
            </ToastPrimitive.Action>
          ) : null}
          <ToastPrimitive.Close
            // Not "Dismiss": the app already uses that word for a domain action (dismissing a
            // discovery result or opportunity, #184 adding a bulk version of it too), and a
            // toast with an action button sits right next to this close button, so the two
            // "Dismiss"es would collide for anyone navigating by accessible name.
            aria-label="Dismiss notification"
            className="absolute top-3 right-3 cursor-pointer rounded-sm opacity-70 outline-none hover:opacity-100 focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="size-4" aria-hidden="true" />
          </ToastPrimitive.Close>
        </ToastPrimitive.Root>
      ))}
      <ToastPrimitive.Viewport className="fixed right-0 bottom-0 z-[100] flex max-h-screen w-full flex-col gap-2 p-4 outline-none sm:max-w-sm" />
    </ToastPrimitive.Provider>
  );
}
