// Vendored from shadcn/ui's native-select (MIT). See README.md in this folder: a native
// <select> is used because Radix Select injects a <style> tag the CSP blocks.
import { ChevronDown } from 'lucide-react';
import type * as React from 'react';
import { cn } from '@/lib/utils';

function Select({ className, children, ...props }: React.ComponentProps<'select'>) {
  return (
    <div data-slot="select-wrapper" className="relative w-full">
      <select
        data-slot="select"
        className={cn(
          'flex h-9 w-full cursor-pointer appearance-none rounded-md border border-input bg-card py-1 pr-9 pl-3 text-sm text-foreground shadow-xs transition-colors outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive',
          className,
        )}
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
