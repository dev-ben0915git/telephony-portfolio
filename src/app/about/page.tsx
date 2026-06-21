import { siteConfig } from '@/config/site';
import { skills, timeline } from '@/data/portfolio';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { TechCard } from '@/components/ui/TechCard';
import { SkillBar } from '@/components/ui/SkillBar';
import { FadeUp } from '@/components/ui/FadeUp';
import { Mail, Github, Linkedin, MapPin } from 'lucide-react';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: '关于我',
  description: `${siteConfig.author.name} · ${siteConfig.author.tagline} · 个人履历、技能矩阵、量化成果与求职意向。`,
};

export default function AboutPage() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6 sm:py-16">
      <SectionHeader
        eyebrow="about"
        title={siteConfig.author.name}
        description={
          <>
            {siteConfig.author.tagline}。
            <span className="text-slate-300"> · 开放 远程 / 国内 Telephony / Modem 方向机会。</span>
          </>
        }
      />

      {/* Contact row */}
      <div className="mb-10 flex flex-wrap items-center gap-3 text-sm">
        <span className="chip">
          <MapPin className="h-3 w-3" /> {siteConfig.author.location}
        </span>
        <a href={`mailto:${siteConfig.author.email}`} className="chip hover:border-accent/60 hover:text-accent">
          <Mail className="h-3 w-3" /> {siteConfig.author.email}
        </a>
        <a href={siteConfig.author.github} target="_blank" rel="noreferrer" className="chip hover:border-accent/60 hover:text-accent">
          <Github className="h-3 w-3" /> GitHub
        </a>
        <a href={siteConfig.author.linkedin} target="_blank" rel="noreferrer" className="chip hover:border-accent/60 hover:text-accent">
          <Linkedin className="h-3 w-3" /> LinkedIn
        </a>
      </div>

      {/* Timeline */}
      <section className="mb-14">
        <SectionHeader eyebrow="timeline" title="时间轴履历" description="从工程背景到 Telephony 一线交付：项目、角色、量化成果。" />
        <div className="relative pl-6">
          <div className="absolute left-[9px] top-1.5 bottom-1.5 w-px bg-gradient-to-b from-accent/60 via-accent/20 to-transparent" />
          <div className="space-y-6">
            {timeline.map((item, idx) => (
              <FadeUp key={item.year} delay={idx * 0.04}>
                <div className="relative">
                  <span className="absolute -left-[21px] top-1.5 h-3 w-3 rounded-full border border-accent bg-bg-base shadow-[0_0_10px_#00d4ff]" />
                  <div className="text-xs font-mono text-accent/80">{item.year}</div>
                  <div className="mt-1 text-base font-semibold text-white">
                    {item.title}
                    <span className="ml-2 text-sm font-normal text-slate-400">· {item.org}</span>
                  </div>
                  <p className="mt-1 text-sm leading-6 text-slate-400">{item.description}</p>
                  <ul className="mt-2 space-y-1 text-sm text-slate-300">
                    {item.highlights.map((h) => (
                      <li key={h} className="relative pl-4 before:absolute before:left-0 before:top-2 before:h-1.5 before:w-1.5 before:rounded-full before:bg-accent/70">
                        {h}
                      </li>
                    ))}
                  </ul>
                </div>
              </FadeUp>
            ))}
          </div>
        </div>
      </section>

      {/* Skill matrix */}
      <section className="mb-14">
        <SectionHeader
          eyebrow="skill matrix"
          title="四大方向技能矩阵"
          description="按技术栈分组的熟练度自评，辅以工程化与工具链维度。"
        />
        <div className="grid gap-4 md:grid-cols-2">
          {skills.map((g, idx) => (
            <FadeUp key={g.key} delay={idx * 0.05}>
              <TechCard title={g.title} subtitle={g.description}>
                <div className="space-y-3">
                  {g.skills.map((s) => (
                    <SkillBar key={s.name} label={s.name} value={s.level} />
                  ))}
                </div>
              </TechCard>
            </FadeUp>
          ))}
        </div>
      </section>

      {/* Quantified highlights */}
      <section className="mb-14">
        <SectionHeader
          eyebrow="highlights"
          title="量化工作成果"
          description="以可验证的数据表达工作影响：交付范围、优化幅度、稳定性指标。"
        />
        <div className="grid gap-4 sm:grid-cols-3">
          {[
            { k: '5G 搜网耗时', v: '首搜耗时 28s → 10.6s', d: '自研搜网仲裁器 + 频段偏好队列' },
            { k: 'IMS 接通率', v: '97.1% → 99.6%', d: 'SIP UA 状态机重构 + 408 分级重试' },
            { k: 'Modem Crash 归因', v: '人工 → 自动化', d: '处理耗时分钟级，Top3 重复问题清零' },
            { k: '双卡 PDP 调度', v: '切片切换 280ms', d: 'MTK RIL 自定义 Request + 路由表' },
            { k: '项目交付', v: '12+ 产品线', d: '海外运营商 IOT 认证、MTK & 高通双平台' },
            { k: '团队建设', v: 'Telephony 回归流水线', d: '480+ 用例覆盖，CI 每日运行' },
          ].map((h, idx) => (
            <FadeUp key={h.k} delay={idx * 0.03}>
              <TechCard title={h.k} subtitle={h.v}>
                <p className="text-sm leading-6 text-slate-400">{h.d}</p>
              </TechCard>
            </FadeUp>
          ))}
        </div>
      </section>

      {/* Intention */}
      <section>
        <SectionHeader
          eyebrow="looking for"
          title="求职意向"
          description="以下方向均开放：远程 / 国内 均可。欢迎通过邮箱或 LinkedIn 进一步沟通。"
        />
        <div className="grid gap-4 md:grid-cols-3">
          {[
            { t: 'Senior Telephony Engineer', d: 'Android Telephony Framework、RIL 定制、IMS/VoLTE/VoNR' },
            { t: 'Modem / Protocol Engineer', d: 'Modem 协议、NAS/AS、数据包路径、异常归因与自动化' },
            { t: '5G / 6G R&D', d: '面向下一代无线的研究与原型实现，结合 RAN 与 Core' },
          ].map((c) => (
            <TechCard key={c.t} title={c.t}>
              <p className="text-sm leading-6 text-slate-400">{c.d}</p>
            </TechCard>
          ))}
        </div>
      </section>
    </div>
  );
}
