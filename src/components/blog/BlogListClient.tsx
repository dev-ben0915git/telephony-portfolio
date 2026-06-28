'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import type { PostMeta } from '@/types';
import { Search, Clock2, ChevronLeft, ChevronRight } from 'lucide-react';
import { siteConfig } from '@/config/site';
import { FadeUp } from '@/components/ui/FadeUp';

const PAGE_SIZE = 6;
const MAX_TAGS_SHOWN = 3;

interface Props {
  posts: PostMeta[];
}

export function BlogListClient({ posts }: Props) {
  const [query, setQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState<string>('all');
  const [page, setPage] = useState(1);
  const topRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return posts.filter((p) => {
      if (activeCategory !== 'all' && p.category !== activeCategory) return false;
      if (!q) return true;
      return (
        p.title.toLowerCase().includes(q) ||
        p.summary.toLowerCase().includes(q) ||
        p.tags.some((t) => t.toLowerCase().includes(q))
      );
    });
  }, [posts, query, activeCategory]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));

  // Reset page when filters change
  useEffect(() => {
    setPage(1);
  }, [activeCategory, query]);

  // Clamp page when filtered count shrinks
  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  const paged = useMemo(
    () => filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    [filtered, page],
  );

  const goTo = useCallback(
    (p: number) => {
      if (p < 1 || p > totalPages) return;
      setPage(p);
      topRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    },
    [totalPages],
  );

  // Build visible page numbers with ellipsis
  const pageNumbers = useMemo(() => {
    const nums: (number | '...')[] = [];
    if (totalPages <= 7) {
      for (let i = 1; i <= totalPages; i++) nums.push(i);
    } else {
      nums.push(1);
      if (page > 3) nums.push('...');
      for (
        let i = Math.max(2, page - 1);
        i <= Math.min(totalPages - 1, page + 1);
        i++
      ) {
        nums.push(i);
      }
      if (page < totalPages - 2) nums.push('...');
      nums.push(totalPages);
    }
    return nums;
  }, [page, totalPages]);

  const categories = [
    { key: 'all', label: '全部' },
    ...siteConfig.categories.map((c) => ({ key: c.key, label: c.label })),
  ];

  return (
    <div ref={topRef}>
      {/* Search + category bar — single row on desktop */}
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

        {/* Result count */}
        <span className="shrink-0 text-sm text-slate-500">
          {filtered.length} 篇{totalPages > 1 && ` · ${page}/${totalPages}`}
        </span>
      </div>

      {/* Category filters */}
      <div className="mb-8 flex flex-wrap gap-2">
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

      {/* Posts grid */}
      <div className="grid gap-5 md:grid-cols-2">
        {paged.map((post, idx) => {
          const catLabel =
            siteConfig.categories.find((c) => c.key === post.category)?.label || post.category;
          const visibleTags = post.tags.slice(0, MAX_TAGS_SHOWN);
          const remaining = post.tags.length - MAX_TAGS_SHOWN;

          return (
            <FadeUp key={post.slug} delay={idx * 0.03}>
              <Link
                href={`/blog/${post.slug}`}
                className="tech-card group block h-full transition hover:-translate-y-0.5"
              >
                {/* Meta row */}
                <div className="flex items-center justify-between text-xs text-slate-500">
                  <span className="chip chip-accent">{catLabel}</span>
                  <span className="font-mono text-[11px]">
                    <Clock2 className="mr-1 inline h-3 w-3 align-[-2px]" />
                    {post.date} · {post.readingTime} min
                  </span>
                </div>

                {/* Title */}
                <h3 className="mt-3 text-[1.05rem] font-semibold leading-snug text-white transition-colors group-hover:text-accent">
                  {post.title}
                </h3>

                {/* Summary — clamped to 2 lines */}
                <p className="mt-2 line-clamp-2 text-sm leading-relaxed text-slate-400">
                  {post.summary}
                </p>

                {/* Tags — max 3, with overflow indicator */}
                {post.tags.length > 0 && (
                  <div className="mt-3 flex flex-wrap items-center gap-1.5">
                    {visibleTags.map((t) => (
                      <span
                        key={t}
                        className="rounded-md border border-bg-line/60 bg-bg-soft/40 px-2 py-px text-[11px] text-slate-500"
                      >
                        {t}
                      </span>
                    ))}
                    {remaining > 0 && (
                      <span className="text-[11px] text-slate-600">+{remaining}</span>
                    )}
                  </div>
                )}
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

      {/* Pagination */}
      {totalPages > 1 && (
        <nav className="mt-10 flex items-center justify-center gap-1.5" aria-label="分页导航">
          <button
            disabled={page <= 1}
            onClick={() => goTo(page - 1)}
            className="inline-flex items-center gap-1 rounded-lg border border-bg-line px-3 py-1.5 text-xs text-slate-300 transition hover:border-accent/60 hover:text-accent disabled:pointer-events-none disabled:opacity-30"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            上一页
          </button>

          {pageNumbers.map((item, i) =>
            item === '...' ? (
              <span key={`ellipsis-${i}`} className="px-2 text-xs text-slate-500">
                ...
              </span>
            ) : (
              <button
                key={item}
                onClick={() => goTo(item)}
                className={`inline-flex h-8 w-8 items-center justify-center rounded-lg border text-xs font-medium transition ${
                  page === item
                    ? 'border-accent/80 bg-accent/15 text-accent shadow-glow'
                    : 'border-bg-line text-slate-300 hover:border-accent/60 hover:text-accent'
                }`}
              >
                {item}
              </button>
            ),
          )}

          <button
            disabled={page >= totalPages}
            onClick={() => goTo(page + 1)}
            className="inline-flex items-center gap-1 rounded-lg border border-bg-line px-3 py-1.5 text-xs text-slate-300 transition hover:border-accent/60 hover:text-accent disabled:pointer-events-none disabled:opacity-30"
          >
            下一页
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </nav>
      )}
    </div>
  );
}
