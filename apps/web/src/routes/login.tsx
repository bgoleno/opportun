import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { AuthLayout } from '@/components/AuthLayout';
import { OAuthButtons } from '@/components/auth/OAuthButtons';
import { TwoFactorStep } from '@/components/auth/TwoFactorStep';
import { FormError } from '@/components/FormError';
import { FormField } from '@/components/FormField';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ApiError, errorMessage } from '@/lib/api';
import {
  login,
  LoginSchema,
  registrationOpenQuery,
  safeRedirect,
  type LoginInput,
} from '@/lib/auth';
import { oauthFlashMessage, takePendingFromHash } from '@/lib/oauth';

export const Route = createFileRoute('/login')({
  validateSearch: z.object({
    redirect: z.string().optional().catch(undefined),
    /** The result of an OAuth sign-in that did not end in a session. */
    oauth: z.string().max(32).optional().catch(undefined),
  }),
  component: LoginPage,
});

function loginError(err: unknown): string {
  if (err instanceof ApiError && err.code === 'invalid_credentials') {
    return 'Email or password is incorrect.';
  }
  return errorMessage(err);
}

function LoginPage() {
  const { redirect, oauth } = Route.useSearch();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const registrationOpen = useQuery(registrationOpenQuery);
  const [formError, setFormError] = useState<string | null>(() => oauthFlashMessage(oauth));
  /**
   * Set when the first factor passed and the account wants a second one: from the password
   * form, or from an OAuth sign-in that landed here with the token in the fragment.
   */
  const [pendingToken, setPendingToken] = useState<string | null>(takePendingFromHash);
  const form = useForm<LoginInput>({
    resolver: zodResolver(LoginSchema),
    defaultValues: { email: '', password: '' },
  });
  const { errors, isSubmitting } = form.formState;

  const onSubmit = form.handleSubmit(async (values) => {
    setFormError(null);
    try {
      const result = await login(qc, values);
      if (result.kind === 'twoFactor') {
        setPendingToken(result.pendingToken);
        return;
      }
      await navigate({ href: safeRedirect(redirect), replace: true });
    } catch (err) {
      setFormError(loginError(err));
    }
  });

  if (pendingToken !== null) {
    return (
      <AuthLayout
        title="Two-factor sign-in"
        description="One more step to confirm it is you."
        footer={
          <button
            type="button"
            className="font-medium text-primary underline-offset-4 hover:underline"
            onClick={() => setPendingToken(null)}
          >
            Back to password
          </button>
        }
      >
        <TwoFactorStep
          pendingToken={pendingToken}
          onSignedIn={() => navigate({ href: safeRedirect(redirect), replace: true })}
          onRestart={(message) => {
            setPendingToken(null);
            form.setValue('password', '');
            setFormError(message);
          }}
        />
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Sign in"
      description="Welcome back. Sign in to your job search workspace."
      // Shown only once GET /auth/registration says a registration could actually succeed
      // (true for first-run bootstrapping, false on a closed, populated instance like the
      // invitation-only demo): a demo acceptance run found this link offered unconditionally,
      // which is actively wrong once an instance already has accounts. Nothing while the
      // query is loading or has failed, same as offering nothing beats offering a dead end.
      footer={
        registrationOpen.data === true ? (
          <>
            New instance?{' '}
            <Link
              to="/register"
              className="font-medium text-primary underline-offset-4 hover:underline"
            >
              Create the first account
            </Link>
          </>
        ) : undefined
      }
    >
      <form onSubmit={onSubmit} noValidate className="grid gap-4">
        <FormError message={formError} />
        <FormField label="Email" error={errors.email?.message}>
          {(p) => <Input {...p} type="email" autoComplete="username" {...form.register('email')} />}
        </FormField>
        <FormField label="Password" error={errors.password?.message}>
          {(p) => (
            <Input
              {...p}
              type="password"
              autoComplete="current-password"
              {...form.register('password')}
            />
          )}
        </FormField>
        <Button type="submit" className="w-full" disabled={isSubmitting}>
          {isSubmitting ? 'Signing in...' : 'Sign in'}
        </Button>
      </form>
      <div className="mt-4">
        <OAuthButtons />
      </div>
    </AuthLayout>
  );
}
