---
title: 你好，博客
date: 2026-09-15 12:00
tags: [随笔, 开始]
categories: 生活
draft: false
---

[[toc]]

这是博客的第一篇文章，用来验证生成器的各项能力。

## Markdown 渲染

支持**加粗**、*斜体*、`行内代码`，以及[链接](https://nodejs.org)。

## 代码高亮

```js
function greet(name) {
  console.log(`你好，${name}！`);
}

greet('世界');
```

## 列表与引用

- 文章：Markdown 文件 + front-matter
- 构建：`npm run build`
- 预览：`npm run serve`

> 好记性不如烂笔头。写博客是把想法变成文字的过程。

## 表格

| 命令 | 作用 |
| --- | --- |
| `npm run build` | 构建静态站点 |
| `npm run serve` | 本地预览 |
| `npm run admin` | 后台管理 |

## 下一步

删除这篇文章，用 `npm run new -- "我的文章"` 开始写你自己的内容。
