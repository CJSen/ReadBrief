export type ProviderType = "openai" | "claude" | "gemini";

export interface ProviderConfig {
  type: ProviderType;
  apiKey: string;
  baseUrl?: string;
  model: string;
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
