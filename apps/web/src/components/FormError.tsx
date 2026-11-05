import { cn } from '@/lib/utils';

/**
 * Form-level error (server rejection), announced to screen readers. It wraps anywhere, because a
 * message can hold something the user named, such as one long unbroken filename, and that must not
 * widen a phone-width page (qa on https://github.com/bgoleno/opportun/pull/281).
 */
export function FormError({ message, className }: { message: string | null; className?: string }) {
  if (message === null) return null;
  return (
    <p
      role="alert"
      className={cn(
        'rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive [overflow-wrap:anywhere]',
        className,
      )}
    >
      {message}
    </p>
  );
}
