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
    clearSelectedTags: "清空已选标签筛选",
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
    openOnboarding: "打开引导",
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
    modelPlaceholder: "输入或选择模型",
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
  onboarding: {
    step: "第 {n} / 4 步 · {name}",
    welcomeTitle: "欢迎使用 ReadBrief",
    welcomeDesc: "本向导将引导你完成基础配置，只需几分钟，就能开始划词总结了。",
    welcome1: "连接 AI 服务",
    welcome2: "开启系统权限",
    welcome3: "设置划词快捷键",
    aiTitle: "配置 AI 服务",
    aiDesc: "选择服务商与模型，几分钟即可开始划词总结。",
    format: "格式",
    name: "名称",
    baseUrlFallback: "未填 Base URL 时，自动使用所选格式对应的官方地址。",
    stream: "流式输出",
    test: "测试连接",
    connectedMs: "响应 {ms}ms",
    connectFailed: "连接失败",
    permsTitle: "开启系统权限",
    permsDesc: "划词总结需要以下权限。可稍后在设置中开启，不影响其他功能使用。",
    accessibility: "辅助功能",
    accessibilityDesc: "用于划词监听选中文本",
    screen: "屏幕录制",
    screenDesc: "用于截图总结",
    grant: "去开启",
    granted: "已授权",
    detecting: "检测中…",
    screenRestartHint: "已申请授权，重启软件后生效。可先继续完成引导，或重启后从这里接着进行。",
    launchOnStart: "开机启动",
    launchOnStartDesc: "登录系统后自动运行 ReadBrief",
    shortcutTitle: "设置划词总结快捷键",
    shortcutDesc: "点击右侧按钮开始录制，或直接保留默认组合。之后可在设置中随时修改。",
    shortcutLabel: "划词总结",
    recording: "等待按键…",
    skip: "跳过引导",
    next: "下一步",
    done: "完成",
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
    clearSelectedTags: "Clear tag filter",
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
    openOnboarding: "Open setup guide",
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
    modelPlaceholder: "Enter or select a model",
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
  onboarding: {
    step: "Step {n} / 4 · {name}",
    welcomeTitle: "Welcome to ReadBrief",
    welcomeDesc: "This quick setup gets you ready to summarize selections in a few minutes.",
    welcome1: "Connect an AI service",
    welcome2: "Grant system permissions",
    welcome3: "Set the summary shortcut",
    aiTitle: "Configure AI service",
    aiDesc: "Pick a provider and model, then start summarizing in minutes.",
    format: "Format",
    name: "Name",
    baseUrlFallback: "Leave Base URL empty to use the official endpoint for the selected format.",
    stream: "Stream output",
    test: "Test connection",
    connectedMs: "{ms}ms",
    connectFailed: "Connection failed",
    permsTitle: "Grant system permissions",
    permsDesc: "Selection summary needs these permissions. You can enable them later in Settings.",
    accessibility: "Accessibility",
    accessibilityDesc: "Reads the selected text for selection summary",
    screen: "Screen Recording",
    screenDesc: "For screenshot summary",
    grant: "Grant",
    granted: "Granted",
    detecting: "Detecting…",
    screenRestartHint: "Permission requested. It takes effect after restarting the app. You can finish the guide now, or resume from here after restart.",
    launchOnStart: "Launch on startup",
    launchOnStartDesc: "Run ReadBrief automatically after you log in",
    shortcutTitle: "Set the summary shortcut",
    shortcutDesc: "Click the button to record, or keep the default combo. Change it anytime in Settings.",
    shortcutLabel: "Selection summary",
    recording: "Press keys…",
    skip: "Skip setup",
    next: "Next",
    done: "Done",
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
