import type { ReactNode } from 'react';
import { Button, type ButtonProps } from '@/components/ui/button';

interface SubmitButtonProps extends Omit<ButtonProps, 'type' | 'disabled'> {
  pending: boolean;
  /** Shown while pending. */
  pendingLabel?: ReactNode;
  /** Idle label. */
  children: ReactNode;
}

/** Submit button that shows a pending label and disables itself while busy. */
export function SubmitButton({
  pending,
  pendingLabel = 'Please wait…',
  children,
  ...props
}: SubmitButtonProps) {
  return (
    <Button type="submit" disabled={pending} {...props}>
      {pending ? pendingLabel : children}
    </Button>
  );
}
