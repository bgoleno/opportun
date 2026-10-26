import { useId, type ReactElement, type ReactNode } from 'react';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

interface ControlProps {
  id: string;
  'aria-invalid': boolean;
  'aria-describedby'?: string;
}

/**
 * Label, control and error message wired together: the label targets the control's id and
 * the error is linked through aria-describedby.
 */
export function FormField(props: {
  label: string;
  error?: string | undefined;
  hint?: string;
  className?: string;
  children: (control: ControlProps) => ReactElement;
  labelSuffix?: ReactNode;
}) {
  const id = useId();
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  const describedBy =
    [props.error ? errorId : null, props.hint ? hintId : null].filter(Boolean).join(' ') ||
    undefined;
  return (
    <div className={cn('grid gap-1.5', props.className)}>
      <Label htmlFor={id}>
        {props.label}
        {props.labelSuffix}
      </Label>
      {props.children({
        id,
        'aria-invalid': props.error !== undefined,
        ...(describedBy === undefined ? {} : { 'aria-describedby': describedBy }),
      })}
      {props.hint ? (
        <p id={hintId} className="text-xs text-muted-foreground">
          {props.hint}
        </p>
      ) : null}
      {props.error ? (
        <p id={errorId} role="alert" className="text-sm text-destructive">
          {props.error}
        </p>
      ) : null}
    </div>
  );
}
