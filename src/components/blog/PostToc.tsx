'use client';

import { useEffect, useMemo, useState } from 'react';

interface TocItem {
  id: string;
  text: string;
  level: number;
}

export function PostToc({ html }: { html: string }) {
  const items = useMemo<TocItem[]>(() => {
    const re = /<h([23])\s*id="([^"]*)"[^>]*>([\s\S]*?)<\/h\1>/g;
    const list: TocItem[] = [];
    let m;
    while ((m = re.exec(html)) !== null) {
      const level = parseInt(m[1], 10);
      const id = m[2];
      const text = m[3].replace(/<[^>]+>/g, '');
      list.push({ id, text, level });
    }
    return list;
  }, [html]);

  const [active, setActive] = useState<string | null>(null);

  useEffect(() => {
    const onScroll = () => {
      let current: string | null = null;
      for (const it of items) {
        const el = document.getElementById(it.id);
        if (!el) continue;
        const top = el.getBoundingClientRect().top;
        if (top < 140) current = it.id;
      }
      setActive(current);
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [items]);

  if (items.length === 0) return null;

  return (
    <nav className="sticky top-20 hidden max-h-[75vh] overflow-y-auto rounded-xl border border-bg-line bg-bg-card/60 p-4 lg:block">
      <div className="mb-2 text-xs uppercase tracking-[0.3em] text-accent">目录</div>
      <ul className="space-y-1.5 text-sm">
        {items.map((it) => (
          <li key={it.id} style={{ paddingLeft: (it.level - 2) * 12 }}>
            <a
              href={`#${it.id}`}
              className={`block truncate rounded px-2 py-1 transition ${
                active === it.id
                  ? 'bg-accent/10 text-accent'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              {it.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
