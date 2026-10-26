// A second-factor entry form: a 6-digit authenticator code, or (toggle) a recovery code.
// Used by the sign-in code step and by turning two-factor off.
import { useState, type FormEvent, type ReactNode } from 'react';
import { FormError } from '@/components/FormError';
import { FormField } from '@/components/FormField';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { RecoveryCodeSchema, TotpCodeSchema } from '@/lib/auth';

export type SecondFactor = { code: string } | { recoveryCode: string };

export function SecondFactorForm(props: {
  submitLabel: string;
  busyLabel: string;
  submitVariant?: 'default' | 'destructive';
  /** A server rejection to show above the field (null when none). */
  error: string | null;
  onSubmit: (factor: SecondFactor) => Promise<void>;
  /** Extra fields rendered above the code (e.g. the current password). */
  children?: ReactNode;
}) {
  const [useRecovery, setUseRecovery] = useState(false);
  const [value, setValue] = useState('');
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const parsed = (useRecovery ? RecoveryCodeSchema : TotpCodeSchema).safeParse(value);
    if (!parsed.success) {
      setFieldError(parsed.error.issues[0]?.message ?? 'Check the code');
      return;
    }
    setFieldError(undefined);
    setBusy(true);
    try {
      await props.onSubmit(useRecovery ? { recoveryCode: parsed.data } : { code: parsed.data });
    } finally {
      setBusy(false);
    }
  }

  function toggle() {
    setUseRecovery((v) => !v);
    setValue('');
    setFieldError(undefined);
  }

  return (
    <form onSubmit={(e) => void submit(e)} noValidate className="grid gap-4">
      <FormError message={props.error} />
      {props.children}
      {useRecovery ? (
        <FormField
          key="recovery"
          label="Recovery code"
          error={fieldError}
          hint="Each recovery code works once."
        >
          {(p) => (
            <Input
              {...p}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              className="font-mono"
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          )}
        </FormField>
      ) : (
        <FormField key="totp" label="Authentication code" error={fieldError}>
          {(p) => (
            <Input
              {...p}
              autoComplete="one-time-code"
              inputMode="numeric"
              className="font-mono tracking-widest"
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          )}
        </FormField>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button type="button" variant="link" className="h-auto px-0" onClick={toggle}>
          {useRecovery ? 'Use your authenticator app' : 'Use a recovery code'}
        </Button>
        <Button type="submit" variant={props.submitVariant ?? 'default'} disabled={busy}>
          {busy ? props.busyLabel : props.submitLabel}
        </Button>
      </div>
    </form>
  );
}

/** Human text for a rejected code (server codes invalid_code, rate_limited). */
export const INVALID_CODE_TEXT =
  "That code is not valid. Check that your device's clock is right, or use a recovery code.";
