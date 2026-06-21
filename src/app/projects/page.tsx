import Link from 'next/link';
import { siteConfig } from '@/config/site';
import { projects } from '@/data/portfolio';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { FadeUp } from '@/components/ui/FadeUp';
import { ArrowRight } from 'lucide-react';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: '项目实战',
  description: `Telephony 方向真实优化案例 · STAR 结构 · 数据对比 · 源码片段。`,
};

export default function ProjectsIndexPage() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6 sm:py-16">
      <SectionHeader
        eyebrow="projects"
        title="项目实战 · STAR 结构"
        description="Situation → Task → Action → Result。每篇都附带量化指标与源码片段。"
      />

      <div className="grid gap-5 md:grid-cols-2">
        {projects.map((p, idx) => (
          <FadeUp key={p.title} delay={idx * 0.04}>
            <Link
              href={`/projects/${p.period.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase()}-${idx + 1}`}
              className="tech-card group block h-full"
            >
              <div className="flex items-center justify-between text-xs text-slate-400">
                <span className="chip chip-accent">{p.period}</span>
                <span className="inline-flex items-center gap-1 text-accent">
                  查看 <ArrowRight className="h-3 w-3 transition group-hover:translate-x-1" />
                </span>
              </div>
              <h3 className="mt-3 text-lg font-semibold text-white group-hover:text-accent">
                {p.title}
              </h3>
              <p className="mt-1 text-sm text-slate-400">{p.subtitle}</p>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {p.stack.map((s) => (
                  <span key={s} className="chip text-[11px]">
                    {s}
                  </span>
                ))}
              </div>
              <div className="mt-4 grid grid-cols-2 gap-3">
                {p.metrics.slice(0, 4).map((m) => (
                  <div
                    key={m.label}
                    className="rounded-lg border border-bg-line bg-bg-soft/50 p-2"
                  >
                    <div className="text-[11px] text-slate-400">{m.label}</div>
                    <div className="mt-1 font-mono text-sm text-accent">{m.value}</div>
                  </div>
                ))}
              </div>
            </Link>
          </FadeUp>
        ))}
      </div>
    </div>
  );
}
