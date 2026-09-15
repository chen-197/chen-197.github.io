const fs = require('fs');
const path = require('path');
const { loadPosts, loadPages } = require('./parser');
const { createRenderer } = require('./renderer');
const {
  ensureDir,
  emptyDir,
  copyDir,
  paginate,
  groupByField,
  escapeXml,
} = require('../utils');

/**
 * 全量构建：扫描 content/ 下的 Markdown，生成纯静态站点到 dist/。
 * options.dev     注入 livereload 脚本（本地预览用）
 * options.drafts  包含草稿文章
 */
async function build(config, options = {}) {
  const root = config.root;
  const contentDir = path.join(root, config.build.contentDir);
  const outputDir = path.join(root, config.build.outputDir);
  const themeDir = path.join(root, 'themes', config.build.theme);

  const posts = loadPosts(contentDir, { drafts: options.drafts });
  const pages = loadPages(contentDir);
  const render = createRenderer(themeDir, {
    site: config.site,
    giscus: config.giscus,
    dev: !!options.dev,
  });

  emptyDir(outputDir);
  const urls = [];

  async function output(urlPath, html) {
    const filePath = urlPath.endsWith('.xml')
      ? path.join(outputDir, urlPath.slice(1))
      : path.join(outputDir, urlPath, 'index.html');
    ensureDir(path.dirname(filePath));
    await fs.promises.writeFile(filePath, html);
    if (!urlPath.endsWith('.xml')) urls.push(urlPath);
  }

  // 文章页（prev = 更早一篇，next = 更新一篇）
  for (let i = 0; i < posts.length; i++) {
    await output(
      posts[i].url,
      await render('post', {
        post: posts[i],
        prev: posts[i + 1] || null,
        next: posts[i - 1] || null,
        pageTitle: posts[i].title,
      })
    );
  }

  // 首页分页
  const chunks = paginate(posts, config.build.perPage);
  for (let i = 0; i < chunks.length; i++) {
    await output(
      i === 0 ? '/' : `/page/${i + 1}/`,
      await render('index', {
        posts: chunks[i],
        pagination: { current: i + 1, total: chunks.length },
        pageTitle: i === 0 ? null : `第 ${i + 1} 页`,
      })
    );
  }

  // 归档
  await output('/archives/', await render('archives', { posts, pageTitle: '归档' }));

  // 标签 / 分类：汇总页 + 每个条目一页
  for (const [field, base, tpl, singleTpl, label] of [
    ['tags', '/tags', 'tags', 'tag', '标签'],
    ['categories', '/categories', 'categories', 'category', '分类'],
  ]) {
    const groups = groupByField(posts, field);
    const list = Object.entries(groups)
      .map(([name, items]) => ({ name, count: items.length }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    await output(`${base}/`, await render(tpl, { list, pageTitle: label }));
    for (const [name, items] of Object.entries(groups)) {
      await output(
        `${base}/${encodeURIComponent(name)}/`,
        await render(singleTpl, { name, posts: items, pageTitle: `${label}：${name}` })
      );
    }
  }

  // 独立页面（关于等）
  for (const page of pages) {
    await output(page.url, await render('page', { page, pageTitle: page.title }));
  }

  // 404
  await output('/404/', await render('404', { pageTitle: '页面不存在' }));

  // RSS 与站点地图
  await output('/feed.xml', renderFeed(config, posts));
  await output('/sitemap.xml', renderSitemap(config, urls));

  // 静态资源：主题 assets、文章图片、代码高亮样式
  copyDir(path.join(themeDir, 'assets'), path.join(outputDir, 'assets'));
  copyDir(path.join(contentDir, 'images'), path.join(outputDir, 'images'));
  fs.copyFileSync(
    require.resolve('highlight.js/styles/github.css'),
    path.join(outputDir, 'assets', 'hljs.css')
  );

  return { posts, urls };
}

function renderFeed(config, posts) {
  const items = posts
    .slice(0, 20)
    .map(
      (p) => `    <item>
      <title>${escapeXml(p.title)}</title>
      <link>${config.site.url}${p.url}</link>
      <guid>${config.site.url}${p.url}</guid>
      <pubDate>${p.date.toUTCString()}</pubDate>
      <description>${escapeXml(p.excerpt)}</description>
    </item>`
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${escapeXml(config.site.title)}</title>
    <link>${config.site.url}</link>
    <description>${escapeXml(config.site.description)}</description>
    <language>${config.site.language}</language>
${items}
  </channel>
</rss>
`;
}

function renderSitemap(config, urls) {
  const entries = urls
    .filter((u) => u !== '/404/')
    .map((u) => `  <url><loc>${config.site.url}${u}</loc></url>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries}
</urlset>
`;
}

module.exports = { build };
