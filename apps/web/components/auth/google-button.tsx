import { Button } from '@/components/ui/button';

interface GoogleButtonProps {
  href?: string;
}

/** "Continue with Google" — links to the backend OAuth entry point. */
export function GoogleButton({ href = '/api/auth/google' }: GoogleButtonProps) {
  return (
    <Button asChild variant="outline" className="w-full">
      <a href={href}>Continue with Google</a>
    </Button>
  );
}
