const fs = require('fs');
const path = require('path');
const dayjs = require('dayjs');

/** 生成 URL/文件名友好的 slug，保留中日韩字符 */
function slugify(text) {
  return String(text)
    .trim()
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fff-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function formatDate(date, format = 'YYYY-MM-DD') {
  return dayjs(date).format(format);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function emptyDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  ensureDir(dir);
}

function copyDir(src, dest) {
  if (!fs.existsSync(src)) return;
  ensureDir(dest);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

/** 把数组切成每页 perPage 条的分页块，空数组也返回一个空页 */
function paginate(items, perPage) {
  const pages = [];
  for (let i = 0; i < items.length; i += perPage) {
    pages.push(items.slice(i, i + perPage));
  }
  return pages.length ? pages : [[]];
}

/** 按 posts 的某个数组字段（tags / categories）分组：{ 名称: [post...] } */
function groupByField(posts, field) {
  const groups = {};
  for (const post of posts) {
    for (const name of post[field]) {
      (groups[name] = groups[name] || []).push(post);
    }
  }
  return groups;
}

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** 去掉 HTML 标签得到纯文本摘要 */
function toExcerpt(html, length = 160) {
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length > length ? text.slice(0, length) + '…' : text;
}

function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

module.exports = {
  slugify,
  formatDate,
  ensureDir,
  emptyDir,
  copyDir,
  paginate,
  groupByField,
  escapeXml,
  toExcerpt,
  debounce,
};
