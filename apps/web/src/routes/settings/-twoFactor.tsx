// Settings > Security: optional TOTP two-factor sign-in (FR-S3). Enrollment shows the QR the
// server rendered (a data: URL; the CSP allows data: images for exactly this) and the setup
// key, then the recovery codes exactly once.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { INVALID_CODE_TEXT, SecondFactorForm } from '@/components/auth/SecondFactorForm';
import { FormError } from '@/components/FormError';
import { FormField } from '@/components/FormField';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';
import { api, ApiError, errorMessage } from '@/lib/api';
import { TotpCodeSchema } from '@/lib/auth';

interface TwoFactorStatus {
  enabled: boolean;
  recoveryCodesLeft: number;
  /** False for an account created by OAuth sign-in that has not set a password yet. */
  hasPassword?: boolean;
}
interface Enrollment {
  secret: string;
  otpauthUrl: string;
  qrDataUrl: string;
}

export const twoFactorQuery = {
  queryKey: ['auth', '2fa'] as const,
  queryFn: () => api<TwoFactorStatus>('/auth/2fa'),
};

/** "ABCDEFGHIJ" as "ABCDE-FGHIJ": easier to read back and type. */
export function formatRecoveryCode(code: string): string {
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

function codeError(err: unknown): string {
  return err instanceof ApiError && err.code === 'invalid_code'
    ? INVALID_CODE_TEXT
    : errorMessage(err);
}

export function TwoFactorCard() {
  const qc = useQueryClient();
  const status = useQuery(twoFactorQuery);
  const [enrollment, setEnrollment] = useState<(Enrollment & { password: string }) | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [disabling, setDisabling] = useState(false);

  const data = status.data;
  const enabled = data?.enabled === true;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Two-factor sign-in
          {status.data === undefined ? null : enabled ? (
            <Badge variant="success">On</Badge>
          ) : (
            <Badge variant="secondary">Off</Badge>
          )}
        </CardTitle>
        <CardDescription>
          After your password, sign-in asks for a code from an authenticator app (1Password, Google
          Authenticator, Authy and similar).
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {status.isError ? <FormError message={errorMessage(status.error)} /> : null}
        {enabled ? (
          <>
            <p className="text-sm text-muted-foreground">
              {data?.recoveryCodesLeft ?? 0} recovery codes left. If you lose your phone and every
              recovery code, an administrator can reset your password, which also turns this off.
            </p>
            <div>
              <Button variant="outline" onClick={() => setDisabling(true)}>
                Turn off
              </Button>
            </div>
          </>
        ) : status.data !== undefined ? (
          <>
            {status.data.hasPassword === false ? (
              <p className="text-sm text-muted-foreground">
                Set a password first: turning this on asks for it.
              </p>
            ) : null}
            <div>
              <Button
                disabled={status.data.hasPassword === false}
                onClick={() => setConfirming(true)}
              >
                Enable two-factor
              </Button>
            </div>
          </>
        ) : null}
      </CardContent>
      <PasswordDialog
        open={confirming}
        onOpenChange={setConfirming}
        description="Setting up two-factor sign-in changes how you sign in, so confirm it is you."
        onConfirm={async (password) => {
          try {
            const res = await api<Enrollment>('/auth/2fa/enroll', {
              method: 'POST',
              body: { password },
            });
            setConfirming(false);
            setEnrollment({ ...res, password });
            return null;
          } catch (err) {
            if (err instanceof ApiError && err.code === 'already_enabled') {
              void qc.invalidateQueries({ queryKey: twoFactorQuery.queryKey });
              return 'Two-factor sign-in is already on.';
            }
            return passwordError(err);
          }
        }}
      />
      {enrollment === null ? null : (
        <EnrollDialog
          enrollment={enrollment}
          onDone={() => {
            setEnrollment(null);
            void qc.invalidateQueries({ queryKey: twoFactorQuery.queryKey });
          }}
        />
      )}
      <DisableDialog
        open={disabling}
        onOpenChange={setDisabling}
        onDisabled={() => {
          setDisabling(false);
          void qc.invalidateQueries({ queryKey: twoFactorQuery.queryKey });
          toast({ title: 'Two-factor sign-in turned off', variant: 'success' });
        }}
      />
    </Card>
  );
}

export function passwordError(err: unknown): string {
  return err instanceof ApiError && err.code === 'invalid_password'
    ? 'That is not your current password.'
    : errorMessage(err);
}

/** Asks for the current password (the server requires it for credential changes). */
export function PasswordDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  description: string;
  /** Resolves to an error message to show, or null on success. */
  onConfirm: (password: string) => Promise<string | null>;
}) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password.length === 0) {
      setError('Enter your current password.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const message = await props.onConfirm(password);
      if (message !== null) setError(message);
      else setPassword('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) {
          setPassword('');
          setError(null);
        }
        props.onOpenChange(open);
      }}
    >
      <DialogContent className="max-w-md">
        <form onSubmit={(e) => void submit(e)} noValidate className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Confirm your password</DialogTitle>
            <DialogDescription>{props.description}</DialogDescription>
          </DialogHeader>
          <FormError message={error} />
          <FormField label="Current password">
            {(p) => (
              <Input
                {...p}
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            )}
          </FormField>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => props.onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? 'Checking...' : 'Continue'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EnrollDialog(props: {
  enrollment: Enrollment & { password: string };
  onDone: () => void;
}) {
  const { enrollment } = props;
  const [code, setCode] = useState('');
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Set once activation succeeds: the only time these are ever visible. */
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);

  async function activate(e: FormEvent) {
    e.preventDefault();
    const parsed = TotpCodeSchema.safeParse(code);
    if (!parsed.success) {
      setFieldError(parsed.error.issues[0]?.message);
      return;
    }
    setFieldError(undefined);
    setError(null);
    setBusy(true);
    try {
      const res = await api<{ recoveryCodes: string[] }>('/auth/2fa/activate', {
        method: 'POST',
        body: { code: parsed.data, password: enrollment.password },
      });
      setRecoveryCodes(res.recoveryCodes);
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === 'invalid_password'
          ? passwordError(err)
          : codeError(err),
      );
    } finally {
      setBusy(false);
    }
  }

  async function copy(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast({ title: `${what} copied`, variant: 'success' });
    } catch {
      toast({ title: 'Copy failed', description: 'Select the text and copy it instead.' });
    }
  }

  const formatted = recoveryCodes?.map(formatRecoveryCode) ?? [];
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        // The codes are shown once: closing is only through "I saved them".
        if (!open && recoveryCodes === null) props.onDone();
      }}
    >
      <DialogContent className="max-w-md" showClose={recoveryCodes === null}>
        {recoveryCodes === null ? (
          <form onSubmit={(e) => void activate(e)} noValidate className="grid gap-4">
            <DialogHeader>
              <DialogTitle>Set up two-factor sign-in</DialogTitle>
              <DialogDescription>
                Scan the QR code with your authenticator app, or enter the setup key by hand. Then
                type the 6-digit code it shows.
              </DialogDescription>
            </DialogHeader>
            <img
              src={enrollment.qrDataUrl}
              alt="QR code for your authenticator app"
              className="mx-auto size-48 rounded-md border bg-white p-2"
            />
            <FormField label="Setup key">
              {(p) => (
                <div className="flex gap-2">
                  <Input
                    {...p}
                    readOnly
                    value={enrollment.secret}
                    className="font-mono text-xs"
                    onFocus={(e) => e.currentTarget.select()}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-label="Copy setup key"
                    onClick={() => void copy(enrollment.secret, 'Setup key')}
                  >
                    <Copy className="size-4" aria-hidden="true" />
                    Copy
                  </Button>
                </div>
              )}
            </FormField>
            <FormError message={error} />
            <FormField label="Code from the app" error={fieldError}>
              {(p) => (
                <Input
                  {...p}
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  className="font-mono tracking-widest"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                />
              )}
            </FormField>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={props.onDone}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? 'Turning on...' : 'Turn on'}
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <div className="grid gap-4">
            <DialogHeader>
              <DialogTitle>Save your recovery codes</DialogTitle>
              <DialogDescription>
                Two-factor sign-in is on. If you lose your authenticator, each of these codes signs
                you in once. Store them somewhere safe, like a password manager: they will not be
                shown again.
              </DialogDescription>
            </DialogHeader>
            <ul
              aria-label="Recovery codes"
              className="grid grid-cols-2 gap-2 rounded-md border bg-muted/40 p-3 font-mono text-sm"
            >
              {formatted.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => void copy(formatted.join('\n'), 'Recovery codes')}
              >
                <Copy className="size-4" aria-hidden="true" />
                Copy codes
              </Button>
              <Button type="button" onClick={props.onDone}>
                I saved them
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function DisableDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDisabled: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) {
          setError(null);
          setPassword('');
        }
        props.onOpenChange(open);
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Turn off two-factor sign-in</DialogTitle>
          <DialogDescription>
            Confirm with your current password and a code from your authenticator app (or a recovery
            code). Your remaining recovery codes stop working.
          </DialogDescription>
        </DialogHeader>
        {props.open ? (
          <SecondFactorForm
            submitLabel="Turn off"
            busyLabel="Turning off..."
            submitVariant="destructive"
            error={error}
            onSubmit={async (factor) => {
              if (password.length === 0) {
                setError('Enter your current password.');
                return;
              }
              setError(null);
              try {
                await api('/auth/2fa/disable', {
                  method: 'POST',
                  body: { ...factor, password },
                });
                setPassword('');
                props.onDisabled();
              } catch (err) {
                setError(
                  err instanceof ApiError && err.code === 'invalid_password'
                    ? passwordError(err)
                    : codeError(err),
                );
              }
            }}
          >
            <FormField label="Current password">
              {(p) => (
                <Input
                  {...p}
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              )}
            </FormField>
          </SecondFactorForm>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
