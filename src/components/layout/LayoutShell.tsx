'use client';

import { useEffect, useState } from 'react';
import { NavBar } from './NavBar';
import { Footer } from './Footer';
import { SignalParticles } from '@/components/effects/SignalParticles';

export function LayoutShell({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setReady(true), 50);
    return () => clearTimeout(t);
  }, []);

  return (
    <>
      <div className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
        <div className="absolute inset-0 bg-radial-spot opacity-80" />
        <div
          className="absolute inset-0 opacity-[0.35] mix-blend-screen"
          style={{
            backgroundImage:
              'linear-gradient(rgba(0,212,255,0.045) 1px, transparent 1px), linear-gradient(90deg, rgba(0,212,255,0.045) 1px, transparent 1px)',
            backgroundSize: '40px 40px',
          }}
        />
        <SignalParticles />
      </div>

      <NavBar />
      <main className="relative">{ready ? children : children}</main>
      <Footer />
    </>
  );
}
