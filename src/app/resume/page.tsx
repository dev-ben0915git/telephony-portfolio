import Link from 'next/link';
import { Mail, Github, MapPin, FileDown, ExternalLink, Phone } from 'lucide-react';
import { siteConfig } from '@/config/site';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { TechCard } from '@/components/ui/TechCard';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: '简历下载',
  description: `在线预览与 PDF 下载 ${siteConfig.author.name} 的 Telephony 工程师简历。`,
};

export default function ResumePage() {
  return (
    <div className="mx-auto max-w-5xl px-4 py-12 sm:px-6 sm:py-16">
      <SectionHeader
        eyebrow="resume"
        title={`${siteConfig.author.name} · 简历`}
        description="在线预览核心信息；一键下载 PDF 版完整简历（含工作经历、项目经历与技能描述）。"
      />

      {/* Download bar */}
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <a
          href={siteConfig.author.resumeUrl}
          download
          className="inline-flex items-center gap-2 rounded-lg border border-accent/60 bg-accent/15 px-4 py-2 text-sm font-medium text-accent shadow-glow transition hover:bg-accent/25"
        >
          <FileDown className="h-4 w-4" /> 下载 PDF 简历
        </a>
        <a
          href={siteConfig.author.repoUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-2 rounded-lg border border-bg-line bg-bg-card/60 px-4 py-2 text-sm text-slate-200 transition hover:border-accent/50 hover:text-accent"
        >
          <Github className="h-4 w-4" /> 站点源码 <ExternalLink className="h-3 w-3" />
        </a>
        <Link href="/projects" className="inline-flex items-center gap-2 rounded-lg border border-bg-line bg-bg-card/60 px-4 py-2 text-sm text-slate-200 transition hover:border-accent/50 hover:text-accent">
          查看项目实战
        </Link>
      </div>

      {/* Preview panel */}
      <div className="mt-8 grid gap-6 md:grid-cols-[1.4fr_1fr]">
        <TechCard title="在线预览" subtitle="关键字段速览 · 详细内容请下载 PDF">
          <div className="space-y-4 text-sm">
            <div>
              <div className="text-xs uppercase tracking-widest text-accent/80">基本信息</div>
              <div className="mt-2 grid gap-2 text-slate-300">
                <div>姓名：{siteConfig.author.name}</div>
                <div>岗位：Telephony 开发工程师</div>
                <div>地点：{siteConfig.author.location}</div>
                <div>电话：{siteConfig.author.phone}</div>
                <div>邮箱：{siteConfig.author.email}</div>
              </div>
            </div>

            <div>
              <div className="text-xs uppercase tracking-widest text-accent/80">技能矩阵</div>
              <ul className="mt-2 space-y-1 text-slate-300">
                <li>· Telephony 核心模块：搜网、数据业务、通话管理、短彩信、TelephonyProvider、SIM 卡账户</li>
                <li>· 通话链路：TeleService、Telecom、IMS、InCallUI 开发维护与故障修复</li>
                <li>· 平台适配：高通、MTK、海思平台适配与 AOSP Framework 层定制</li>
                <li>· 版本升级：Android R/S/T/U/W 多代 ROM 升级与通信模块兼容适配</li>
                <li>· 认证交付：Telephony CTS、国内三大运营商送测、海外运营商入网认证</li>
                <li>· 客户交付：需求评审、方案设计、编码实现、测试验证、上线落地全流程</li>
              </ul>
            </div>

            <div>
              <div className="text-xs uppercase tracking-widest text-accent/80">关键指标</div>
              <div className="mt-2 grid grid-cols-2 gap-3 text-slate-300 sm:grid-cols-3">
                <div className="rounded-lg border border-bg-line bg-bg-soft/60 p-2">
                  <div className="text-xs text-slate-400">旗舰机型</div>
                  <div className="font-mono text-accent">12+</div>
                </div>
                <div className="rounded-lg border border-bg-line bg-bg-soft/60 p-2">
                  <div className="text-xs text-slate-400">客户反馈</div>
                  <div className="font-mono text-accent">100+</div>
                </div>
                <div className="rounded-lg border border-bg-line bg-bg-soft/60 p-2">
                  <div className="text-xs text-slate-400">交付通过率</div>
                  <div className="font-mono text-accent">100%</div>
                </div>
              </div>
            </div>
          </div>
        </TechCard>

        <div className="space-y-4">
          <TechCard title="联系方式" subtitle="优先邮件沟通，其它为辅助">
            <ul className="space-y-2 text-sm text-slate-300">
              <li className="flex items-center gap-2">
                <Mail className="h-4 w-4 text-accent" />
                <a href={`mailto:${siteConfig.author.email}`} className="hover:text-accent">
                  {siteConfig.author.email}
                </a>
              </li>
              <li className="flex items-center gap-2">
                <Phone className="h-4 w-4 text-accent" />
                <a href={`tel:${siteConfig.author.phone}`} className="hover:text-accent">
                  {siteConfig.author.phone}
                </a>
              </li>
              <li className="flex items-center gap-2">
                <Github className="h-4 w-4 text-accent" />
                <a href={siteConfig.author.github} target="_blank" rel="noreferrer" className="hover:text-accent">
                  GitHub
                </a>
              </li>
              <li className="flex items-center gap-2">
                <MapPin className="h-4 w-4 text-accent" />
                <span>{siteConfig.author.location}</span>
              </li>
            </ul>
          </TechCard>

          <TechCard title="PDF 简历说明">
            <p className="text-sm leading-6 text-slate-400">
              当前下载文件已替换为上传的李奔 Telephony 工程师简历，链接由
              <code className="mx-1 text-accent">site.ts</code>
              统一配置。
            </p>
          </TechCard>
        </div>
      </div>

      <div className="mt-10 rounded-xl border border-dashed border-accent/40 bg-accent/[0.03] p-5 text-sm leading-6 text-slate-300">
        <strong className="text-white">招聘方看这里：</strong>
        本作品集内容已结合 PDF 简历整理，聚焦 Android Telephony 方向真实项目经历。为避免信息泄露，项目源码片段以
        去敏形式展示，完整项目细节可在面试阶段进一步沟通。
      </div>
    </div>
  );
}
