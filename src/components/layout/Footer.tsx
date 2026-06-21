import { siteConfig } from '@/config/site';
import Link from 'next/link';

export function Footer() {
  return (
    <footer className="relative mt-12 border-t border-bg-line/80 sm:mt-16">
      <div className="mx-auto grid max-w-6xl gap-6 px-4 py-8 sm:px-6 sm:py-10 md:grid-cols-3">
        <div>
          <div className="flex items-center gap-2 text-base font-semibold text-white">
            <span className="h-2 w-2 rounded-full bg-accent shadow-[0_0_12px_#00d4ff]" />
            {siteConfig.name}
          </div>
          <p className="mt-2 max-w-sm text-sm text-slate-400">{siteConfig.author.tagline}</p>
          <p className="mt-2 text-xs text-slate-500">
            © {new Date().getFullYear()} {siteConfig.author.name} · Next.js 14 · Static Export
          </p>
        </div>

        <div>
          <h4 className="text-sm font-semibold uppercase tracking-wider text-slate-300">导航</h4>
          <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm md:block md:space-y-1.5">
            {siteConfig.nav.map((item) => (
              <li key={item.key}>
                <Link
                  href={item.href}
                  className="text-slate-400 transition hover:text-accent"
                >
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>

        <div>
          <h4 className="text-sm font-semibold uppercase tracking-wider text-slate-300">联系</h4>
          <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm md:block md:space-y-1.5">
            <li>
              <a
                href={`mailto:${siteConfig.author.email}`}
                className="text-slate-400 transition hover:text-accent"
              >
                {siteConfig.author.email}
              </a>
            </li>
            <li>
              <a
                href={siteConfig.author.github}
                target="_blank"
                rel="noreferrer"
                className="text-slate-400 transition hover:text-accent"
              >
                GitHub
              </a>
            </li>
            {siteConfig.author.linkedin && (
              <li>
              <a
                href={siteConfig.author.linkedin}
                target="_blank"
                rel="noreferrer"
                className="text-slate-400 transition hover:text-accent"
              >
                LinkedIn
              </a>
              </li>
            )}
            {siteConfig.author.location && (
              <li className="text-slate-500">{siteConfig.author.location}</li>
            )}
          </ul>
        </div>
      </div>
      <div className="h-px w-full bg-gradient-to-r from-transparent via-accent/30 to-transparent" />
    </footer>
  );
}
