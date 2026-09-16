module.exports = {
  site: {
    title: '我的博客',
    subtitle: '记录与学习',
    description: '个人博客：技术、生活与思考',
    author: 'chen',
    language: 'zh-CN',
    // 部署后的站点地址，用于 RSS / sitemap / giscus 回链
    url: 'https://chen-197.github.io',
  },
  build: {
    contentDir: 'content',
    outputDir: 'dist',
    theme: 'blossom', // 可选：default（花园暖色）/ blossom（粉色鲜花）
    perPage: 10, // 首页每页文章数
  },
  dev: {
    port: 3000, // npm run serve 预览端口
  },
  admin: {
    port: 3100, // npm run admin 后台端口
  },
  // giscus 评论：按 https://giscus.app/zh-CN 指引生成后填入，enabled 置为 true
  giscus: {
    enabled: false,
    repo: '',
    repoId: '',
    category: 'Announcements',
    categoryId: '',
    mapping: 'pathname',
    theme: 'light',
  },
};
