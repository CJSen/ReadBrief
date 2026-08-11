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
    content: "用 3 条要点概括以下内容，并在开头给出一句话结论：{{text}}",
    model: "",
    shortcut: null,
    outputFormat: "md",
    isBuiltin: true,
  },
  {
    id: "builtin-translate",
    name: "翻译提示词",
    content: "将以下内容翻译为中文，保留原意与语气：{{text}}",
    model: "",
    shortcut: null,
    outputFormat: "md",
    isBuiltin: true,
  },
  {
    id: "builtin-qa",
    name: "问答提示词",
    content: "基于以下内容回答用户的问题，直接给出结论：{{text}}",
    model: "",
    shortcut: null,
    outputFormat: "md",
    isBuiltin: true,
  },
];

/** 内置提示词图标配色（PromptManager 卡片用） */
export const BUILTIN_ICONS: Record<string, { icon: string; bg: string; fg: string }> = {
  "builtin-summarize": { icon: "list", bg: "var(--rb-brand-50)", fg: "var(--rb-brand-600)" },
  "builtin-translate": { icon: "translate", bg: "var(--rb-success-bg)", fg: "var(--rb-success)" },
  "builtin-qa": { icon: "question", bg: "var(--rb-marker-50)", fg: "var(--rb-marker-600)" },
};

/** 内置兜底系统提示词（未配置自定义提示词 / 未命中任何内置时） */
export const DEFAULT_SYSTEM_ZH = "你是 ReadBrief 的划词ai总结助手。";
export const DEFAULT_SYSTEM_EN = "You are the vocabulary AI summary assistant for ReadBrief.";

/**
 * 强制格式规则：无论默认提示词还是用户自定义提示词，都追加到 system 末尾。
 * 目的：让模型在同一次回复里以「分隔符式纯文本」产出 [标题行 + 编号要点列表]，
 * 从而无需二次调用即可解析出独立短标题，且不重发原文（省 token / 降延迟）。
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
   - 长度必须为 6-15 个汉字(约 2-4 个词语组成的短语,不是完整句子)。
   - 后果:标题超过 15 个字会被系统截断,少于 6 个字会被判定不合格 —— 请严格落在 6-15 字区间。
   - 写法:先提炼全文核心主题,再压缩成最简短语;不要加「标题:」「总结:」等前缀,不要用 # 号。
   - 合格示例:「新能源汽车电池技术趋势」(11字);不合格示例:「汽车电池技术的发展现状与未来趋势分析」(18字,超过15字)。
2. 第二行起 = 正文:直接以编号列表(1. 2. 3. ...)逐条列出核心要点,每条精炼准确、使用简体中文;要点数量不限。
3. 正文不要先写"一句话结论"段落,也不要输出「核心要点」「帖子总结」等分区标题,直接给要点列表。
4. 不要输出任何思考/推理过程,直接给出总结。`;

export const SUMMARY_FORMAT_RULE_EN = `Output format (must be followed exactly; any violation causes the output to be discarded):
1. Line 1 = the title only:
   - Length must be 6-15 Chinese characters (a short phrase of about 2-4 words, NOT a full sentence).
   - Consequence: titles over 15 characters will be truncated by the system; under 6 characters are judged invalid — strictly stay within 6-15.
   - How: first extract the core topic, then compress it into the shortest phrase; no prefixes like 'Title:', no '#' symbols.
   - OK example: 「新能源汽车电池技术趋势」(11 chars); BAD example: 「汽车电池技术的发展现状与未来趋势分析」(18 chars, over 15).
2. From line 2 = the body: list key points directly as a numbered list (1. 2. 3. ...), each concise and in Simplified Chinese; any number of points is fine.
3. Do not add a one-sentence conclusion paragraph, and do not output section headings like 'Summary' or 'Key Points'.
4. Do not output any reasoning; give the summary directly.`;

/** 按 id 查找内置提示词（id 缺失时返回 undefined） */
export function findBuiltinPrompt(id: string): PromptConfig | undefined {
  return BUILTIN_PROMPTS.find((p) => p.id === id);
}

/** 内置提示词的精简视图（快捷键下拉等仅需 id+name 的场景） */
export const BUILTIN_PROMPT_OPTIONS: Array<{ id: string; name: string }> = BUILTIN_PROMPTS.map(
  (p) => ({ id: p.id, name: p.name }),
);
