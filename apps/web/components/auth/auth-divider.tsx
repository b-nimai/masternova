interface AuthDividerProps {
  label?: string;
}

/** Horizontal "or" separator between the form and alternate sign-in methods. */
export function AuthDivider({ label = 'or' }: AuthDividerProps) {
  return (
    <div className="my-4 flex items-center gap-2 text-xs text-muted-foreground">
      <span className="h-px flex-1 bg-border" />
      {label}
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}
