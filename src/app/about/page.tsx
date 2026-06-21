import { siteConfig } from '@/config/site';
import { skills, timeline } from '@/data/portfolio';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { TechCard } from '@/components/ui/TechCard';
import { SkillBar } from '@/components/ui/SkillBar';
import { FadeUp } from '@/components/ui/FadeUp';
import { Mail, Github, MapPin, Phone } from 'lucide-react';
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
            <span className="text-slate-300"> · 求职意向：成都 · Telephony 开发工程师。</span>
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
        <a href={`tel:${siteConfig.author.phone}`} className="chip hover:border-accent/60 hover:text-accent">
          <Phone className="h-3 w-3" /> {siteConfig.author.phone}
        </a>
        <a href={siteConfig.author.github} target="_blank" rel="noreferrer" className="chip hover:border-accent/60 hover:text-accent">
          <Github className="h-3 w-3" /> GitHub
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
            { k: '旗舰机型交付', v: '12+ 机型', d: 'Android S 到 W 多代 ROM 升级，全部按时交付零延误' },
            { k: '客户需求闭环', v: '100+ 反馈', d: '担任荣耀搜网与 Phone 稳定性对外唯一技术接口人' },
            { k: 'Radio AIDL 升级', v: '30+ 接口', d: '完成原有接口逻辑梳理与兼容性适配' },
            { k: '高优故障攻坚', v: '15+ / 20+', d: '解决搜网、数据业务、Phone 稳定性核心问题' },
            { k: '通话模块维护', v: '30+ 故障', d: '覆盖 TeleService、Telecom、InCallUI 等通话链路' },
            { k: '交付质量', v: '100%', d: '客户定制需求交付通过率与 OPPO 需求满足率均达 100%' },
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
          description="意向城市成都，聚焦 Android Telephony 开发、通信框架适配与 ROM 升级交付。"
        />
        <div className="grid gap-4 md:grid-cols-3">
          {[
            { t: 'Telephony 开发工程师', d: '搜网、数据业务、通话管理、短彩信、TelephonyProvider、SIM 卡账户' },
            { t: 'Android Framework 工程师', d: '高通 / MTK / 海思平台适配，AOSP Framework 定制与版本升级' },
            { t: '通信认证 / 交付工程师', d: 'Telephony CTS、国内运营商送测、海外 Carrier Config 与入网认证适配' },
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
