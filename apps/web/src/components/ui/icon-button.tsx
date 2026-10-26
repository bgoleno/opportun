// App-specific, not vendored from shadcn: an icon-only Button wrapped in a Tooltip whose
// text comes from the same `label` prop as the button's own aria-label (#138). The two
// cannot drift apart, because there is only one string to write.
import type * as React from 'react';
import { Button } from './button';
import { Tooltip, TooltipContent, TooltipTrigger } from './tooltip';

export interface IconButtonProps extends Omit<
  React.ComponentProps<typeof Button>,
  'size' | 'aria-label'
> {
  /** Both the accessible name (aria-label) and the hover/focus tooltip text. */
  label: string;
}

function IconButton({ label, ...props }: IconButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button size="icon" aria-label={label} {...props} />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export { IconButton };
