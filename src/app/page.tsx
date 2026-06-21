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

            <div className="mt-6 max-w-2xl rounded-2xl border border-bg-line/80 bg-bg-card/45 p-4 shadow-[0_18px_60px_rgba(0,0,0,0.18)] backdrop-blur sm:p-5">
              <p className="text-[15px] leading-8 text-slate-300 sm:text-base sm:leading-8">
                <span className="font-medium text-white">6 年 Android Telephony 开发</span>
                <span className="mx-2 text-accent/70">/</span>
                深耕搜网、数据业务、通话管理与 ROM 升级交付，具备从
                <span className="mx-1 text-accent">RIL 到 Framework</span>
                的全链路定位与量产闭环能力。
              </p>

              <div className="mt-4 grid gap-2 text-xs text-slate-400 sm:grid-cols-3">
                <div className="rounded-xl border border-accent/15 bg-accent/[0.04] px-3 py-2">
                  <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-accent/70">
                    clients
                  </div>
                  <div className="mt-1 text-slate-200">华为 / 荣耀 / OPPO / 诺基亚</div>
                </div>
                <div className="rounded-xl border border-accent/15 bg-accent/[0.04] px-3 py-2">
                  <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-accent/70">
                    versions
                  </div>
                  <div className="mt-1 text-slate-200">Android R / S / T / U / W</div>
                </div>
                <div className="rounded-xl border border-accent/15 bg-accent/[0.04] px-3 py-2">
                  <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-accent/70">
                    delivery
                  </div>
                  <div className="mt-1 text-slate-200">CTS / 运营商认证 / 量产闭环</div>
                </div>
              </div>
            </div>

            <div className="mt-6 flex flex-wrap items-center gap-3">
              <Link href="/projects" className="btn-primary">
                <FolderKanban className="h-4 w-4" /> 项目经历
              </Link>
              <Link href="/blog" className="btn-ghost">
                <BookOpen className="h-4 w-4" /> 技术博客
              </Link>
              <Link href="/resume" className="btn-ghost">
                <FileText className="h-4 w-4" /> 简历下载
              </Link>
            </div>

            <div className="mt-6 max-w-2xl">
              <div className="mb-2 flex items-center gap-2 text-[10px] uppercase tracking-[0.28em] text-slate-500">
                <span className="h-px w-8 bg-accent/40" />
                core stack
              </div>
              <div className="flex flex-wrap gap-2.5 text-xs">
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
          description="搜网、数据业务、通话管理、版本交付与运营商认证。以下为结合简历经历的能力快照。"
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
              搜网、数据业务、通话管理、Radio AIDL、运营商认证五大分类，沉淀 ROM 升级与量产问题闭环经验。
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
