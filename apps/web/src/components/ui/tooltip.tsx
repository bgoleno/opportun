// Vendored from shadcn/ui (MIT). See README.md in this folder. Unlike Dialog and Select,
// Radix Tooltip needs no CSP adaptation: it positions itself with an inline style property
// set via the DOM (CSSOM), not an injected <style> element, so default-src 'self' never sees
// it. Each Tooltip carries its own Provider rather than relying on one mounted at the app
// root, so it works the same way in an isolated component test as it does inside AppShell.
import { Tooltip as TooltipPrimitive } from 'radix-ui';
import type * as React from 'react';
import { cn } from '@/lib/utils';

// #138: short on purpose. A destructive control is exactly where a slow-to-appear label
// costs the most, and one delay app-wide (rather than a shorter one for delete/detach/
// reject/purge specifically) keeps neighboring icons from feeling inconsistent with each
// other.
const DELAY_MS = 150;

function Tooltip({
  delayDuration = DELAY_MS,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  return (
    <TooltipPrimitive.Provider delayDuration={delayDuration}>
      <TooltipPrimitive.Root data-slot="tooltip" {...props} />
    </TooltipPrimitive.Provider>
  );
}

function TooltipTrigger(props: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

function TooltipContent({
  className,
  sideOffset = 6,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          'z-50 rounded-md bg-foreground px-2.5 py-1 text-xs text-background shadow-md',
          className,
        )}
        {...props}
      >
        {children}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}

export { Tooltip, TooltipContent, TooltipTrigger };
