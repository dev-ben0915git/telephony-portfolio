import { siteConfig } from '@/config/site';

export function Footer() {
  return (
    <footer className="relative mt-20 border-t border-bg-line/80">
      <div className="mx-auto grid max-w-6xl gap-8 px-4 py-10 sm:px-6 md:grid-cols-3">
        <div>
          <div className="flex items-center gap-2 text-base font-semibold text-white">
            <span className="h-2 w-2 rounded-full bg-accent shadow-[0_0_12px_#00d4ff]" />
            {siteConfig.name}
          </div>
          <p className="mt-3 max-w-sm text-sm text-slate-400">{siteConfig.author.tagline}</p>
          <p className="mt-3 text-xs text-slate-500">
            © {new Date().getFullYear()} {siteConfig.author.name} · Built with Next.js 14 · Static
            Export
          </p>
        </div>

        <div>
          <h4 className="text-sm font-semibold uppercase tracking-wider text-slate-300">导航</h4>
          <ul className="mt-3 space-y-1.5 text-sm">
            {siteConfig.nav.map((item) => (
              <li key={item.key}>
                <a
                  href={item.href}
                  className="text-slate-400 transition hover:text-accent"
                >
                  {item.label}
                </a>
              </li>
            ))}
          </ul>
        </div>

        <div>
          <h4 className="text-sm font-semibold uppercase tracking-wider text-slate-300">联系</h4>
          <ul className="mt-3 space-y-1.5 text-sm">
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
            <li className="text-slate-500">{siteConfig.author.location}</li>
          </ul>
        </div>
      </div>
      <div className="h-px w-full bg-gradient-to-r from-transparent via-accent/30 to-transparent" />
    </footer>
  );
}
