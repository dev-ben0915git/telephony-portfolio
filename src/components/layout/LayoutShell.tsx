'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { usePathname } from 'next/navigation';
import { NavBar } from './NavBar';
import { Footer } from './Footer';
import { SignalParticles } from '@/components/effects/SignalParticles';

/** 检测用户是否偏好减少动效 */
function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mql = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mql.matches);
    const handler = (e: MediaQueryListEvent) => setReduced(e.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, []);
  return reduced;
}

export function LayoutShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const reduced = usePrefersReducedMotion();
  const [transitioning, setTransitioning] = useState(false);
  const prevPathRef = useRef(pathname);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();

  // 路由切换淡入淡出过渡，降低 CLS
  useEffect(() => {
    if (prevPathRef.current !== pathname) {
      setTransitioning(true);
      // 短暂延迟让旧内容淡出
      timerRef.current = setTimeout(() => setTransitioning(false), reduced ? 0 : 180);
      prevPathRef.current = pathname;
    }
    return () => clearTimeout(timerRef.current);
  }, [pathname, reduced]);

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
        {/* 背景粒子：reduced-motion 时隐藏 */}
        {!reduced && <SignalParticles />}
      </div>

      <NavBar />
      <main
        className="relative"
        style={{
          opacity: transitioning ? 0 : 1,
          transform: transitioning ? 'translateY(6px)' : 'translateY(0)',
          transition: reduced
            ? 'none'
            : 'opacity 180ms cubic-bezier(0.16, 1, 0.3, 1), transform 180ms cubic-bezier(0.16, 1, 0.3, 1)',
        }}
      >
        {children}
      </main>
      <Footer />
    </>
  );
}
