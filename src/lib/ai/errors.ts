import { providerError, type ProviderError } from "./types";

export function classifyError(err: unknown): ProviderError {
  if (err instanceof TypeError) {
    return providerError("network", err.message);
  }
  if (err instanceof Error && /fetch/i.test(err.message)) {
    return providerError("network", err.message);
  }
  const status =
    typeof (err as { status?: unknown })?.status === "number"
      ? (err as { status: number }).status
      : undefined;
  if (status === undefined && (err as { response?: unknown })?.response) {
    const res = (err as { response: { status?: unknown } }).response;
    if (typeof res.status === "number") {
      return classifyStatus(res.status, String(err));
    }
  }
  if (typeof status === "number") {
    return classifyStatus(status, String(err));
  }
  return providerError("unknown", String(err));
}

export function classifyStatus(status: number, body?: string): ProviderError {
  if (status === 401 || status === 403) {
    return providerError("auth", `鉴权失败(HTTP ${status})`, status);
  }
  if (status === 429) {
    return providerError("rate_limit", `请求受限或额度不足(HTTP ${status})`, status);
  }
  if (status >= 500 || status === 408) {
    return providerError("network", `服务端异常(HTTP ${status})`, status);
  }
  // 未归类状态码:UI 只展示规范化文案+状态码;原始 body(可能含账号/org/request id 等元数据)
  // 仅在开发模式保留,且截断防止泄露与刷屏
  const detail = import.meta.env.DEV && body ? `: ${truncate(body, 200)}` : "";
  return providerError("unknown", `HTTP ${status}${detail}`, status);
}

/** 截断字符串,超长部分省略(防止上游错误体把 UI 撑爆/泄露完整元数据) */
function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}