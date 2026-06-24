'use client';

import { useEffect, useRef, useState } from 'react';

export function CounterStat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [reducedMotion, setReducedMotion] = useState(false);
  useEffect(() => {
    const mql = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReducedMotion(mql.matches);
    const handler = (e: MediaQueryListEvent) => setReducedMotion(e.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, []);
  const [display, setDisplay] = useState('0');

  useEffect(() => {
    if (!ref.current) return;
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            if (reducedMotion) {
              setDisplay(value);
              obs.disconnect();
              return;
            }
            const match = value.match(/^([\d.]+)(.*)$/);
            if (!match) {
              setDisplay(value);
              obs.disconnect();
              return;
            }
            const num = parseFloat(match[1]);
            const suffix = match[2] || '';
            const duration = 1200;
            const start = performance.now();
            const step = (now: number) => {
              const p = Math.min(1, (now - start) / duration);
              const eased = 1 - Math.pow(1 - p, 3);
              const current = (num * eased).toFixed(num % 1 === 0 ? 0 : 1);
              setDisplay(`${current}${suffix}`);
              if (p < 1) requestAnimationFrame(step);
              else setDisplay(value);
            };
            requestAnimationFrame(step);
            obs.disconnect();
          }
        }
      },
      { threshold: 0.3 },
    );
    obs.observe(ref.current);
    return () => obs.disconnect();
  }, [value]);

  return (
    <div ref={ref} className="group relative overflow-hidden rounded-xl border border-bg-line bg-bg-card/60 p-5 transition-all duration-300 hover:border-accent/40 hover:bg-bg-card/80">
      {/* 顶部装饰线 */}
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/30 to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
      <div className="text-sm font-medium text-slate-300">{label}</div>
      <div className="mt-2 text-3xl font-bold tracking-tight text-accent glow-text">
        {display}
      </div>
      {hint && <div className="mt-1.5 text-xs leading-relaxed text-slate-500">{hint}</div>}
    </div>
  );
}
