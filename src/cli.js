const fs = require('fs');
const path = require('path');
const dayjs = require('dayjs');
const config = require('../blog.config');
const { slugify } = require('./utils');

config.root = path.resolve(__dirname, '..');

const [cmd, ...args] = process.argv.slice(2);

const commands = {
  // 全量构建到 dist/
  build: () =>
    require('./core/generator')
      .build(config)
      .then(({ posts }) => console.log(`[build] 完成：${posts.length} 篇文章 → ${config.build.outputDir}/`))
      .catch((err) => {
        console.error('[build] 失败：', err);
        process.exit(1);
      }),

  // 本地预览 + 自动重建
  serve: () => require('./core/watcher').serve(config),

  // 新建文章：node src/cli.js new 文章标题
  new: () => {
    const title = args.join(' ').trim();
    if (!title) {
      console.error('用法：npm run new -- "文章标题"');
      process.exit(1);
    }
    const now = dayjs();
    const slug = slugify(title) || 'untitled';
    const postsDir = path.join(config.root, config.build.contentDir, 'posts');
    const file = path.join(postsDir, `${now.format('YYYY-MM-DD')}-${slug}.md`);
    if (fs.existsSync(file)) {
      console.error(`文件已存在：${file}`);
      process.exit(1);
    }
    fs.mkdirSync(postsDir, { recursive: true });
    fs.writeFileSync(
      file,
      `---
title: ${title}
date: ${now.format('YYYY-MM-DD HH:mm')}
tags: []
categories:
draft: true
---

[[toc]]

在这里开始写作…

> 提示：文章保存为草稿（draft: true），发布前把 draft 改为 false。
`
    );
    console.log(`已创建：${path.relative(config.root, file)}`);
  },

  // 本地后台管理
  admin: () => require('../admin/server').start(config),
};

if (!commands[cmd]) {
  console.log(`用法：node src/cli.js <命令>

命令：
  build   全量构建静态站点到 dist/
  serve   本地预览（含草稿），改动自动重建刷新
  new     新建文章，如：npm run new -- "文章标题"
  admin   启动本地后台管理
`);
  process.exit(cmd ? 1 : 0);
}

commands[cmd]();
