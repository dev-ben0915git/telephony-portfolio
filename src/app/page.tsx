import Link from 'next/link';
import { Metadata } from 'next';
import { siteConfig } from '@/config/site';
import { skills } from '@/data/portfolio';
import { DecoderText } from '@/components/effects/DecoderText';
import { NetworkSearchHero } from '@/components/effects/NetworkSearchHero';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { TechCard } from '@/components/ui/TechCard';
import { SkillBar } from '@/components/ui/SkillBar';
import { CounterStat } from '@/components/ui/CounterStat';
import { FadeUp } from '@/components/ui/FadeUp';
import { SkillTabs } from '@/components/ui/SkillTabs';
import { AttachSequenceDiagram } from '@/components/effects/AttachSequenceDiagram';
import dynamic from 'next/dynamic';
import { ArrowRight, BookOpen, FolderKanban, FileText, ChevronRight } from 'lucide-react';

export const metadata: Metadata = {
  title: `${siteConfig.author.name} · ${siteConfig.title}`,
  description:
    '6 年 Android Telephony 开发工程师作品集，深耕搜网、数据业务、通话管理与 ROM 升级交付，具备从 RIL 到 Framework 的全链路定位与量产闭环能力。',
  openGraph: {
    title: `${siteConfig.author.name} · ${siteConfig.title}`,
    description:
      '6 年 Android Telephony 开发工程师作品集，深耕搜网、数据业务、通话管理与 ROM 升级交付。',
    url: siteConfig.url,
    type: 'website',
  },
};

const CellTowerLazy = dynamic(() => import('@/components/effects/CellTowerLazy'), {
  ssr: false,
  loading: () => (
    <div className="h-[320px] w-full animate-pulse rounded-2xl border border-bg-line/80 bg-bg-card/60" />
  ),
});

export default function HomePage() {
  return (
    <div className="mx-auto max-w-6xl px-4 sm:px-6">
      {/* 首屏 */}
      <section className="relative py-10 sm:py-14 lg:py-20">
        <div className="grid items-center gap-8 lg:grid-cols-[1.25fr_0.85fr] lg:gap-12">
          <div>
            <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-accent/40 bg-accent/10 px-3 py-1 text-xs text-accent">
              <span className="relative inline-flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent/60" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-accent" />
              </span>
              Telephony 开发工程师 · 应聘求职中
            </div>

            <h1 className="text-3xl font-semibold leading-tight tracking-tight text-white sm:text-4xl md:text-5xl">
              你好，我是 <span className="glow-text text-accent">{siteConfig.author.name}</span>
              <br />
              <DecoderText
                text={`搜网 / 数据业务 / 通话管理 / ROM 升级`}
                className="block text-xl text-slate-200 sm:text-2xl md:text-3xl"
                speed={35}
                startDelay={200}
              />
            </h1>

            <p className="mt-5 max-w-xl text-[15px] leading-7 text-slate-300 sm:text-base sm:leading-7">
              <span className="font-medium text-white">6 年 Android Telephony 开发</span>
              <span className="mx-2 text-accent/70">/</span>
              深耕搜网、数据业务、通话管理与 ROM 升级交付，具备从
              <span className="mx-1 text-accent">RIL 到 Framework</span>
              的全链路定位与量产闭环能力。
            </p>

            {/* 行动入口 */}
            <div className="mt-6 flex flex-wrap items-center gap-3">
              <Link href="/projects" className="btn-primary">
                <FolderKanban className="h-4 w-4" /> 项目经历
              </Link>
              <Link href="/blog" className="btn-ghost">
                <BookOpen className="h-4 w-4" /> 技术博客
              </Link>
              <Link href="/resume" className="btn-ghost hidden sm:inline-flex">
                <FileText className="h-4 w-4" /> 简历下载
              </Link>
            </div>

            {/* 核心技术栈 */}
            <div className="mt-7 max-w-2xl">
              <div className="mb-2.5 flex items-center gap-2 text-[10px] uppercase tracking-[0.28em] text-slate-400">
                <span className="h-px w-8 bg-accent/50" />
                core stack
              </div>
              <div className="flex flex-wrap gap-2 text-xs">
                <span className="core-skill-chip core-skill-chip-accent font-mono tracking-wide">
                  C / C++
                </span>
                <span className="core-skill-chip font-mono tracking-wide">Java</span>
                <span className="core-skill-chip">RIL</span>
                <span className="core-skill-chip">Framework Telephony</span>
                <span className="core-skill-chip">TeleService-Telecom-Telephony</span>
              </div>
            </div>
          </div>

          <div className="relative hidden justify-center lg:flex">
            <NetworkSearchHero />
            <div className="pointer-events-none absolute -inset-8 -z-10 rounded-full bg-accent/5 blur-3xl" />
          </div>
        </div>
      </section>

      {/* 量化数据 — 独立区域 */}
      <section className="border-t border-bg-line/40 py-8 sm:py-10">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {siteConfig.stats.map((s) => (
            <CounterStat key={s.label} label={s.label} value={s.value} hint={s.hint} />
          ))}
        </div>
      </section>

      {/* 快速入口条 */}
      <section className="border-b border-bg-line/40 py-4">
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className="text-xs uppercase tracking-[0.2em] text-slate-400">快速入口</span>
          <Link href="/projects" className="inline-flex items-center gap-1 text-slate-300 transition hover:text-accent">
            <ChevronRight className="h-3.5 w-3.5" /> 项目经历
          </Link>
          <Link href="/blog" className="inline-flex items-center gap-1 text-slate-300 transition hover:text-accent">
            <ChevronRight className="h-3.5 w-3.5" /> 技术博客
          </Link>
          <Link href="/about" className="inline-flex items-center gap-1 text-slate-300 transition hover:text-accent">
            <ChevronRight className="h-3.5 w-3.5" /> 关于我
          </Link>
          <Link href="/resume" className="inline-flex items-center gap-1 text-slate-300 transition hover:text-accent sm:hidden">
            <ChevronRight className="h-3.5 w-3.5" /> 简历下载
          </Link>
        </div>
      </section>

      {/* 技能快照 */}
      <section className="border-t border-bg-line/40 py-10 sm:py-14">
        <SectionHeader
          eyebrow="skills snapshot"
          title="四大方向 · 技能雷达"
          description="搜网、数据业务、通话管理、版本交付与运营商认证。以下为结合简历经历的能力快照。"
        />
        {/* 移动端：Tab 折叠 */}
        <div className="md:hidden">
          <SkillTabs />
        </div>
        {/* 桌面端：网格展示 */}
        <div className="hidden grid-cols-2 gap-4 md:grid">
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

      {/* SIP 时序示意 */}
      <section className="border-t border-bg-line/40 py-10 sm:py-14">
        <SectionHeader
          eyebrow="attach sequence"
          title="LTE Attach · 随机接入与承载建立"
          description="UE ↔ eNB ↔ EPC 的 Attach 时序示意，点击在技术博客查看完整信令分析。"
        />
        <FadeUp>
          <div className="tech-card">
            <AttachSequenceDiagram />
          </div>
        </FadeUp>
      </section>

      {/* 基站可视化 */}
      <section className="border-t border-bg-line/40 py-10 sm:py-14">
        <SectionHeader
          eyebrow="infrastructure"
          title="BTS / gNB · 蜂窝基站可视化"
          description="把技术直觉可视化：从 UE 到基站的信号，在底层是数据包、在全局是网络。"
        />
        <FadeUp>
          <CellTowerLazy />
        </FadeUp>
      </section>

      {/* 内容入口 */}
      <section className="grid gap-6 border-t border-bg-line/40 py-10 sm:py-14 md:grid-cols-2">
        <FadeUp>
          <Link href="/blog" className="tech-card group block h-full">
            <div className="flex items-center justify-between">
              <div className="text-sm uppercase tracking-[0.3em] text-accent">blog</div>
              <ArrowRight className="h-4 w-4 text-accent transition group-hover:translate-x-1" />
            </div>
            <div className="mt-2 text-xl font-semibold text-white">技术博客</div>
            <div className="mt-2 text-sm leading-6 text-slate-400">
              搜网、数据、短信、卡账户、通话、IMS、卫星、源码环境八大分类，沉淀 ROM 升级与量产问题闭环经验。
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              {['搜网', '数据业务', '通话管理', 'Radio AIDL', '认证'].map((t) => (
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
            <div className="mt-2 text-xl font-semibold text-white">项目经历</div>
            <div className="mt-2 text-sm leading-6 text-slate-400">
              STAR 结构案例：问题陈述 → 方案 → 行动 → 数据结果，附代码片段与截图。
            </div>
            <ul className="mt-3 space-y-1 text-sm text-slate-300">
              <li>· 12+ 旗舰机型跨代 ROM 升级</li>
              <li>· 100+ 客户需求与问题反馈闭环</li>
              <li>· Radio AIDL 30+ 接口兼容适配</li>
            </ul>
          </Link>
        </FadeUp>
      </section>
    </div>
  );
}
