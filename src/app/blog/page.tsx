import { getAllPosts } from '@/lib/posts';
import { siteConfig } from '@/config/site';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { BlogListClient } from '@/components/blog/BlogListClient';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: '技术博客',
  description: `高通 QCRIL、MTK RIL、IMS/VoLTE、搜网排障、Modem Crash 复盘的技术博客。`,
};

export default function BlogListPage() {
  const posts = getAllPosts();

  return (
    <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6 sm:py-16">
      <SectionHeader
        eyebrow="blog"
        title="技术博客 · 八大分类"
        description="Telephony 方向一手实战笔记：代码片段、抓包分析、量化数据。"
      />

      <BlogListClient posts={posts} />

      <div className="mt-14 text-center text-xs text-slate-500">
        持续更新中 · 内容面向 {siteConfig.author.name} 的求职作品集
      </div>
    </div>
  );
}
