export type Language = "zh" | "en";

import { useSyncExternalStore } from "react";

const zh = {
  appName: "ReadBrief",
  theme: {
    light: "浅色",
    dark: "深色",
    system: "跟随系统",
  },
  banner: {
    unconfigured: "尚未配置 AI 服务",
    unconfiguredAction: "前往设置",
  },
  float: {
    streaming: "生成中…",
    stop: "停止",
    copy: "复制",
    copied: "已复制",
    favorite: "收藏",
    retry: "重试",
    goSettings: "前往设置",
    switchProvider: "切换服务",
    selectionMode: "划词模式",
    clipboardMode: "剪贴板模式",
    historyMode: "历史记录",
    expandFull: "展开全文",
    viewOriginal: "查看原文",
    promptPlaceholder: "粘贴或输入文本，回车总结…",
  },
  history: {
    title: "历史",
    navTitle: "历史记录",
    favorites: "收藏",
    search: "搜索标题、原文或总结…",
    all: "全部",
    today: "今天",
    week: "本周",
    empty: "暂无历史记录",
    delete: "删除",
    favorite: "收藏",
    unfavorite: "取消收藏",
    copy: "复制",
    regenerate: "重新生成",
    original: "原文 · {n} 字",
    createTag: "新建标签",
    createTagPlaceholder: "标签名称，回车创建",
    color: "颜色",
    custom: "自定义",
    tagThis: "为这条记录打标签",
    newTagPlaceholder: "新建标签，回车添加",
    maxTags: "已达上限（最多 4 个标签）",
    addTag: "添加标签",
    tags: "标签",
    searchTags: "搜索标签",
    backToTop: "回到顶部",
    clear: "清空",
    deleteTag: "删除标签",
    editTag: "编辑标签",
    editTagPlaceholder: "标签名称，回车保存",
    confirmDeleteTag: "删除标签「{name}」？该标签将从所有记录中移除。",
    cancel: "取消",
    close: "关闭",
  },
  prompts: {
    title: "提示词",
    new: "新建提示词",
    pro: "Pro",
    reachLimit: "免费版最多 3 个提示词",
  },
  shortcuts: {
    title: "快捷键",
    record: "录制快捷键",
    reachLimit: "免费版最多 2 个快捷键",
    conflict: "快捷键冲突",
  },
  settings: {
    title: "设置",
    nav: {
      general: "通用",
      ai: "AI 服务",
      shortcuts: "快捷键",
      prompts: "提示词",
      appearance: "外观与语言",
      privacy: "隐私与数据",
      subscription: "订阅",
      about: "关于",
    },
    aiService: "AI 服务",
    testConnection: "测试连接",
    testing: "测试中…",
    connected: "连接成功",
    error: "连接失败",
    apiKey: "API Key",
    model: "模型",
    baseUrl: "Base URL(可选)",
    openai: "OpenAI 格式",
    claude: "Claude 格式",
    gemini: "Gemini 格式",
    language: "语言",
    theme: "主题",
  },
  errors: {
    auth: "密钥无效或已过期，请检查是否完整粘贴",
    rate_limit: "请求受限或额度不足，请稍后重试",
    network: "网络异常，请检查代理设置",
    unknown: "发生未知错误",
  },
};

const en: typeof zh = {
  appName: "ReadBrief",
  theme: {
    light: "Light",
    dark: "Dark",
    system: "System",
  },
  banner: {
    unconfigured: "AI service not configured",
    unconfiguredAction: "Go to Settings",
  },
  float: {
    streaming: "Generating…",
    stop: "Stop",
    copy: "Copy",
    copied: "Copied",
    favorite: "Favorite",
    retry: "Retry",
    goSettings: "Go to Settings",
    switchProvider: "Switch Provider",
    selectionMode: "Selection mode",
    clipboardMode: "Clipboard mode",
    historyMode: "History",
    expandFull: "Expand full text",
    viewOriginal: "View original text",
    promptPlaceholder: "Paste or type text, Enter to summarize…",
  },
  history: {
    title: "History",
    navTitle: "History",
    favorites: "Favorites",
    search: "Search title, source or summary…",
    all: "All",
    today: "Today",
    week: "Week",
    empty: "No history yet",
    delete: "Delete",
    favorite: "Favorite",
    unfavorite: "Unfavorite",
    copy: "Copy",
    regenerate: "Regenerate",
    original: "Original · {n} chars",
    createTag: "New tag",
    createTagPlaceholder: "Tag name, Enter to create",
    color: "Color",
    custom: "Custom",
    tagThis: "Tag this record",
    newTagPlaceholder: "New tag, Enter to add",
    maxTags: "Limit reached (up to 4 tags)",
    addTag: "Add tag",
    tags: "Tags",
    searchTags: "Search tags",
    backToTop: "Back to top",
    clear: "Clear",
    deleteTag: "Delete tag",
    editTag: "Edit tag",
    editTagPlaceholder: "Tag name, Enter to save",
    confirmDeleteTag: "Delete tag \"{name}\"? It will be removed from all records.",
    cancel: "Cancel",
    close: "Close",
  },
  prompts: {
    title: "Prompts",
    new: "New Prompt",
    pro: "Pro",
    reachLimit: "Free plan allows up to 3 prompts",
  },
  shortcuts: {
    title: "Shortcuts",
    record: "Record Shortcut",
    reachLimit: "Free plan allows up to 2 shortcuts",
    conflict: "Shortcut conflict",
  },
  settings: {
    title: "Settings",
    nav: {
      general: "General",
      ai: "AI Services",
      shortcuts: "Shortcuts",
      prompts: "Prompts",
      appearance: "Appearance & Language",
      privacy: "Privacy & Data",
      subscription: "Subscription",
      about: "About",
    },
    aiService: "AI Service",
    testConnection: "Test Connection",
    testing: "Testing…",
    connected: "Connected",
    error: "Connection failed",
    apiKey: "API Key",
    model: "Model",
    baseUrl: "Base URL (optional)",
    openai: "OpenAI format",
    claude: "Claude format",
    gemini: "Gemini format",
    language: "Language",
    theme: "Theme",
  },
  errors: {
    auth: "Invalid or expired API key. Check it was pasted completely",
    rate_limit: "Rate limited or quota exceeded. Try again later",
    network: "Network error. Check your proxy settings",
    unknown: "An unknown error occurred",
  },
};

export const messages: Record<Language, typeof zh> = { zh, en };

let currentLanguage: Language = "zh";
const listeners = new Set<() => void>();

export function setLanguage(lang: Language): void {
  currentLanguage = lang;
  listeners.forEach((fn) => fn());
}

export function getLanguage(): Language {
  return currentLanguage;
}

export function t(key: string, params?: Record<string, string | number>): string {
  const parts = key.split(".");
  let value: unknown = messages[currentLanguage];
  for (const part of parts) {
    if (value && typeof value === "object") {
      value = (value as Record<string, unknown>)[part];
    }
  }
  if (typeof value !== "string") return key;
  if (!params) return value;
  return value.replace(/\{(\w+)\}/g, (_, k: string) =>
    params[k] !== undefined ? String(params[k]) : `{${k}}`,
  );
}

export function subscribeLanguage(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 订阅语言变更的 hook:语言切换时触发组件重渲染(已打开的窗口即时生效) */
export function useLanguage(): Language {
  return useSyncExternalStore(subscribeLanguage, getLanguage);
}
