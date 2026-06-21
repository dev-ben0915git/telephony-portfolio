'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import type { PostMeta } from '@/types';
import { Search, Tag, Clock2 } from 'lucide-react';
import { siteConfig } from '@/config/site';
import { FadeUp } from '@/components/ui/FadeUp';

interface Props {
  posts: PostMeta[];
}

export function BlogListClient({ posts }: Props) {
  const [query, setQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState<string>('all');
  const [activeTag, setActiveTag] = useState<string | null>(null);

  const allTags = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of posts) for (const t of p.tags) m.set(t, (m.get(t) || 0) + 1);
    return Array.from(m.entries()).sort((a, b) => b[1] - a[1]);
  }, [posts]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return posts.filter((p) => {
      if (activeCategory !== 'all' && p.category !== activeCategory) return false;
      if (activeTag && !p.tags.includes(activeTag)) return false;
      if (!q) return true;
      return (
        p.title.toLowerCase().includes(q) ||
        p.summary.toLowerCase().includes(q) ||
        p.tags.some((t) => t.toLowerCase().includes(q))
      );
    });
  }, [posts, query, activeCategory, activeTag]);

  const categories = [
    { key: 'all', label: '全部' },
    ...siteConfig.categories.map((c) => ({ key: c.key, label: c.label })),
  ];

  return (
    <div>
      {/* Search & filters */}
      <div className="mb-6 flex flex-col gap-3 md:flex-row md:items-center">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索标题、摘要、标签..."
            className="input-tech pl-9"
          />
        </div>
      </div>

      <div className="mb-6 flex flex-wrap gap-2">
        {categories.map((c) => (
          <button
            key={c.key}
            onClick={() => setActiveCategory(c.key)}
            className={`rounded-full border px-3 py-1 text-xs transition ${
              activeCategory === c.key
                ? 'border-accent/80 bg-accent/15 text-accent shadow-glow'
                : 'border-bg-line bg-bg-card/50 text-slate-300 hover:border-accent/50 hover:text-accent'
            }`}
          >
            {c.label}
          </button>
        ))}
      </div>

      {allTags.length > 0 && (
        <div className="mb-8 flex flex-wrap gap-2 border-y border-bg-line/80 py-3">
          <span className="mr-1 text-xs uppercase tracking-widest text-slate-400">
            <Tag className="inline h-3 w-3" /> tags
          </span>
          {allTags.slice(0, 18).map(([tag, count]) => (
            <button
              key={tag}
              onClick={() => setActiveTag(activeTag === tag ? null : tag)}
              className={`rounded-full border px-2.5 py-0.5 text-xs transition ${
                activeTag === tag
                  ? 'border-accent text-accent'
                  : 'border-bg-line text-slate-300 hover:border-accent/50 hover:text-accent'
              }`}
            >
              {tag} <span className="text-slate-500">({count})</span>
            </button>
          ))}
          {activeTag && (
            <button
              onClick={() => setActiveTag(null)}
              className="ml-2 rounded-full border border-bg-line px-2.5 py-0.5 text-xs text-slate-400 hover:text-accent"
            >
              清除
            </button>
          )}
        </div>
      )}

      <div className="mb-4 text-sm text-slate-400">共 {filtered.length} 篇</div>

      {/* Posts grid */}
      <div className="grid gap-4 md:grid-cols-2">
        {filtered.map((post, idx) => {
          const catLabel = siteConfig.categories.find((c) => c.key === post.category)?.label || post.category;
          return (
            <FadeUp key={post.slug} delay={idx * 0.03}>
              <Link
                href={`/blog/${post.slug}`}
                className="tech-card group block h-full transition hover:-translate-y-0.5"
              >
                <div className="flex items-center justify-between text-xs text-slate-500">
                  <span className="chip chip-accent">{catLabel}</span>
                  <span className="font-mono">
                    <Clock2 className="mr-1 inline h-3 w-3 align-[-2px]" />
                    {post.date} · {post.readingTime} min read
                  </span>
                </div>
                <div className="mt-3 text-lg font-semibold text-white group-hover:text-accent">
                  {post.title}
                </div>
                <p className="mt-2 text-sm leading-6 text-slate-400">{post.summary}</p>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {post.tags.map((t) => (
                    <span key={t} className="chip text-[11px]">
                      #{t}
                    </span>
                  ))}
                </div>
              </Link>
            </FadeUp>
          );
        })}
        {filtered.length === 0 && (
          <div className="col-span-full rounded-xl border border-dashed border-bg-line p-10 text-center text-slate-400">
            没有匹配的文章，试试换个关键词？
          </div>
        )}
      </div>
    </div>
  );
}
