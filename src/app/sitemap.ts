import { siteConfig } from '@/config/site';
import { getAllPosts } from '@/lib/posts';
import { projects } from '@/data/portfolio';
import type { MetadataRoute } from 'next';

export default function sitemap(): MetadataRoute.Sitemap {
  const posts = getAllPosts();
  const base = siteConfig.url.replace(/\/$/, '');
  const date = new Date().toISOString();

  const staticPages: MetadataRoute.Sitemap = ['', '/about', '/blog', '/projects', '/resume'].map(
    (p) => ({
      url: `${base}${p}`,
      lastModified: date,
      changeFrequency: p === '' || p === '/blog' ? 'weekly' : 'monthly',
      priority: p === '' ? 1 : 0.7,
    }),
  );

  const postPages: MetadataRoute.Sitemap = posts.map((p) => ({
    url: `${base}/blog/${p.slug}`,
    lastModified: p.date,
    changeFrequency: 'monthly',
    priority: 0.6,
  }));

  const projectPages: MetadataRoute.Sitemap = projects.map((p, i) => ({
    url: `${base}/projects/${p.period
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-|-$/g, '')
      .toLowerCase()}-${i + 1}`,
    lastModified: date,
    changeFrequency: 'monthly',
    priority: 0.6,
  }));

  return [...staticPages, ...postPages, ...projectPages];
}
