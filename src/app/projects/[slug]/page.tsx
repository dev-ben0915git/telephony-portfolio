import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { projects } from '@/data/portfolio';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { siteConfig } from '@/config/site';
import type { Metadata } from 'next';

interface Params {
  params: Promise<{ slug: string }>;
}

export function generateStaticParams() {
  return projects.map((p, i) => ({
    slug: `${p.period.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase()}-${i + 1}`,
  }));
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await params;
  const idx = projects.findIndex(
    (p, i) =>
      `${p.period.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase()}-${i + 1}` === slug,
  );
  if (idx < 0) return { title: '未找到项目' };
  const p = projects[idx];
  return {
    title: p.title,
    description: p.subtitle,
    keywords: [...p.stack, 'Telephony', 'Project'],
    openGraph: {
      title: p.title,
      description: p.subtitle,
      url: `${siteConfig.url}/projects/${slug}`,
      type: 'article',
      siteName: siteConfig.title,
    },
  };
}

export default async function ProjectDetailPage({ params }: Params) {
  const { slug } = await params;
  const idx = projects.findIndex(
    (p, i) =>
      `${p.period.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase()}-${i + 1}` === slug,
  );
  if (idx < 0) return notFound();
  const p = projects[idx];

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'CreativeWork',
    name: p.title,
    description: p.subtitle,
    keywords: p.stack.join(','),
    dateCreated: p.period,
  };

  return (
    <div className="mx-auto max-w-5xl px-4 py-12 sm:px-6 sm:py-16">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <Link href="/projects" className="inline-flex items-center gap-1 text-sm text-accent hover:text-accent-soft">
        <ArrowLeft className="h-4 w-4" /> 返回项目列表
      </Link>

      <SectionHeader
        eyebrow={p.period}
        title={p.title}
        description={p.subtitle}
      />

      <div className="mb-8 flex flex-wrap gap-1.5">
        {p.stack.map((s) => (
          <span key={s} className="chip text-[11px]">
            {s}
          </span>
        ))}
      </div>

      {/* STAR */}
      <div className="grid gap-4 md:grid-cols-2">
        {[
          { key: 'Situation', label: 'S · 场景', body: p.situation, color: 'text-tech-orange' },
          { key: 'Task', label: 'T · 目标', body: p.task, color: 'text-tech-green' },
          { key: 'Action', label: 'A · 行动', body: p.action, color: 'text-tech-purple' },
          { key: 'Result', label: 'R · 结果', body: p.result, color: 'text-accent' },
        ].map((section) => (
          <div key={section.key} className="tech-card">
            <div className={`text-xs uppercase tracking-[0.2em] ${section.color}`}>
              {section.label}
            </div>
            <p className="mt-2 text-sm leading-6 text-slate-300">{section.body}</p>
          </div>
        ))}
      </div>

      {/* Metrics */}
      <section className="mt-12">
        <SectionHeader eyebrow="metrics" title="量化指标" />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {p.metrics.map((m) => (
            <div key={m.label} className="tech-card">
              <div className="text-xs text-slate-400">{m.label}</div>
              <div className="mt-1 font-mono text-lg text-accent">{m.value}</div>
              {m.delta && <div className="mt-1 text-xs text-tech-green">{m.delta}</div>}
            </div>
          ))}
        </div>
      </section>

      {/* Snippets */}
      <section className="mt-12">
        <SectionHeader eyebrow="snippets" title="源码片段" description="为保护真实项目，以下仅展示核心思路 / 去敏示例。" />
        <div className="space-y-4">
          {p.snippets.map((sn, i) => (
            <div key={i} className="tech-card !p-0">
              {sn.caption && (
                <div className="flex items-center justify-between border-b border-bg-line px-5 py-3 text-xs text-slate-400">
                  <span className="font-mono">{sn.lang}</span>
                  <span>{sn.caption}</span>
                </div>
              )}
              <pre className="overflow-x-auto bg-[#0a1424] px-5 py-4 text-[13px] leading-6 text-slate-200">
                <code>{sn.code}</code>
              </pre>
            </div>
          ))}
        </div>
      </section>

      {/* Screenshots */}
      {p.screenshots && p.screenshots.length > 0 && (
        <section className="mt-12">
          <SectionHeader eyebrow="artifacts" title="抓包示意" description="以下 SVG 为示意占位；真实项目中替换为 QXDM / Wireshark 截图。" />
          <div className="grid gap-4 md:grid-cols-2">
            {p.screenshots.map((s, i) => (
              <div
                key={i}
                className="tech-card flex items-center justify-center bg-[#0a1424] text-xs text-slate-500"
                style={{ minHeight: 160 }}
              >
                <div className="text-center">
                  <div className="font-mono text-accent">{s.alt}</div>
                  <div className="mt-2 text-[11px] text-slate-500">
                    替换为 public/{s.src} 真实截图
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
