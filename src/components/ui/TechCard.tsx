import { clsx } from 'clsx';
import type { ReactNode } from 'react';

export function TechCard({
  children,
  className,
  title,
  subtitle,
}: {
  children: ReactNode;
  className?: string;
  title?: ReactNode;
  subtitle?: ReactNode;
}) {
  return (
    <div className={clsx('shine-border tech-card flex flex-col', className)}>
      {(title || subtitle) && (
        <div className="mb-3 border-b border-bg-line pb-3">
          {title && <div className="text-sm font-semibold text-white">{title}</div>}
          {subtitle && <div className="mt-1 text-xs text-slate-400">{subtitle}</div>}
        </div>
      )}
      <div className="flex-1">{children}</div>
    </div>
  );
}
