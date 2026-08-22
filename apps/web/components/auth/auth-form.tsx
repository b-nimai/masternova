'use client';

import type { UseFormReturn } from 'react-hook-form';
import { Form } from '@/components/ui/form';
import { TextField } from '@/components/common/text-field';
import { SubmitButton } from '@/components/common/submit-button';
import { AuthDivider } from './auth-divider';
import { GoogleButton } from './google-button';
import type { AuthFormValues, AuthMode } from '@/hooks/use-auth-form';

interface AuthFormProps {
  form: UseFormReturn<AuthFormValues>;
  mode: AuthMode;
  serverError: string | null;
  googleEnabled: boolean;
  onSubmit: (values: AuthFormValues) => void | Promise<void>;
  onToggleMode: () => void;
}

/** Login/register form: name (register only), email, password, submit, Google, mode toggle. */
export function AuthForm({
  form,
  mode,
  serverError,
  googleEnabled,
  onSubmit,
  onToggleMode,
}: AuthFormProps) {
  return (
    <>
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          {mode === 'register' && (
            <TextField control={form.control} name="name" label="Name" placeholder="Ada Lovelace" />
          )}
          <TextField
            control={form.control}
            name="email"
            label="Email"
            type="email"
            placeholder="you@example.com"
          />
          <TextField control={form.control} name="password" label="Password" type="password" />

          {serverError && <p className="text-sm text-destructive">{serverError}</p>}

          <SubmitButton
            pending={form.formState.isSubmitting}
            className="w-full"
            pendingLabel="Please wait…"
          >
            {mode === 'login' ? 'Log in' : 'Sign up'}
          </SubmitButton>
        </form>
      </Form>

      {googleEnabled && (
        <>
          <AuthDivider />
          <GoogleButton />
        </>
      )}

      <button
        type="button"
        onClick={onToggleMode}
        className="mt-4 w-full text-center text-sm text-muted-foreground hover:underline"
      >
        {mode === 'login' ? "Don't have an account? Sign up" : 'Already have an account? Log in'}
      </button>
    </>
  );
}
