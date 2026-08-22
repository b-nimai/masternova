'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useForm, type UseFormReturn } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import { registerSchema } from '@masternova/shared';
import { api, ApiError } from '@/lib/api';

export type AuthMode = 'login' | 'register';

// registerSchema is a superset of loginSchema (name optional), so it validates both modes.
const formSchema = registerSchema;
export type AuthFormValues = z.infer<typeof formSchema>;

interface UseAuthForm {
  form: UseFormReturn<AuthFormValues>;
  mode: AuthMode;
  serverError: string | null;
  submit: (values: AuthFormValues) => Promise<void>;
  toggleMode: () => void;
}

/** Login/register form state: RHF setup, submit against the API, and mode toggle. */
export function useAuthForm(): UseAuthForm {
  const router = useRouter();
  const [mode, setMode] = useState<AuthMode>('login');
  const [serverError, setServerError] = useState<string | null>(null);

  const form = useForm<AuthFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { email: '', password: '', name: '' },
  });

  async function submit(values: AuthFormValues): Promise<void> {
    setServerError(null);
    try {
      if (mode === 'login') {
        await api.login({ email: values.email, password: values.password });
      } else {
        await api.register(values);
      }
      router.push('/dashboard');
    } catch (err) {
      setServerError(err instanceof ApiError ? err.message : 'Something went wrong');
    }
  }

  function toggleMode(): void {
    setServerError(null);
    setMode((m) => (m === 'login' ? 'register' : 'login'));
  }

  return { form, mode, serverError, submit, toggleMode };
}
