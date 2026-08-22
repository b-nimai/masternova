import type { ReactNode } from 'react';

interface EmptyStateProps {
  children: ReactNode;
}

/** Muted, centered placeholder for empty lists/sections. */
export function EmptyState({ children }: EmptyStateProps) {
  return <p className="py-12 text-center text-muted-foreground">{children}</p>;
}
