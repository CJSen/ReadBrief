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
  | { kind: "error"; error: ProviderError };

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
