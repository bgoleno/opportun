// Sign-in, second step (FR-S3): the password was right and the account has two-factor on, so
// the server handed back a short-lived pending token instead of a session.
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError, errorMessage } from '@/lib/api';
import { verifyTwoFactor } from '@/lib/auth';
import { INVALID_CODE_TEXT, SecondFactorForm } from './SecondFactorForm';

export function TwoFactorStep(props: {
  pendingToken: string;
  onSignedIn: () => Promise<void> | void;
  /** Back to the password form (the pending token expired or was spent), with a message. */
  onRestart: (message: string) => void;
}) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="grid gap-4">
      <p className="text-sm text-muted-foreground">
        Enter the 6-digit code from your authenticator app.
      </p>
      <SecondFactorForm
        submitLabel="Verify"
        busyLabel="Verifying..."
        error={error}
        onSubmit={async (factor) => {
          setError(null);
          try {
            await verifyTwoFactor(qc, { pendingToken: props.pendingToken, ...factor });
            await props.onSignedIn();
          } catch (err) {
            // A password change or reset since the password step ended the sign-in (#662): not
            // a matter of time, so it is not said to be one.
            if (err instanceof ApiError && err.code === 'password_changed') {
              props.onRestart(
                'Your password was changed while you were signing in. Sign in again with your new password.',
              );
              return;
            }
            if (
              err instanceof ApiError &&
              (err.code === 'invalid_pending' || err.code === 'token_used')
            ) {
              props.onRestart('That sign-in took too long. Enter your password again.');
              return;
            }
            setError(
              err instanceof ApiError && err.code === 'invalid_code'
                ? INVALID_CODE_TEXT
                : errorMessage(err),
            );
          }
        }}
      />
    </div>
  );
}
