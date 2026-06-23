'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { RadioTower, Menu, X } from 'lucide-react';
import { siteConfig } from '@/config/site';
import { clsx } from 'clsx';

export function NavBar() {
  const pathname = usePathname();
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let ticking = false;
    const onScroll = () => {
      if (!ticking) {
        ticking = true;
        requestAnimationFrame(() => {
          setScrolled(window.scrollY > 8);
          ticking = false;
        });
      }
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => setOpen(false), [pathname]);

  return (
    <header
      className={clsx(
        'sticky top-0 z-40 w-full transition-all duration-300',
        scrolled
          ? 'border-b border-bg-line/80 bg-bg-base/85 backdrop-blur-md'
          : 'border-b border-transparent bg-transparent',
      )}
    >
      <nav className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4 sm:px-6">
        <Link href="/" className="group flex items-center gap-2 text-sm">
          <span className="relative">
            <RadioTower className="h-5 w-5 text-accent transition group-hover:text-accent-soft" />
            <span className="absolute inset-0 -z-10 rounded-full bg-accent/20 blur-md opacity-70 transition group-hover:opacity-100" />
          </span>
          <span className="font-semibold tracking-wide text-white">
            {siteConfig.name}
            <span className="ml-1 text-accent">.</span>
          </span>
        </Link>

        <ul className="hidden items-center gap-1 md:flex">
          {siteConfig.nav.map((item) => {
            const active =
              item.href === '/'
                ? pathname === '/'
                : pathname?.startsWith(item.href);
            return (
              <li key={item.key}>
                <Link
                  href={item.href}
                  className={clsx(
                    'relative rounded-md px-3 py-1.5 text-sm transition',
                    active
                      ? 'text-accent'
                      : 'text-slate-300 hover:text-white',
                  )}
                >
                  {item.label}
                  {active && (
                    <span className="absolute inset-x-2 -bottom-0.5 h-px bg-gradient-to-r from-transparent via-accent to-transparent" />
                  )}
                </Link>
              </li>
            );
          })}
        </ul>

        <div className="hidden items-center gap-2 md:flex">
          <a
            className="btn-ghost"
            href={siteConfig.author.repoUrl}
            target="_blank"
            rel="noreferrer"
          >
            GitHub
          </a>
          <Link className="btn-primary" href="/resume">
            简历
          </Link>
        </div>

        <button
          className="inline-flex items-center justify-center rounded-md border border-bg-line p-2 text-slate-200 md:hidden"
          onClick={() => setOpen((v) => !v)}
          aria-label="toggle menu"
        >
          {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
      </nav>
      {open && (
        <div className="border-t border-bg-line bg-bg-base/95 md:hidden">
          <div className="mx-auto grid max-w-6xl gap-1 px-4 py-3">
            {siteConfig.nav.map((item) => {
              const active =
                item.href === '/'
                  ? pathname === '/'
                  : pathname?.startsWith(item.href);
              return (
                <Link
                  key={item.key}
                  href={item.href}
                  className={clsx(
                    'rounded-md px-3 py-2 text-sm transition',
                    active
                      ? 'bg-accent/10 text-accent'
                      : 'text-slate-200 hover:bg-bg-card',
                  )}
                >
                  {item.label}
                </Link>
              );
            })}
          </div>
        </div>
      )}
    </header>
  );
}
