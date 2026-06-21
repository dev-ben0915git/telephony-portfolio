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

  // Inject ids onto h2/h3 for TOC scrolling (avoid regex backref in source for SWC)
  const slugCounts2 = new Map<string, number>();
  const re1 = /<h2>/gi;
  const re2 = /<\/h2>/gi;
  const re3 = /<h3>/gi;
  const re4 = /<\/h3>/gi;
  const parts: string[] = [];
  let cursor = 0;
  let prev: RegExpExecArray | null = null;
  while (true) {
    const m1 = re1.exec(html);
    re1.lastIndex = m1 ? m1.index + m1[0].length : re1.lastIndex;
    const m2 = re2.exec(html);
    re2.lastIndex = m2 ? m2.index + m2[0].length : re2.lastIndex;
    const m3 = re3.exec(html);
    re3.lastIndex = m3 ? m3.index + m3[0].length : re3.lastIndex;
    const m4 = re4.exec(html);
    re4.lastIndex = m4 ? m4.index + m4[0].length : re4.lastIndex;
    const candidates = [
      { kind: 0, m: m1 },
      { kind: 1, m: m2 },
      { kind: 2, m: m3 },
      { kind: 3, m: m4 },
    ].filter((x) => x.m && x.m.index >= cursor);
    if (candidates.length === 0) break;
    candidates.sort((a, b) => (a.m as RegExpExecArray).index - (b.m as RegExpExecArray).index);
    const chosen = candidates[0];
    if (prev == null && chosen.kind % 2 === 1) {
      prev = null;
      parts.push(html.slice(cursor, (chosen.m as RegExpExecArray).index + (chosen.m as RegExpExecArray)[0].length));
      cursor = (chosen.m as RegExpExecArray).index + (chosen.m as RegExpExecArray)[0].length;
      continue;
    }
    if (prev == null) {
      // open tag
      prev = chosen.m;
      parts.push(html.slice(cursor, (chosen.m as RegExpExecArray).index + (chosen.m as RegExpExecArray)[0].length));
      cursor = (chosen.m as RegExpExecArray).index + (chosen.m as RegExpExecArray)[0].length;
    } else {
      const openIndex = prev.index;
      const openEnd = prev.index + prev[0].length;
      const inner = html.slice(openEnd, (chosen.m as RegExpExecArray).index);
      const plain = inner.replace(/<[^>]+>/g, '').trim();
      let slug = plain
        .toLowerCase()
        .replace(/[^\u4e00-\u9fa5a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '');
      const count = (slugCounts2.get(slug) || 0) + 1;
      slugCounts2.set(slug, count);
      if (count > 1) slug = `${slug}-${count}`;
      const openTag = html.slice(openIndex, openEnd);
      const newOpen = openTag.replace(/^<h/, '<h').replace(/^<(h[23])/, (_, t) => `<${t} id="${slug}"`);
      parts.push(newOpen);
      parts.push(inner);
      parts.push((chosen.m as RegExpExecArray)[0]);
      cursor = (chosen.m as RegExpExecArray).index + (chosen.m as RegExpExecArray)[0].length;
      prev = null;
    }
    if (cursor >= html.length) break;
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
