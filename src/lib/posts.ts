import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { remark } from 'remark';
import remarkGfm from 'remark-gfm';
import remarkHtml from 'remark-html';
import type { Post, PostMeta, FrontMatter } from '@/types';

const postsDir = path.join(process.cwd(), 'content', 'blog');

function ensureDir() {
  if (!fs.existsSync(postsDir)) return [];
  return fs.readdirSync(postsDir).filter((f) => f.endsWith('.md'));
}

export function getAllPostSlugs(): string[] {
  return ensureDir().map((f) => f.replace(/\.md$/, ''));
}

export function getAllPosts(): PostMeta[] {
  const files = ensureDir();
  const items: PostMeta[] = files.map((file) => {
    const slug = file.replace(/\.md$/, '');
    const raw = fs.readFileSync(path.join(postsDir, file), 'utf8');
    const { data, content } = matter(raw);
    const fm = data as FrontMatter;
    const words = content.trim().split(/\s+/).length;
    return {
      slug,
      title: fm.title || slug,
      date: fm.date || '2025-01-01',
      summary: fm.summary || content.slice(0, 80).replace(/\n/g, ' '),
      category: fm.category || 'qcril',
      tags: fm.tags || [],
      featured: !!fm.featured,
      cover: fm.cover,
      wordCount: words,
      readingTime: Math.max(1, Math.round(words / 320)),
    };
  });
  return items.sort((a, b) => (a.date < b.date ? 1 : -1));
}

export async function getPostBySlug(slug: string): Promise<Post | null> {
  const file = path.join(postsDir, `${slug}.md`);
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, 'utf8');
  const { data, content } = matter(raw);
  const fm = data as FrontMatter;

  const processed = await remark().use(remarkGfm).use(remarkHtml, { sanitize: false }).process(content);
  let html = String(processed);

  // Inject ids onto h2/h3 for TOC scrolling
  const slugCounts2 = new Map<string, number>();
  const headingRe = /<h([23])>([\s\S]*?)<\/h\1>/gi;
  const parts: string[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = headingRe.exec(html)) !== null) {
    const tagName = `h${match[1]}`;
    const inner = match[2];
    const plain = inner.replace(/<[^>]+>/g, '').trim();
    let slug = plain
      .toLowerCase()
      .replace(/[^\u4e00-\u9fa5a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '');
    const count = (slugCounts2.get(slug) || 0) + 1;
    slugCounts2.set(slug, count);
    if (count > 1) slug = `${slug}-${count}`;
    parts.push(html.slice(cursor, match.index));
    parts.push(`<${tagName} id="${slug}">${inner}</${tagName}>`);
    cursor = match.index + match[0].length;
  }
  if (cursor < html.length) parts.push(html.slice(cursor));
  if (parts.length > 0) html = parts.join('');

  const words = content.trim().split(/\s+/).length;
  return {
    slug,
    title: fm.title || slug,
    date: fm.date || '2025-01-01',
    summary: fm.summary || content.slice(0, 80).replace(/\n/g, ' '),
    category: fm.category || 'qcril',
    tags: fm.tags || [],
    featured: !!fm.featured,
    cover: fm.cover,
    wordCount: words,
    readingTime: Math.max(1, Math.round(words / 320)),
    content,
    html,
  };
}
