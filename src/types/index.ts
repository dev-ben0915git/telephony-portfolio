export interface FrontMatter {
  title: string;
  date: string;
  summary: string;
  category: string;
  tags: string[];
  cover?: string;
  featured?: boolean;
}

export interface PostMeta extends FrontMatter {
  slug: string;
  readingTime: number;
  wordCount: number;
}

export interface Post extends PostMeta {
  content: string;
  html: string;
}

export interface SkillMatrixItem {
  name: string;
  level: number;
  tag?: string;
}

export interface SkillMatrixGroup {
  key: string;
  title: string;
  description: string;
  skills: SkillMatrixItem[];
}

export interface TimelineItem {
  year: string;
  title: string;
  org: string;
  description: string;
  highlights: string[];
}

export interface ProjectItem {
  title: string;
  subtitle: string;
  period: string;
  stack: string[];
  situation: string;
  task: string;
  action: string;
  result: string;
  metrics: { label: string; value: string; delta?: string }[];
  snippets: { lang: string; code: string; caption?: string }[];
  screenshots?: { alt: string; src: string }[];
  cover?: string;
}
