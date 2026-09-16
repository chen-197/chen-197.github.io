const path = require('path');
const { build } = require('./generator');
const { debounce } = require('../utils');

/**
 * 本地预览：构建（含草稿 + livereload）→ 静态服务 dist/ → 监听内容/主题变化自动重建。
 * 页面里的 livereload 脚本轮询 /__version，版本变化即刷新浏览器。
 */
async function serve(config) {
  const express = require('express');
  const { watch } = await import('chokidar');

  let version = 0;
  const rebuild = async () => {
    try {
      const { posts } = await build(config, { dev: true, drafts: true });
      version++;
      console.log(`[serve] 构建完成（${posts.length} 篇文章，v${version}）`);
    } catch (err) {
      console.error('[serve] 构建失败：', err.message);
    }
  };

  await rebuild();

  const app = express();
  app.get('/__version', (req, res) => res.json({ version }));
  app.use(express.static(path.join(config.root, config.build.outputDir)));

  const port = (config.dev && config.dev.port) || 3000;
  app.listen(port, () => {
    console.log(`[serve] 预览地址：http://localhost:${port}`);
    console.log('[serve] 监听 content/ 与 themes/ 变化，保存即自动刷新');
  });

  const targets = [
    path.join(config.root, config.build.contentDir),
    path.join(config.root, 'themes', config.build.theme),
    path.join(config.root, 'blog.config.js'),
  ];
  watch(targets, { ignoreInitial: true }).on('all', debounce(rebuild, 200));
}

module.exports = { serve };
