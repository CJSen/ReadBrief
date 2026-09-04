/** AI 适配层配置常量 */

/** 正文输出上限:非思考型/配额分离协议的默认值(避免过长输出占据浮窗空间) */
export const SUMMARY_MAX_TOKENS = 1024;

/** 思考型模型总输出上限:reasoner 类的 max_tokens 是「思考+正文」总和,
 *  512 会被思考耗尽导致正文为空(deepseek-v4 / gemini-2.5 等)。
 *  V4 思考默认开启且与正文共享配额(官方推荐≥2048 仅下限),10240 给足余量
 *  ——思考+正文总和通常 2k~4k,10240 兼顾安全上限与不滥用配额。 */
export const REASONING_MAX_TOKENS = 10240;

/** 连接测试用最小 tokens（仅验证连通性） */
export const CONNECTION_TEST_MAX_TOKENS = 8;

/** Gemini 协议 temperature 默认值 */
export const GEMINI_DEFAULT_TEMPERATURE = 0.7;

/**
 * 按协议取默认 max_tokens(请求前决策,不依赖模型名——模型迭代快,关键词枚举追不上):
 * - claude:4.7+/5 系思考与输出共享 max_tokens 预算,且默认开启 adaptive 思考;
 *   若需精确关闭/调整思考,用服务配置的「参数覆盖」下发 thinking 参数。
 * - gemini:2.5+ 思考默认开启且占 maxOutputTokens 配额 → 必须放大,否则思考耗尽正文为空;
 * - openai 兼容(deepseek-v4 等):reasoning 计入 max_tokens → 与 gemini 同需放大。
 * 思考型与否的最终判定在运行时(流式中出现 reasoning_content/thinking_delta/thought part),
 * 此处仅为请求前的保守配额。
 */
export function maxTokensForProtocol(protocol: string): number {
  switch (protocol) {
    case "claude":
      return SUMMARY_MAX_TOKENS;
    case "gemini":
      return REASONING_MAX_TOKENS;
    default:
      // openai 兼容(deepseek-v4 等):reasoning 计入 max_tokens,与 gemini 同需放大
      return REASONING_MAX_TOKENS;
  }
}
