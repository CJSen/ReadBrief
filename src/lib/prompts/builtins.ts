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
    content: "提炼以下内容的核心要点，按主题保留各关键信息、避免重复：{{text}}",
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
 * - summary → 总结助手; translate → 翻译助手; qa → 问答助手; general → 划词ai助手。
 *
 * reasoning 策略:
 * - summary / translate → 强调快速直接处理，尽量减少不必要的推理。
 * - qa → 不限制推理能力，由模型自行决定。
 * - general → 允许必要的简短思考，但避免无意义的冗长推理。
 */
export const DEFAULT_SYSTEM: Record<PromptTag, { zh: string; en: string }> = {
  summary: {
    zh: "你是 ReadBrief 的划词ai总结助手。你的核心价值是快速响应和直接给出结果，仅进行完成总结所必需的最少处理。",
    en: "You are the ReadBrief AI summary assistant. Your priority is fast response and direct results. Use only the minimum processing necessary to complete the summary.",
  },
  translate: {
    zh: "你是 ReadBrief 的划词ai翻译助手。你的核心价值是快速响应和直接给出结果，仅进行完成翻译所必需的最少处理。",
    en: "You are the ReadBrief AI translation assistant. Your priority is fast response and direct results. Use only the minimum processing necessary to complete the translation.",
  },
  qa: {
    zh: "你是 ReadBrief 的划词ai问答助手。",
    en: "You are the ReadBrief AI Q&A assistant.",
  },
  general: {
    zh: "你是 ReadBrief 的划词ai助手。快速响应优先，只进行完成任务所必需的处理；复杂任务可以进行必要的简短思考。",
    en: "You are the ReadBrief AI assistant. Fast response is preferred. Use only the processing necessary to complete the task; brief reasoning is acceptable when necessary for complex tasks.",
  },
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
 *
 * 覆盖度与密度平衡（2026-08-30 三次修订，在「漏覆盖」与「碎片化/注水」间找中点）：
 * 1) 针对「长文只出 5-7 条」：覆盖优先 + 每个新论点单独成条 → 矫枉过正出 15+ 条碎片化。
 * 2) 针对「15+ 条太多」：主题归并 + 围绕主线合并 → 又矫枉成 3-5 条、漏覆盖。
 * 3) 本轮中点：每个独立主题/方面各成一条，同主题内仅合并真正同义碎片，既不逐段罗列、
 *    也不强行压条；保留遍历（先通读再提炼）以对治 lost-in-the-middle。
 * 4) 在中点基础上补「保留关键数据」：合并时不得丢弃具体数字/统计/日期/专有名词，防止
 *    泛化表述导致数据遗漏；验收标准同步加入「关键数据」。
 * 始终用语义判据 + 可自检验收标准，不回退到条数 KPI（模型不擅长数自己的条数）。
 */
export const SUMMARY_FORMAT_RULE_ZH = `输出格式要求(必须严格遵守,格式违规的输出会被系统直接丢弃):
1. 第一行 = 标题,只写这一行标题:
   - 长度必须为 6-15 个字符(约 2-4 个词语组成的短语,不是完整句子)。
   - 后果:标题超过 15 个字符会被系统截断,少于 6 个字符会被判定不合格 —— 请严格落在 6-15 字符区间。
   - 写法:提炼全文核心主题,再压缩成最简短语;不要加「标题:」「总结:」等前缀,不要用 # 号。
   - 合格示例:「新能源汽车电池技术趋势」(11字);不合格示例:「汽车电池技术的发展现状与未来趋势分析」(18字,超过15字)。
2. 第二行起 = 正文:按原文的主题/结构组织要点,编号列表(1. 2. 3. ...)。
   - 覆盖与密度平衡:每个独立主题或方面单独成一条;同一主题内仅把真正同义的零散表述合并,不要把不同侧面硬并成一条。既不要逐段罗列每个细节(避免碎片化),也不要把多个主题压成一条(避免漏覆盖)。
   - 保留关键数据:凡原文出现的具体数字、统计、日期、比例、金额、专有名词、量化结论,必须原样保留在对应要点中,不要泛化成「有所提升」「部分增长」「多项数据」等模糊表述;数据缺失会让要点失去信息量。
   - 验收标准:读者只看这份要点列表,就能把握原文的主要脉络、关键结论与关键数据,不需要回看原文。
3. 正文不要先写"一句话结论"段落,也不要输出「核心要点」「帖子总结」等分区标题,直接给要点列表。
4. 这是一个归纳型任务:先通读全文、把握整体结构与各主题,再按主题提炼要点;相关但不同的内容分项列出,而不是逐段罗列。
5. 禁止输出思考过程、推理步骤或解释。标题和要点列表就是最终结果,请完整输出。`;

export const SUMMARY_FORMAT_RULE_EN = `Output format (must be followed exactly; any violation causes the output to be discarded):
1. Line 1 = the title only:
   - Length must be 6-15 characters (a short phrase of about 2-4 words, NOT a full sentence).
   - Consequence: titles over 15 characters will be truncated by the system; under 6 characters are judged invalid — strictly stay within 6-15.
   - How: extract the core topic, then compress it into the shortest phrase; no prefixes like 'Title:' or 'Summary:', no '#' symbols.
   - OK example: 「新能源汽车电池技术趋势」(11 chars); BAD example: 「汽车电池技术的发展现状与未来趋势分析」(18 chars, over 15).
2. From line 2 = the body: organize points following the source's themes/structure, as a numbered list (1. 2. 3. ...).
   - Balance coverage with density: give each distinct topic or aspect its own entry; within a topic, merge only genuinely synonymous fragments, but do not force different facets into one bullet. Do not list every paragraph's detail (avoid fragmentation), and do not compress several topics into one (avoid missing coverage).
   - Preserve key data: any concrete numbers, statistics, dates, ratios, amounts, proper nouns, or quantified conclusions in the source must be kept verbatim in the relevant bullet. Never vague them into "increased", "some growth", "multiple data points", etc.; dropping data strips the point of its information value.
   - Acceptance test: a reader who sees only this list can grasp the main thread, key conclusions, and key data of the original without going back to it.
3. Do not add a one-sentence conclusion paragraph, and do not output section headings like 'Summary' or 'Key Points'.
4. This is a synthesis task: read the whole text first to grasp its overall structure and topics, then extract points by theme; list related but distinct content as separate items rather than paragraph by paragraph.
5. Do not output reasoning steps or explanations. The title and bullet points ARE the final result — output them in full.`;

/**
 * 翻译类格式规则:首行以「翻译：」开头作为标题,其后直接输出译文正文。
 * 与总结类不同,正文不强制编号列表,而是原样译文,以贴合翻译场景。
 */
export const TRANSLATE_FORMAT_RULE_ZH = `输出格式要求(必须严格遵守):
1. 第一行固定输出「翻译：」作为标题,不要添加任何其他内容。
2. 从第二行起直接输出译文正文,保留原意与语气,不要编号列表、不要额外总结。
3. 这是一个直接的翻译任务。不要进行任何思考、推理、分析、验证或自我审查;直接翻译,不要解释你的翻译选择。
4. 禁止输出思考过程或推理步骤。译文就是最终结果,直接输出。`;

export const TRANSLATE_FORMAT_RULE_EN = `Output format (must be followed exactly):
1. Line 1: output exactly "Translate: " as the title. Nothing else.
2. From line 2 output the translated text directly, preserving meaning and tone; no numbered list, no extra summary.
3. This is a direct translation task. Do NOT think, reason, analyze, verify, or self-review. Translate directly without explaining your choices.
4. Do not output reasoning steps. The translation IS the final result — output it directly.`;

/**
 * 问答类格式规则:首行以「问答：」开头作为标题,其后直接输出答案正文。
 *
 * QA 不主动限制 reasoning:
 * 由模型自行决定需要多少推理,以保证复杂问题的回答质量。
 */
export const QA_FORMAT_RULE_ZH = `输出格式要求(必须严格遵守):
1. 第一行以「问答：」开头作为标题(可跟一句极简说明),标题长度必须为 6-15 个字符;超过 15 个字符会被截断,少于 6 个字符判定不合格。
2. 从第二行起直接输出答案正文,像普通 AI 问答一样自由作答,不做额外格式限制。`;

export const QA_FORMAT_RULE_EN = `Output format (must be followed exactly):
1. Line 1 starts with "QA: " as the title (optionally followed by a very short note); the title must be 6-15 characters; over 15 is invalid.
2. From line 2 output the answer freely, just like a normal AI Q&A, with no extra format restrictions.`;

/** 提示词类别 */
export type PromptTag = "summary" | "translate" | "qa" | "general";

/**
 * 通用类格式规则:
 * 仅强制「首行标题 6-15 字」,正文完全听提示词(润色/提取等)自由发挥。
 * 允许模型进行必要的少量思考,但避免无意义的冗长推理。
 */
export const GENERAL_FORMAT_RULE_ZH = `输出格式要求(必须严格遵守):
1. 第一行 = 标题,只写这一行标题,长度必须为 6-15 个字符;超过 15 个字符会被系统截断,少于 6 个字符判定不合格。不要加「标题:」等前缀,不要用 # 号。
2. 从第二行起直接输出正文,按提示词要求自由发挥(如润色、提取关键词),不要强行编号列表、不要额外总结(除非提示词本身要求)。
3. 快速完成任务即可。仅在任务确实需要时进行简短思考,避免不必要的深度推理、冗长分析、反复验证或多方案探索。
4. 禁止输出思考过程或推理步骤。正文内容就是最终结果,请完整输出。`;

export const GENERAL_FORMAT_RULE_EN = `Output format (must be followed exactly):
1. Line 1 = the title only, 6-15 characters; over 15 is truncated, under 6 is invalid. No prefixes like 'Title:', no '#'.
2. From line 2 output the body freely per the prompt (e.g. polish, extract keywords); no forced numbered list, no extra summary unless the prompt asks.
3. Complete the task efficiently. Use brief reasoning only when genuinely necessary; avoid unnecessary deep reasoning, lengthy analysis, repeated verification, or exploring multiple approaches.
4. Do not output reasoning steps. The content IS the final result — output it in full.`;

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