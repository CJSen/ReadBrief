/**
 * 输出语言定义单一数据源
 *
 * 供三处共用,避免设置 UI 与运行时链路各自维护一份语言清单:
 * 1. 设置 UI(AppSettings 外观与语言 → 输出语言下拉)
 * 2. {{language}} 模板变量替换(内置翻译提示词等)
 * 3. system 提示词末尾的语言指令注入(总结/问答/通用;翻译场景豁免)
 *
 * label 即目标语言全名,同时作为 {{language}} 的替换值;
 * 语言指令用目标语言自身书写,模型对「日本語で出力してください」
 * 的理解优于裸 code,也比「请使用日本語输出」的混搭更稳。
 */

/** 输出语言可选项(与系统提示词中的语言指令一一对应) */
export const SUMMARY_LANGUAGES: Array<{ code: string; label: string }> = [
  { code: "zh-CN", label: "简体中文" },
  { code: "zh-TW", label: "繁體中文" },
  { code: "en", label: "English" },
  { code: "ja", label: "日本語" },
  { code: "ko", label: "한국어" },
  { code: "fr", label: "Français" },
  { code: "de", label: "Deutsch" },
  { code: "es", label: "Español" },
  { code: "ru", label: "Русский" },
  { code: "pt", label: "Português" },
];

export const DEFAULT_SUMMARY_LANG = "zh-CN";

/** 旧版单值(system/zh/en)迁移到新多语言码,保证升级后选中态不丢失 */
export const LEGACY_LANG_MAP: Record<string, string> = {
  system: "zh-CN",
  zh: "zh-CN",
  en: "en",
};

/** UI 展示用归一化:非法值回退旧值映射,再回退默认语言 */
export function normalizeSummaryLang(v: string | undefined): string {
  if (v && SUMMARY_LANGUAGES.some((l) => l.code === v)) return v;
  return LEGACY_LANG_MAP[v ?? ""] ?? DEFAULT_SUMMARY_LANG;
}

/** 是否为合法输出语言 code(运行时解析用,类型谓词便于收窄) */
export function isSummaryLang(v: string | undefined): v is string {
  return !!v && SUMMARY_LANGUAGES.some((l) => l.code === v);
}

/** code → 目标语言全名(供 {{language}} 模板替换);未知 code 返回空串 */
export function summaryLangLabel(code: string): string {
  return SUMMARY_LANGUAGES.find((l) => l.code === code)?.label ?? "";
}

/** code → system 语言指令(注入到提示词末尾,约束模型输出语言) */
const LANG_INSTRUCTIONS: Record<string, string> = {
  "zh-CN": "请使用简体中文输出。",
  "zh-TW": "請使用繁體中文輸出。",
  en: "Please respond in English.",
  ja: "日本語で出力してください。",
  ko: "한국어로 출력해 주세요.",
  fr: "Veuillez répondre en français.",
  de: "Bitte antworten Sie auf Deutsch.",
  es: "Por favor, responde en español.",
  ru: "Пожалуйста, отвечайте на русском языке.",
  pt: "Por favor, responda em português.",
};

/** 取语言指令;未知 code 返回空串(不注入,避免带病指令) */
export function langInstruction(code: string): string {
  return LANG_INSTRUCTIONS[code] ?? "";
}
