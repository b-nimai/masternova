interface LoadingScreenProps {
  label?: string;
}

/** Full-height centered loading state. */
export function LoadingScreen({ label = 'Loading…' }: LoadingScreenProps) {
  return (
    <main className="flex min-h-screen items-center justify-center text-muted-foreground">
      {label}
    </main>
  );
}
