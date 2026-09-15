const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const express = require('express');
const matter = require('gray-matter');
const dayjs = require('dayjs');
const { build } = require('../src/core/generator');
const { renderMarkdown } = require('../src/core/parser');
const { slugify } = require('../src/utils');

/**
 * 本地后台管理：文章 CRUD → 读写 content/posts/*.md → 保存即重建。
 * 只监听本机回环地址，是一个本地写作工具，不随站点部署。
 */
function start(config) {
  const postsDir = path.join(config.root, config.build.contentDir, 'posts');
  fs.mkdirSync(postsDir, { recursive: true });

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use(express.static(path.join(__dirname, 'public')));

  const safeFile = (file) => {
    const base = path.basename(String(file || ''));
    if (!base.endsWith('.md') || base !== String(file)) throw new Error('非法文件名');
    return base;
  };

  const rebuild = async () => {
    try {
      return await build(config);
    } catch (err) {
      console.error('[admin] 构建失败：', err.message);
      return { posts: [] };
    }
  };

  // 文章列表（含草稿）
  app.get('/api/posts', (req, res) => {
    const posts = fs
      .readdirSync(postsDir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => {
        const { data } = matter(fs.readFileSync(path.join(postsDir, f), 'utf8'));
        return {
          file: f,
          title: data.title || f,
          date: dayjs(data.date || f.slice(0, 10)).format('YYYY-MM-DD HH:mm'),
          tags: [].concat(data.tags || []),
          categories: [].concat(data.categories || []),
          draft: !!data.draft,
        };
      })
      .sort((a, b) => new Date(b.date) - new Date(a.date));
    res.json(posts);
  });

  // 读取单篇原文
  app.get('/api/posts/:file', (req, res) => {
    try {
      const file = safeFile(req.params.file);
      const { data, content } = matter(fs.readFileSync(path.join(postsDir, file), 'utf8'));
      res.json({
        file,
        title: data.title || '',
        date: dayjs(data.date || file.slice(0, 10)).format('YYYY-MM-DD HH:mm'),
        tags: [].concat(data.tags || []),
        categories: [].concat(data.categories || []),
        draft: !!data.draft,
        content,
      });
    } catch (err) {
      res.status(404).json({ error: '文章不存在：' + err.message });
    }
  });

  // 保存（新建或更新），随后重建
  app.post('/api/posts', async (req, res) => {
    try {
      const { file, title, date, tags, categories, draft, content } = req.body || {};
      if (!title || !title.trim()) return res.status(400).json({ error: '标题不能为空' });

      const dateStr = dayjs(date || undefined).format('YYYY-MM-DD HH:mm');
      let target = file ? safeFile(file) : `${dayjs(date || undefined).format('YYYY-MM-DD')}-${slugify(title) || 'untitled'}.md`;

      // 新建时避免覆盖同名文件
      if (!file) {
        let i = 1;
        while (fs.existsSync(path.join(postsDir, target))) {
          target = target.replace(/\.md$/, `-${i++}.md`);
        }
      }

      const data = {
        title: title.trim(),
        date: dateStr,
        tags: [].concat(tags || []),
        categories: [].concat(categories || []),
        draft: !!draft,
      };
      fs.writeFileSync(path.join(postsDir, target), matter.stringify(content || '', data));

      const info = await rebuild();
      res.json({ file: target, posts: info.posts.length });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 删除，随后重建
  app.delete('/api/posts/:file', async (req, res) => {
    try {
      const file = safeFile(req.params.file);
      fs.rmSync(path.join(postsDir, file));
      await rebuild();
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Markdown 预览（与正式构建同一渲染管线）
  app.post('/api/preview', (req, res) => {
    res.json({ html: renderMarkdown((req.body && req.body.content) || '') });
  });

  const port = (config.admin && config.admin.port) || 3100;
  app.listen(port, '127.0.0.1', () => {
    console.log(`[admin] 后台管理：http://localhost:${port}`);
    console.log('[admin] 仅监听本机回环地址；写完文章记得 git commit 保存历史');
    const url = `http://localhost:${port}`;
    const opener = process.platform === 'win32' ? `start "" "${url}"` : `open "${url}"`;
    exec(opener, () => {});
  });
}

module.exports = { start };
