'use client';

export function CallPulseHero() {
  return (
    <div className="relative flex h-[240px] w-[240px] items-center justify-center">
      {/* Pulse rings */}
      {[0, 1, 2, 3].map((i) => (
        <span
          key={i}
          className="absolute rounded-full border border-accent/40"
          style={{
            width: `${40 + i * 40}px`,
            height: `${40 + i * 40}px`,
            animation: `pulseRing 2.8s cubic-bezier(0.2,0.8,0.2,1) ${i * 0.6}s infinite`,
          }}
        />
      ))}

      {/* Inner core */}
      <div className="relative flex h-24 w-24 items-center justify-center rounded-2xl border border-accent/50 bg-accent/10 shadow-[0_0_30px_rgba(0,212,255,0.35)] backdrop-blur">
        <svg viewBox="0 0 24 24" className="h-10 w-10 text-accent" fill="none" stroke="currentColor" strokeWidth="1.6">
          <path d="M4 12C4 7.582 7.582 4 12 4" strokeLinecap="round" />
          <path d="M20 12c0 4.418-3.582 8-8 8" strokeLinecap="round" />
          <path d="M7 12a5 5 0 0 1 5-5" strokeLinecap="round" />
          <path d="M17 12a5 5 0 0 1-5 5" strokeLinecap="round" />
          <circle cx="12" cy="12" r="2" fill="currentColor" />
        </svg>
        <span className="absolute -bottom-8 whitespace-nowrap text-[11px] uppercase tracking-[0.3em] text-accent/90">
          call · pulse
        </span>
      </div>

      {/* Corner brackets */}
      {[
        'left-0 top-0 border-l border-t',
        'right-0 top-0 border-r border-t',
        'left-0 bottom-0 border-l border-b',
        'right-0 bottom-0 border-r border-b',
      ].map((cls, i) => (
        <span
          key={i}
          className={`absolute h-5 w-5 border-accent/60 ${cls}`}
        />
      ))}

      {/* Decorative hex */}
      <div
        className="absolute inset-0 -z-10 opacity-20 mix-blend-screen"
        style={{
          background:
            'radial-gradient(circle at center, rgba(0,212,255,0.4), transparent 60%)',
        }}
      />
    </div>
  );
}
