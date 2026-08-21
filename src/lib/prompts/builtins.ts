import type { PromptConfig } from "../config/types";

/**
 * 内置提示词单一数据源（P1-1）
 *
 * 此前 BUILTIN_PROMPTS 在 PromptManager / ShortcutsPage / AppFloat 三处各持一份
 * 独立副本，导致绑定内置提示词到快捷键时静默失效（resolvePrompt 只查用户提示词）、
 * 默认总结文案三处脱节。本模块是唯一的定义处，其余组件一律从这里引用。
 */
export const BUILTIN_PROMPTS: PromptConfig[] = [
  {
    id: "builtin-summarize",
    name: "总结提示词",
    content: "用要点概括以下内容，提炼核心信息：{{text}}",
    model: "",
    shortcut: null,
    outputFormat: "md",
    isBuiltin: true,
    tag: "summary",
  },
  {
    id: "builtin-translate",
    name: "翻译提示词",
    // {{language}} 在发送前替换为「输出语言」设置的目标语言全名(如 日本語)
    content: "将以下内容翻译为{{language}}：{{text}}",
    model: "",
    shortcut: null,
    outputFormat: "md",
    isBuiltin: true,
    tag: "translate",
  },
  {
    id: "builtin-qa",
    name: "问答提示词",
    content: "基于以下内容回答用户的问题：{{text}}",
    model: "",
    shortcut: null,
    outputFormat: "md",
    isBuiltin: true,
    tag: "qa",
  },
];

/** 内置提示词图标配色（PromptManager 卡片用） */
export const BUILTIN_ICONS: Record<string, { icon: string; bg: string; fg: string }> = {
  "builtin-summarize": { icon: "list", bg: "var(--rb-brand-50)", fg: "var(--rb-brand-600)" },
  "builtin-translate": { icon: "translate", bg: "var(--rb-success-bg)", fg: "var(--rb-success)" },
  "builtin-qa": { icon: "question", bg: "var(--rb-marker-50)", fg: "var(--rb-marker-600)" },
};

/**
 * 角色基线:按提示词类别分化(划词ai xx 助手)。
 * - summary → 总结助手;translate → 翻译助手;qa → 问答助手;general → 划词ai助手。
 */
export const DEFAULT_SYSTEM: Record<PromptTag, { zh: string; en: string }> = {
  summary: { zh: "你是 ReadBrief 的划词ai总结助手。", en: "You are the ReadBrief AI summary assistant." },
  translate: { zh: "你是 ReadBrief 的划词ai翻译助手。", en: "You are the ReadBrief AI translation assistant." },
  qa: { zh: "你是 ReadBrief 的划词ai问答助手。", en: "You are the ReadBrief AI Q&A assistant." },
  general: { zh: "你是 ReadBrief 的划词ai助手。", en: "You are the ReadBrief AI assistant." },
};

/** 按 tag + 语言取角色基线;非法 tag 回退 summary */
export function getRole(tag: string, lang: "zh" | "en"): string {
  const e = DEFAULT_SYSTEM[tag as PromptTag] ?? DEFAULT_SYSTEM.summary;
  return lang === "en" ? e.en : e.zh;
}

/**
 * 总结类格式规则:追加到角色基线之后,强制模型以「分隔符式纯文本」产出 [标题行 + 编号要点列表]。
 * 目的:让模型在同一次回复里产出独立短标题 + 要点,无需二次调用,且不重发原文(省 token / 降延迟)。
 * 标题 6-15 字（不足 6 字仍用原长度，不强行补）；正文直接编号列表，无一句话结论、无分区标题。
 *
 * 为什么这样写（提示词工程要点）：
 * - 给字数参照物：「约 2-4 个词语的短语」让模型对 6-15 字有直观感受，而非抽象的数字
 * - 明确违规后果：「超过 15 字会被截断、少于 6 字不合格」，模型知道长度是硬约束而非建议
 * - 两步法：「先提炼核心主题 → 再压缩成短语」，化解"概括完整 vs 长度受限"的指令冲突
 * - 合格/不合格示例各一：给模型可模仿的标题模板，降低随机性
 */
export const SUMMARY_FORMAT_RULE_ZH = `输出格式要求(必须严格遵守,格式违规的输出会被系统直接丢弃):
1. 第一行 = 标题,只写这一行标题:
   - 长度必须为 6-15 个字符(约 2-4 个词语组成的短语,不是完整句子)。
   - 后果:标题超过 15 个字符会被系统截断,少于 6 个字符会被判定不合格 —— 请严格落在 6-15 字符区间。
   - 写法:先提炼全文核心主题,再压缩成最简短语;不要加「标题:」「总结:」等前缀,不要用 # 号。
   - 合格示例:「新能源汽车电池技术趋势」(11字);不合格示例:「汽车电池技术的发展现状与未来趋势分析」(18字,超过15字)。
2. 第二行起 = 正文:直接以编号列表(1. 2. 3. ...)逐条列出核心要点,每条精炼准确;要点数量不限。
3. 正文不要先写"一句话结论"段落,也不要输出「核心要点」「帖子总结」等分区标题,直接给要点列表。
4. 不要输出任何思考/推理过程,直接给出总结。`;

export const SUMMARY_FORMAT_RULE_EN = `Output format (must be followed exactly; any violation causes the output to be discarded):
1. Line 1 = the title only:
   - Length must be 6-15 characters (a short phrase of about 2-4 words, NOT a full sentence).
   - Consequence: titles over 15 characters will be truncated by the system; under 6 characters are judged invalid — strictly stay within 6-15.
   - How: first extract the core topic, then compress it into the shortest phrase; no prefixes like 'Title:', no '#' symbols.
   - OK example: 「新能源汽车电池技术趋势」(11 chars); BAD example: 「汽车电池技术的发展现状与未来趋势分析」(18 chars, over 15).
2. From line 2 = the body: list key points directly as a numbered list (1. 2. 3. ...), each concise; any number of points is fine.
3. Do not add a one-sentence conclusion paragraph, and do not output section headings like 'Summary' or 'Key Points'.
4. Do not output any reasoning; give the summary directly.`;

/**
 * 翻译类格式规则:首行以「翻译：」开头作为标题,其后直接输出译文正文。
 * 与总结类不同,正文不强制编号列表,而是原样译文,以贴合翻译场景。
 */
export const TRANSLATE_FORMAT_RULE_ZH = `输出格式要求(必须严格遵守):
1. 第一行以「翻译：」开头作为标题(其后可跟一句极简说明,如原文主题),标题长度必须为 6-15 个字符;超过 15 个字符会被系统截断,少于 6 个字符判定不合格。
2. 从第二行起直接输出译文正文,保留原意与语气,不要编号列表、不要额外总结。
3. 不要输出任何思考/推理过程,直接给出译文。`;

export const TRANSLATE_FORMAT_RULE_EN = `Output format (must be followed exactly):
1. Line 1 starts with "Translate: " as the title (optionally followed by a very short note, e.g. the topic); the title must be 6-15 characters; over 15 is truncated, under 6 is invalid.
2. From line 2 output the translated text directly, preserving meaning and tone; no numbered list, no extra summary.
3. Do not output any reasoning; give the translation directly.`;

/**
 * 问答类格式规则:首行以「问答：」开头作为标题,其后直接输出答案正文。
 */
export const QA_FORMAT_RULE_ZH = `输出格式要求(必须严格遵守):
1. 第一行以「问答：」开头作为标题(可跟一句极简说明),标题长度必须为 6-15 个字符;超过 15 个字符会被系统截断,少于 6 个字符判定不合格。
2. 从第二行起直接输出答案正文,像普通 AI 问答一样自由作答,不做额外格式限制。`;

export const QA_FORMAT_RULE_EN = `Output format (must be followed exactly):
1. Line 1 starts with "QA: " as the title (optionally followed by a very short note); the title must be 6-15 characters; over 15 is truncated, under 6 is invalid.
2. From line 2 output the answer freely, just like a normal AI Q&A, with no extra format restrictions.`;

/** 提示词类别 */
export type PromptTag = "summary" | "translate" | "qa" | "general";

/**
 * 通用类格式规则:仅强制「首行标题 6-15 字」,正文完全听提示词(润色/提取等)自由发挥。
 */
export const GENERAL_FORMAT_RULE_ZH = `输出格式要求(必须严格遵守):
1. 第一行 = 标题,只写这一行标题,长度必须为 6-15 个字符;超过 15 个字符会被系统截断,少于 6 个字符判定不合格。不要加「标题:」等前缀,不要用 # 号。
2. 从第二行起直接输出正文,按提示词要求自由发挥(如润色、提取关键词),不要强行编号列表、不要额外总结(除非提示词本身要求)。
3. 不要输出任何思考/推理过程,直接给出结果。`;

export const GENERAL_FORMAT_RULE_EN = `Output format (must be followed exactly):
1. Line 1 = the title only, 6-15 characters; over 15 is truncated, under 6 is invalid. No prefixes like 'Title:', no '#'.
2. From line 2 output the body freely per the prompt (e.g. polish, extract keywords); no forced numbered list, no extra summary unless the prompt asks.
3. Do not output any reasoning; give the result directly.`;

/**
 * 按类别取系统提示词里的「格式规则」(追加到角色基线之后)。
 */
export const TAG_FORMAT_RULES: Record<PromptTag, { zh: string; en: string }> = {
  summary: { zh: SUMMARY_FORMAT_RULE_ZH, en: SUMMARY_FORMAT_RULE_EN },
  translate: { zh: TRANSLATE_FORMAT_RULE_ZH, en: TRANSLATE_FORMAT_RULE_EN },
  qa: { zh: QA_FORMAT_RULE_ZH, en: QA_FORMAT_RULE_EN },
  general: { zh: GENERAL_FORMAT_RULE_ZH, en: GENERAL_FORMAT_RULE_EN },
};

/** 类别中文标签(UI 展示) */
export const TAG_LABELS: Record<PromptTag, string> = {
  summary: "总结",
  translate: "翻译",
  qa: "问答",
  general: "通用",
};

/** 类别功能简介(hover 「?」时显示，力求简要好懂) */
export const TAG_TIPS: Record<PromptTag, string> = {
  summary: "对选中文本做摘要，提炼要点",
  translate: "将选中文本翻译为目标语言",
  qa: "围绕选中文本/输入的问题提问与解答",
  general: "不限场景，按提示词自由发挥",
};

/** UI 可选的类别列表(顺序即展示顺序) */
export const TAG_OPTIONS: PromptTag[] = ["summary", "translate", "qa", "general"];

/** 按 tag + 语言取格式规则;非法 tag 回退 summary */
export function getFormatRule(tag: string, lang: "zh" | "en"): string {
  const entry = TAG_FORMAT_RULES[tag as PromptTag] ?? TAG_FORMAT_RULES.summary;
  return lang === "en" ? entry.en : entry.zh;
}

/** 按 id 查找内置提示词（id 缺失时返回 undefined） */
export function findBuiltinPrompt(id: string): PromptConfig | undefined {
  return BUILTIN_PROMPTS.find((p) => p.id === id);
}

/** 内置提示词的精简视图（快捷键下拉等仅需 id+name 的场景） */
export const BUILTIN_PROMPT_OPTIONS: Array<{ id: string; name: string }> = BUILTIN_PROMPTS.map(
  (p) => ({ id: p.id, name: p.name }),
);
