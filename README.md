# 个人博客（自研 Node.js 静态站点生成器）

Markdown 写文章 → 自研生成器构建成纯静态 HTML → 部署到 GitHub Pages。写作在本地后台完成，内容用 Git 管理。

## 快速开始

```bash
npm install        # 安装依赖（首次）
npm run serve      # 本地预览 http://localhost:3000，改文件自动刷新
npm run admin      # 本地后台 http://localhost:3100，网页上写文章
npm run build      # 构建生产版本到 dist/（不含草稿）
npm run new -- "文章标题"   # 命令行新建文章（草稿）
```

## 日常写作流程

1. `npm run admin` 打开后台（或 `npm run new -- "标题"` 新建后手动编辑）
2. 在后台写 Markdown，右侧实时预览，`Ctrl+S` 保存
3. 保存即自动重建 `dist/`；取消"草稿"勾选文章才会进入正式构建
4. `git add . && git commit -m "新文章"` 保存内容历史
5. push 到 GitHub 后，Actions 自动构建并部署到 Pages

## 目录说明

| 路径 | 作用 |
| --- | --- |
| `content/posts/` | 文章，文件名 `YYYY-MM-DD-slug.md` |
| `content/pages/` | 独立页面（关于等），生成在 `/<文件名>/` |
| `content/images/` | 文章图片，Markdown 里引用 `/images/xxx.png` |
| `src/` | 生成器源码（parser / generator / renderer / watcher） |
| `themes/default/` | 主题：EJS 模板 + CSS，可整体复制出新主题 |
| `admin/` | 本地后台管理（Express，只监听 127.0.0.1） |
| `blog.config.js` | 站点标题、作者、URL、分页、giscus 评论配置 |
| `dist/` | 构建输出，部署的就是这个目录 |

## 文章 front-matter

```yaml
---
title: 文章标题
date: 2026-09-15 14:00        # 创建/发布时间
updated: 2026-09-16 10:00     # 修改时间（可选；不写则自动取 git 最后提交时间，未提交的新文件取文件时间）
tags: [nodejs, 架构]          # 多个标签
categories: 技术               # 一个或多个
draft: false                   # true = 草稿，正式构建时跳过
description: 可选，自定义摘要（默认自动截取正文）
---
```

文章页和首页卡片会显示「发表于 X · 更新于 Y」（修改时间比创建时间晚超过一天才显示"更新于"）；**文章列表按修改时间倒序排列**。修改时间的自动检测依赖 git 历史，因此 CI 部署用了完整 checkout（`fetch-depth: 0`），后台编辑文章时"更新于"一栏留空即可自动检测。

正文里写 `[[toc]]` 会在该处插入文章目录；代码块自动高亮。

## 开启评论（giscus）

评论基于 GitHub Discussions，访客用 GitHub 账号留言：

1. 把博客仓库设为 **public**，并开启 Discussions（仓库 Settings → Features → Discussions）
2. 安装 [giscus App](https://github.com/apps/giscus) 到该仓库
3. 打开 [giscus.app/zh-CN](https://giscus.app/zh-CN)，填入仓库名，复制生成的 `repo`、`repoId`、`categoryId`
4. 填入 `blog.config.js` 的 `giscus` 配置并设 `enabled: true`，重新构建

## 部署到 GitHub Pages

1. 在 GitHub 新建仓库（如 `username.github.io` 或任意名），把本项目 push 到 `main` 分支
2. 仓库 Settings → Pages → Source 选择 **GitHub Actions**
3. 之后每次 push，`.github/workflows/deploy.yml` 会自动构建并发布
4. 把 `blog.config.js` 里的 `site.url` 改成你的 Pages 地址（如 `https://username.github.io`），RSS 和 sitemap 会用它

> 如果仓库名不是 `username.github.io`，站点会发布在 `/仓库名/` 子路径下，模板里的绝对路径（`/assets/...`）需要相应调整，或给仓库绑定自定义域名。

## 换主题

内置两套主题，在 `blog.config.js` 把 `build.theme` 改成主题名即可：

- `default` —— 花园暖色：米色纸面、叶绿、陶土玫瑰
- `blossom` —— 粉色鲜花：樱花粉白、玫瑰粉、花芯黄，圆角与弹跳动效

想自己做主题：复制 `themes/default` 为 `themes/xxx`，改 `build.theme` 为 `xxx`。模板里可用的全局数据：`site`、`giscus`、`dev`、`encodeURIComponent`。
