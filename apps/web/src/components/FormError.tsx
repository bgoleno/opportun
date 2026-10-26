import { cn } from '@/lib/utils';

/** Form-level error (server rejection), announced to screen readers. */
export function FormError({ message, className }: { message: string | null; className?: string }) {
  if (message === null) return null;
  return (
    <p
      role="alert"
      className={cn(
        'rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive',
        className,
      )}
    >
      {message}
    </p>
  );
}
