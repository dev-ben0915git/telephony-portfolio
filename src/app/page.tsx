import Link from 'next/link';
import { siteConfig } from '@/config/site';
import { skills } from '@/data/portfolio';
import { DecoderText } from '@/components/effects/DecoderText';
import { CallPulseHero } from '@/components/effects/CallPulseHero';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { TechCard } from '@/components/ui/TechCard';
import { SkillBar } from '@/components/ui/SkillBar';
import { CounterStat } from '@/components/ui/CounterStat';
import { FadeUp } from '@/components/ui/FadeUp';
import { SipSequenceDiagram } from '@/components/effects/SipSequenceDiagram';
import dynamic from 'next/dynamic';
import { ArrowRight, BookOpen, FolderKanban, FileText } from 'lucide-react';

const CellTowerLazy = dynamic(() => import('@/components/effects/CellTowerLazy'), {
  ssr: false,
  loading: () => (
    <div className="h-[320px] w-full animate-pulse rounded-2xl border border-bg-line/80 bg-bg-card/60" />
  ),
});

export default function HomePage() {
  return (
    <div className="mx-auto max-w-6xl px-4 sm:px-6">
      {/* Hero */}
      <section className="relative py-14 sm:py-20">
        <div className="grid items-center gap-10 md:grid-cols-[1.3fr_1fr]">
          <div>
            <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-accent/40 bg-accent/10 px-3 py-1 text-xs text-accent">
              <span className="relative inline-flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent/60" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-accent" />
              </span>
              Senior Telephony Engineer · 求职中
            </div>

            <h1 className="text-3xl font-semibold leading-tight tracking-tight text-white sm:text-4xl md:text-5xl">
              你好，我是 <span className="glow-text text-accent">{siteConfig.author.name}</span>
              <br />
              <DecoderText
                text={`RIL / IMS / 搜网 / Modem 优化`}
                className="block text-xl text-slate-200 sm:text-2xl md:text-3xl"
                speed={35}
                startDelay={200}
              />
            </h1>

            <p className="mt-5 max-w-xl text-sm leading-7 text-slate-400 sm:text-base">
              {siteConfig.author.tagline}。擅长高通 QCRIL / MTK RIL 深度定制、IMS 注册与
              VoNR 接通率治理、搜网策略重构与 Modem 异常归因。 注重工程化落地与量化结果。
            </p>

            <div className="mt-6 flex flex-wrap items-center gap-3">
              <Link href="/projects" className="btn-primary">
                <FolderKanban className="h-4 w-4" /> 项目实战
              </Link>
              <Link href="/blog" className="btn-ghost">
                <BookOpen className="h-4 w-4" /> 技术博客
              </Link>
              <Link href="/resume" className="btn-ghost">
                <FileText className="h-4 w-4" /> 简历下载
              </Link>
            </div>

            <div className="mt-6 flex flex-wrap items-center gap-4 text-xs text-slate-500">
              <span className="chip chip-accent">C / C++</span>
              <span className="chip">Java</span>
              <span className="chip">Android Framework</span>
              <span className="chip">QXDM · Wireshark</span>
              <span className="chip">QMI · AT · SIP</span>
            </div>
          </div>

          <div className="relative flex justify-center">
            <CallPulseHero />
            <div className="pointer-events-none absolute -inset-8 -z-10 rounded-full bg-accent/5 blur-3xl" />
          </div>
        </div>

        {/* Signal / throughput mini metrics */}
        <div className="mt-10 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {siteConfig.stats.map((s) => (
            <CounterStat key={s.label} label={s.label} value={s.value} hint={s.hint} />
          ))}
        </div>
      </section>

      {/* Skills snapshot */}
      <section className="py-10">
        <SectionHeader
          eyebrow="skills snapshot"
          title="四大方向 · 技能雷达"
          description="RIL/QMI、IMS/VoLTE、搜网策略与网络稳定性、工程化工具链。以下为自评熟练度快照。"
        />
        <div className="grid gap-4 md:grid-cols-2">
          {skills.map((group, idx) => (
            <FadeUp key={group.key} delay={idx * 0.05}>
              <TechCard title={group.title} subtitle={group.description}>
                <div className="space-y-3">
                  {group.skills.map((s) => (
                    <SkillBar key={s.name} label={s.name} value={s.level} />
                  ))}
                </div>
              </TechCard>
            </FadeUp>
          ))}
        </div>
      </section>

      {/* SIP sequence teaser */}
      <section className="py-10">
        <SectionHeader
          eyebrow="sip sequence"
          title="IMS 注册 · 401/AKA 握手"
          description="UE ↔ P-CSCF ↔ IMS 核心网的注册时序示意，点击在技术博客查看完整抓包分析。"
        />
        <FadeUp>
          <div className="tech-card">
            <SipSequenceDiagram />
          </div>
        </FadeUp>
      </section>

      {/* 3D tower */}
      <section className="py-10">
        <SectionHeader
          eyebrow="infrastructure"
          title="BTS / gNB · 蜂窝基站可视化"
          description="把技术直觉可视化：从 UE 到基站的信号，在底层是数据包、在全局是网络。"
        />
        <FadeUp>
          <CellTowerLazy />
        </FadeUp>
      </section>

      {/* Featured posts + CTAs */}
      <section className="grid gap-6 py-10 md:grid-cols-2">
        <FadeUp>
          <Link href="/blog" className="tech-card group block h-full">
            <div className="flex items-center justify-between">
              <div className="text-sm uppercase tracking-[0.3em] text-accent">blog</div>
              <ArrowRight className="h-4 w-4 text-accent transition group-hover:translate-x-1" />
            </div>
            <div className="mt-2 text-xl font-semibold text-white">技术博客</div>
            <div className="mt-2 text-sm leading-6 text-slate-400">
              QCRIL、MTK RIL、IMS/VoLTE、搜网排障、Crash 复盘五大分类，带代码与抓包示意。
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              {['QCRIL', 'MTK RIL', 'IMS', '搜网', 'Crash'].map((t) => (
                <span key={t} className="chip chip-accent">
                  {t}
                </span>
              ))}
            </div>
          </Link>
        </FadeUp>
        <FadeUp delay={0.05}>
          <Link href="/projects" className="tech-card group block h-full">
            <div className="flex items-center justify-between">
              <div className="text-sm uppercase tracking-[0.3em] text-accent">projects</div>
              <ArrowRight className="h-4 w-4 text-accent transition group-hover:translate-x-1" />
            </div>
            <div className="mt-2 text-xl font-semibold text-white">项目实战</div>
            <div className="mt-2 text-sm leading-6 text-slate-400">
              STAR 结构案例：问题陈述 → 方案 → 行动 → 数据结果，附代码片段与截图。
            </div>
            <ul className="mt-3 space-y-1 text-sm text-slate-300">
              <li>· 5G 搜网耗时 -62%</li>
              <li>· VoLTE 接通率 99.6%</li>
              <li>· Modem Crash 自动归因</li>
            </ul>
          </Link>
        </FadeUp>
      </section>
    </div>
  );
}
