// Vendored from shadcn/ui's native-select (MIT). See README.md in this folder: a native
// <select> is used because Radix Select injects a <style> tag the CSP blocks.
import { ChevronDown } from 'lucide-react';
import type * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * `className` sizes the whole control, so it goes on the wrapper, which the select fills. The chevron
 * is placed against the wrapper: with a width on the select alone, or a wrapper stretched by a taller
 * neighbour (hence `h-fit`), it was drawn outside the select
 * (https://github.com/bgoleno/opportun/issues/909).
 */
function Select({ className, children, ...props }: React.ComponentProps<'select'>) {
  return (
    <div data-slot="select-wrapper" className={cn('relative h-fit w-full', className)}>
      <select
        data-slot="select"
        className="flex h-9 w-full cursor-pointer appearance-none rounded-md border border-input bg-card py-1 pr-9 pl-3 text-sm text-foreground shadow-xs transition-colors outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive"
        {...props}
      >
        {children}
      </select>
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted-foreground"
      />
    </div>
  );
}

export { Select };
