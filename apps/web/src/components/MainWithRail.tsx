import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * A main column with a side rail beside it from `lg`, stacked below that (docs/design.md
 * section 9, "Layout widths"). Every main-plus-rail view uses this, so the rail is one width
 * everywhere: the --container-rail token, set in index.css and nowhere else (issue
 * https://github.com/bgoleno/opportun/issues/34). The main track is minmax(0, 1fr), not 1fr, so
 * long unbreakable content in the main column cannot widen it and squeeze the rail. Children are
 * the main column first, then the rail.
 */
export function MainWithRail({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      data-slot="main-with-rail"
      className={cn(
        'grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_var(--container-rail)]',
        className,
      )}
    >
      {children}
    </div>
  );
}
