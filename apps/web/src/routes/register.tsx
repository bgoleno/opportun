import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { AuthLayout } from '@/components/AuthLayout';
import { FormError } from '@/components/FormError';
import { FormField } from '@/components/FormField';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ApiError, errorMessage } from '@/lib/api';
import { PASSWORD_MIN, register, RegisterSchema, type RegisterInput } from '@/lib/auth';

export const Route = createFileRoute('/register')({
  component: RegisterPage,
});

function registerError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'registration_closed') {
      return 'Registration is closed on this instance. Ask the administrator to open it.';
    }
    if (err.code === 'email_taken') return 'An account with that email already exists.';
  }
  return errorMessage(err);
}

function RegisterPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [formError, setFormError] = useState<string | null>(null);
  const form = useForm<RegisterInput>({
    resolver: zodResolver(RegisterSchema),
    defaultValues: { displayName: '', email: '', password: '', confirm: '' },
  });
  const { errors, isSubmitting } = form.formState;

  const onSubmit = form.handleSubmit(async (values) => {
    setFormError(null);
    try {
      await register(qc, values);
      await navigate({ to: '/', replace: true });
    } catch (err) {
      setFormError(registerError(err));
    }
  });

  return (
    <AuthLayout
      title="Create account"
      description="The first account on an instance becomes its administrator."
      footer={
        <>
          Already have an account?{' '}
          <Link to="/login" className="font-medium text-primary underline-offset-4 hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      <form onSubmit={onSubmit} noValidate className="grid gap-4">
        <FormError message={formError} />
        <FormField label="Name" error={errors.displayName?.message}>
          {(p) => <Input {...p} autoComplete="name" {...form.register('displayName')} />}
        </FormField>
        <FormField label="Email" error={errors.email?.message}>
          {(p) => <Input {...p} type="email" autoComplete="email" {...form.register('email')} />}
        </FormField>
        <FormField
          label="Password"
          error={errors.password?.message}
          hint={`At least ${PASSWORD_MIN} characters.`}
        >
          {(p) => (
            <Input
              {...p}
              type="password"
              autoComplete="new-password"
              {...form.register('password')}
            />
          )}
        </FormField>
        <FormField label="Confirm password" error={errors.confirm?.message}>
          {(p) => (
            <Input
              {...p}
              type="password"
              autoComplete="new-password"
              {...form.register('confirm')}
            />
          )}
        </FormField>
        <Button type="submit" className="w-full" disabled={isSubmitting}>
          {isSubmitting ? 'Creating account...' : 'Create account'}
        </Button>
      </form>
    </AuthLayout>
  );
}
