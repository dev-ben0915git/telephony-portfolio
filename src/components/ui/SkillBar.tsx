'use client';

import { useEffect, useRef, useState } from 'react';

export function SkillBar({ label, value }: { label: string; value: number }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    if (!ref.current) return;
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            setProgress(value);
            obs.disconnect();
          }
        }
      },
      { threshold: 0.2 },
    );
    obs.observe(ref.current);
    return () => obs.disconnect();
  }, [value]);

  return (
    <div ref={ref} className="space-y-1.5">
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium text-slate-200">{label}</span>
        <span className="font-mono text-accent">{progress.toFixed(0)}%</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-bg-line/60">
        <div
          className="h-full rounded-full bg-gradient-to-r from-accent-deep via-accent to-accent-soft shadow-[0_0_10px_rgba(0,212,255,0.45) transition-all duration-[1400ms] ease-out"
          style={{ width: `${progress}%` }}
        />
      </div>
    </div>
  );
}
