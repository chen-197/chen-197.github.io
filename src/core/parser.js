const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');

// 部分插件新版本为 ESM 双包，做 default 兼容
const interop = (m) => m.default || m;
const MarkdownIt = interop(require('markdown-it'));
const anchor = interop(require('markdown-it-anchor'));
const toc = interop(require('markdown-it-toc-done-right'));
const highlightjs = interop(require('markdown-it-highlightjs'));

const { formatDate, toExcerpt } = require('../utils');

// 在文章正文 [[toc]] 处插入目录；标题自动带锚点 id
const md = new MarkdownIt({ html: true, linkify: true })
  .use(highlightjs)
  .use(anchor)
  .use(toc, { placeholder: '\\[\\[(?:toc|TOC)\\]\\]', containerClass: 'toc' });

function toList(value) {
  if (!value) return [];
  return Array.isArray(value) ? value.map(String) : [String(value)];
}

/**
 * 解析单个 markdown 文件为文章/页面对象。
 * 文件名约定：YYYY-MM-DD-slug.md（日期前缀可省略，省略时取 front-matter 或文件时间）
 */
function parseMarkdown(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const { data, content } = matter(raw);
  const basename = path.basename(filePath);
  const match = basename.match(/^(?:(\d{4}-\d{2}-\d{2})-)?(.+)\.md$/);

  const slug = match ? match[2] : basename.replace(/\.md$/, '');
  const fileDate = match && match[1] ? new Date(match[1]) : null;
  const stat = fs.statSync(filePath);
  const date = data.date ? new Date(data.date) : fileDate || stat.mtime;

  const html = md.render(content);
  const year = formatDate(date, 'YYYY');
  const month = formatDate(date, 'MM');

  return {
    title: data.title || slug,
    date,
    year,
    dateFormatted: formatDate(date),
    tags: toList(data.tags),
    categories: toList(data.categories),
    draft: !!data.draft,
    slug,
    file: basename,
    // 文章：/posts/2026/09/slug/ ；页面：/slug/
    url: data.date || fileDate ? `/posts/${year}/${month}/${slug}/` : `/${slug}/`,
    content: html,
    excerpt: data.description || toExcerpt(html),
  };
}

function scanDir(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => path.join(dir, f));
}

/** 加载全部文章，按日期倒序；drafts=true 时包含草稿 */
function loadPosts(contentDir, { drafts = false } = {}) {
  return scanDir(path.join(contentDir, 'posts'))
    .map(parseMarkdown)
    .filter((p) => drafts || !p.draft)
    .sort((a, b) => b.date - a.date);
}

function loadPages(contentDir) {
  return scanDir(path.join(contentDir, 'pages')).map(parseMarkdown);
}

/** 解析一份 markdown 文本（供后台预览用） */
function renderMarkdown(text) {
  return md.render(text);
}

module.exports = { loadPosts, loadPages, renderMarkdown };
