import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, Clock2, Tag as TagIcon } from 'lucide-react';
import { getAllPostSlugs, getPostBySlug } from '@/lib/posts';
import { siteConfig } from '@/config/site';
import { PostToc } from '@/components/blog/PostToc';
import type { Metadata } from 'next';

interface Params {
  params: Promise<{ slug: string }>;
}

export async function generateStaticParams() {
  return getAllPostSlugs().map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await params;
  const post = await getPostBySlug(slug);
  if (!post) return { title: '未找到文章' };
  return {
    title: post.title,
    description: post.summary,
    keywords: [...siteConfig.keywords, ...post.tags],
    openGraph: {
      title: post.title,
      description: post.summary,
      type: 'article',
      publishedTime: post.date,
      tags: post.tags,
      images: [{ url: '/og-image.svg', width: 1200, height: 630 }],
    },
  };
}

export default async function PostDetailPage({ params }: Params) {
  const { slug } = await params;
  const post = await getPostBySlug(slug);
  if (!post) return notFound();

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: post.title,
    description: post.summary,
    datePublished: post.date,
    keywords: post.tags.join(','),
    author: { '@type': 'Person', name: siteConfig.author.name },
    image: `${siteConfig.url}/og-image.svg`,
  };

  const catLabel =
    siteConfig.categories.find((c) => c.key === post.category)?.label || post.category;

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <Link href="/blog" className="inline-flex items-center gap-1 text-sm text-accent hover:text-accent-soft">
        <ArrowLeft className="h-4 w-4" /> 返回博客列表
      </Link>

      <div className="mt-6 grid gap-8 lg:grid-cols-[1fr_240px]">
        <article className="max-w-3xl">
          <header className="border-b border-bg-line pb-6">
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
              <span className="chip chip-accent">{catLabel}</span>
              <span className="inline-flex items-center gap-1 font-mono">
                <Clock2 className="h-3 w-3" /> {post.date} · {post.readingTime} min read
              </span>
            </div>
            <h1 className="mt-4 text-2xl font-semibold leading-tight text-white sm:text-3xl">
              {post.title}
            </h1>
            <p className="mt-3 text-sm leading-6 text-slate-400">{post.summary}</p>
            {post.tags.length > 0 && (
              <div className="mt-4 flex flex-wrap items-center gap-1.5 text-xs">
                <TagIcon className="h-3 w-3 text-slate-500" />
                {post.tags.map((t) => (
                  <span key={t} className="chip">#{t}</span>
                ))}
              </div>
            )}
          </header>

          <div
            className="prose-tech mt-6"
            dangerouslySetInnerHTML={{ __html: post.html }}
          />
        </article>

        <aside>
          <PostToc html={post.html} />
        </aside>
      </div>
    </div>
  );
}
