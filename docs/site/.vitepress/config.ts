import { defineConfig } from 'vitepress'

// 官网独立存放于 docs/site/，与 docs/ 下的项目内部文档目录（01-需求与规划 等）互不干扰，
// 无需 srcExclude；docs/site 目录本身即 VitePress 站点根。

export default defineConfig({
  title: 'ReadBrief',
  titleTemplate: ':title · ReadBrief',
  description: '划词即总结 · macOS 上的 AI 划词总结桌面助手',
  lang: 'zh-CN',
  // 部署到 GitHub Pages 项目页：https://cjsen.github.io/ReadBrief/
  base: '/ReadBrief/',
  cleanUrls: true,
  lastUpdated: true,

  head: [
    // 注意：head 中的资源 URL 不会被 VitePress 自动加 base，部署到子路径需手动前缀 /ReadBrief/
    ['link', { rel: 'icon', href: '/ReadBrief/favicon.png' }],
    ['link', { rel: 'apple-touch-icon', href: '/ReadBrief/logo.png' }],
    ['meta', { name: 'theme-color', content: '#4B4BC8' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:title', content: 'ReadBrief · 划词即总结' }],
    ['meta', { property: 'og:description', content: 'macOS 上的 AI 划词总结桌面助手：选中文字，按下快捷键，AI 流式生成要点总结，浮窗出现在光标附近。' }],
    ['meta', { property: 'og:image', content: '/ReadBrief/logo.png' }],
  ],

  themeConfig: {
    logo: '/logo.png',
    siteTitle: '<span class="rb-logo-word">ReadBrief</span>',

    nav: [
      { text: '首页', link: '/' },
      {
        text: '功能',
        link: '/features',
        activeMatch: '^/features',
      },
      {
        text: '指南',
        link: '/guide/install',
        activeMatch: '^/guide/',
        items: [
          { text: '安装与权限', link: '/guide/install' },
          { text: '配置 AI 服务', link: '/guide/ai-setup' },
          { text: '划词总结', link: '/guide/usage' },
          { text: '快捷键', link: '/guide/shortcuts' },
          { text: '提示词管理', link: '/guide/prompts' },
          { text: '隐私与数据', link: '/guide/privacy' },
        ],
      },
      { text: '架构', link: '/architecture', activeMatch: '^/architecture' },
      { text: '常见问题', link: '/faq', activeMatch: '^/faq' },
      { text: '下载', link: '/download', activeMatch: '^/download' },
    ],

    sidebar: {
      '/guide/': [
        {
          text: '快速开始',
          items: [
            { text: '安装与权限', link: '/guide/install' },
            { text: '配置 AI 服务', link: '/guide/ai-setup' },
            { text: '划词总结', link: '/guide/usage' },
          ],
        },
        {
          text: '效率进阶',
          items: [
            { text: '快捷键', link: '/guide/shortcuts' },
            { text: '提示词管理', link: '/guide/prompts' },
            { text: '隐私与数据', link: '/guide/privacy' },
          ],
        },
        {
          text: '更多',
          items: [
            { text: '常见问题', link: '/faq' },
            { text: '路线图', link: '/roadmap' },
          ],
        },
      ],
    },

    outline: {
      label: '本页导航',
      level: [2, 3],
    },

    docFooter: {
      prev: '上一篇',
      next: '下一篇',
    },

    search: {
      provider: 'local',
      options: {
        translations: {
          button: { buttonText: '搜索文档', buttonAriaLabel: '搜索文档' },
          modal: {
            noResultsText: '未找到相关结果',
            resetButtonTitle: '清除查询',
            footer: { selectText: '选择', navigateText: '切换', closeText: '关闭' },
          },
        },
      },
    },

    footer: {
      message: '从选中文字到看见结论，只隔一个快捷键',
      copyright: '© 2026 ReadBrief · 划词即总结',
    },

    lastUpdated: {
      text: '最后更新于',
      formatOptions: { dateStyle: 'medium', timeStyle: 'short' },
    },
  },
})
