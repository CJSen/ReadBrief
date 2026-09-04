export type ProviderType = "openai" | "claude" | "gemini" | "deepseek";

export interface ProviderConfig {
  type: ProviderType;
  apiKey: string;
  baseUrl?: string;
  model: string;
  /** 用户自定义附加参数(JSON 对象文本),由 Rust 侧深合并进请求体,用于关闭思考等厂商私有参数 */
  extraParams?: string | null;
}

export interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface InternalRequest {
  system?: string;
  user: string;
  history?: Message[];
  stream: boolean;
  maxTokens: number;
  model?: string;
  /** 快捷键级附加参数(非空时 Rust 侧深合并覆盖服务级 extraParams) */
  extraParamsOverride?: string | null;
}

export type StreamEvent =
  | { kind: "delta"; text: string }
  | { kind: "done"; text: string }
  | { kind: "error"; error: ProviderError }
  /**
   * 思考型模型阶段标记(流式中返回思考内容,如 deepseek reasoning_content /
   * claude thinking_delta / gemini thought part)。text 为思考增量,前端累计展示。
   */
  | { kind: "thinking"; text: string };

export interface TestConnectionResult {
  ok: boolean;
  latencyMs?: number;
  error?: ProviderError;
}

export type ErrorType = "auth" | "rate_limit" | "network" | "unknown";

export interface ProviderError {
  type: ErrorType;
  status?: number;
  message: string;
}

export interface SerializedRequest {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

export function providerError(type: ErrorType, message: string, status?: number): ProviderError {
  return { type, message, status };
}
