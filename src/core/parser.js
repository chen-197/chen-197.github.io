const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
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
 * 摘要用的正文纯文本。
 * 代码块（fence / code_block）与原始 HTML 不计入；目录的内容由渲染器生成，
 * 对应的 token（tocOpen / tocBody / tocClose）本身是空的，天然被排除。
 * 同一个 inline 里的子节点直接相接（文字里已带原有空格），不同块之间才补空格。
 */
function tokensToText(tokens) {
  const blocks = [];
  for (const token of tokens) {
    if (token.type !== 'inline') continue;
    let text = '';
    for (const child of token.children || []) {
      if (child.type === 'text' || child.type === 'code_inline') text += child.content;
      else if (child.type === 'softbreak' || child.type === 'hardbreak') text += ' ';
    }
    if (text.trim()) blocks.push(text.trim());
  }
  return blocks.join(' ');
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 文章的实际修改时间：已提交且无本地改动的文件取 git 最后提交时间
 * （跨机器可复现，CI 上也正确——git 不保存 mtime，全新 checkout 的文件时间都相同）；
 * 未提交、未跟踪或 git 不可用时退回文件系统 mtime。
 */
function lastModified(filePath, repoRoot) {
  try {
    const status = spawnSync('git', ['status', '--porcelain', '--', filePath], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    if (status.status === 0 && !status.stdout.trim()) {
      const log = spawnSync('git', ['log', '-1', '--format=%cI', '--', filePath], {
        cwd: repoRoot,
        encoding: 'utf8',
      });
      const d = (log.stdout || '').trim();
      if (log.status === 0 && d) return new Date(d);
    }
  } catch (e) {
    /* git 不可用，走文件时间 */
  }
  return fs.statSync(filePath).mtime;
}

/**
 * 解析单个 markdown 文件为文章/页面对象。
 * 文件名约定：YYYY-MM-DD-slug.md（日期前缀可省略，省略时取 front-matter 或文件时间）
 */
function parseMarkdown(filePath, repoRoot) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const { data, content } = matter(raw);
  const basename = path.basename(filePath);
  const match = basename.match(/^(?:(\d{4}-\d{2}-\d{2})-)?(.+)\.md$/);

  const slug = match ? match[2] : basename.replace(/\.md$/, '');
  const fileDate = match && match[1] ? new Date(match[1]) : null;
  const stat = fs.statSync(filePath);
  const date = data.date ? new Date(data.date) : fileDate || stat.mtime;
  // 修改时间：front-matter 的 updated 优先，否则自动检测
  const updated = data.updated ? new Date(data.updated) : lastModified(filePath, repoRoot);

  // 一次解析，同时拿到 token（供摘要取正文）与 HTML
  const env = {};
  const tokens = md.parse(content, env);
  const html = md.renderer.render(tokens, md.options, env);
  const year = formatDate(date, 'YYYY');
  const month = formatDate(date, 'MM');

  return {
    title: data.title || slug,
    date,
    year,
    dateFormatted: formatDate(date),
    updated,
    updatedFormatted: formatDate(updated),
    // 修改时间比创建时间晚超过一天，才显示"更新于"
    isUpdated: updated - date > DAY_MS,
    tags: toList(data.tags),
    categories: toList(data.categories),
    draft: !!data.draft,
    slug,
    file: basename,
    // 文章：/posts/2026/09/slug/ ；页面：/slug/
    url: data.date || fileDate ? `/posts/${year}/${month}/${slug}/` : `/${slug}/`,
    content: html,
    excerpt: data.description || toExcerpt(tokensToText(tokens)),
  };
}

function scanDir(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => path.join(dir, f));
}

/** 加载全部文章，按修改时间倒序（同日再按创建时间倒序）；drafts=true 时包含草稿 */
function loadPosts(contentDir, { drafts = false } = {}) {
  const repoRoot = path.resolve(contentDir, '..');
  return scanDir(path.join(contentDir, 'posts'))
    .map((f) => parseMarkdown(f, repoRoot))
    .filter((p) => drafts || !p.draft)
    .sort((a, b) => b.updated - a.updated || b.date - a.date);
}

function loadPages(contentDir) {
  const repoRoot = path.resolve(contentDir, '..');
  return scanDir(path.join(contentDir, 'pages')).map((f) => parseMarkdown(f, repoRoot));
}

/** 解析一份 markdown 文本（供后台预览用） */
function renderMarkdown(text) {
  return md.render(text);
}

module.exports = { loadPosts, loadPages, renderMarkdown };
