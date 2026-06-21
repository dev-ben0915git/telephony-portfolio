import { clsx } from 'clsx';
import type { ReactNode } from 'react';

export function SectionHeader({
  eyebrow,
  title,
  description,
  align = 'left',
}: {
  eyebrow?: string;
  title: string;
  description?: ReactNode;
  align?: 'left' | 'center';
}) {
  return (
    <div
      className={clsx('mb-8', align === 'center' && 'text-center')}
    >
      {eyebrow && (
        <div className="mb-2 inline-flex items-center gap-2 text-xs uppercase tracking-[0.3em] text-accent/80">
          <span className="h-px w-6 bg-accent/60" />
          {eyebrow}
        </div>
      )}
      <h2 className="text-2xl font-semibold text-white sm:text-3xl">{title}</h2>
      {description && (
        <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-400 sm:text-base">{description}</p>
      )}
      <div className="my-4 h-px w-20 bg-gradient-to-r from-accent/60 to-transparent" />
    </div>
  );
}
