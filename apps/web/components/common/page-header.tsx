import type { ReactNode } from 'react';

interface PageHeaderProps {
  title: string;
  subtitle?: ReactNode;
  /** Right-aligned actions (buttons, links). */
  actions?: ReactNode;
}

/** Page title block with an optional subtitle and right-aligned actions. */
export function PageHeader({ title, subtitle, actions }: PageHeaderProps) {
  return (
    <header className="flex items-center justify-between">
      <div>
        <h1 className="text-2xl font-bold">{title}</h1>
        {subtitle ? <p className="text-sm text-muted-foreground">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex gap-2">{actions}</div> : null}
    </header>
  );
}
