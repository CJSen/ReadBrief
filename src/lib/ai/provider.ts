import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  type InternalRequest,
  type ProviderConfig,
  type StreamEvent,
  type TestConnectionResult,
  type ProviderError,
} from "./types";

/**
 * AI 调用已下沉 Rust(P0-2):
 * - WebView 不再直连任何 AI 域名,密钥永不进入渲染进程
 * - 序列化 / 流式解析 / 超时 / 长度截断 / protocol 白名单都在 Rust 侧(ai.rs)
 * - 本模块仅做:invoke `ai_stream` + 监听 `ai-delta` / `ai-error` / `ai-done` 事件转发
 */

/** 流式总结:invoke Rust 端 ai_stream,事件经 requestId 关联转发给 onEvent */
export async function streamChat(
  req: InternalRequest,
  config: ProviderConfig,
  onEvent: (event: StreamEvent) => void,
  opts?: { signal?: AbortSignal },
): Promise<void> {
  const requestId = crypto.randomUUID();
  const serviceConfig = {
    protocol: config.type,
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    model: config.model,
    extraParams: config.extraParams ?? null,
  };
  const aiRequest = {
    system: req.system,
    user: req.user,
    stream: true,
    maxTokens: req.maxTokens,
    model: req.model,
    extraParamsOverride: req.extraParamsOverride ?? null,
  };

  // 主动中止:中止后忽略一切后续事件(Rust 侧请求自然结束,但其事件不再转发 → 不落库)
  const isAborted = () => opts?.signal?.aborted ?? false;
  const abortHandler = () => {
    /* 标记已由 signal.aborted 表达,无需额外动作 */
  };
  opts?.signal?.addEventListener("abort", abortHandler);

  // 事件转发:仅处理当前 requestId 且未中止的事件
  const deltaHandler = (event: { payload: { requestId: string; text?: string } }) => {
    if (isAborted() || event.payload.requestId !== requestId) return;
    if (event.payload.text) {
      onEvent({ kind: "delta", text: event.payload.text });
    }
  };
  const errorHandler = (event: { payload: { requestId: string; error?: ProviderError } }) => {
    if (isAborted() || event.payload.requestId !== requestId) return;
    if (event.payload.error) {
      onEvent({ kind: "error", error: event.payload.error });
    }
  };
  const doneHandler = (event: { payload: { requestId: string } }) => {
    if (isAborted() || event.payload.requestId !== requestId) return;
    // done 文本由 outputRef 累计,这里无需携带
    onEvent({ kind: "done", text: "" });
  };
  // 思考型模型阶段标记+思考增量(流式中返回 reasoning_content → 前端显示「思考中」并累计)
  const thinkingHandler = (event: { payload: { requestId: string; text?: string } }) => {
    if (isAborted() || event.payload.requestId !== requestId) return;
    onEvent({ kind: "thinking", text: event.payload.text ?? "" });
  };

  const unlistens: UnlistenFn[] = [];
  try {
    unlistens.push(await listen("ai-delta", deltaHandler));
    unlistens.push(await listen("ai-error", errorHandler));
    unlistens.push(await listen("ai-done", doneHandler));
    unlistens.push(await listen("ai-thinking", thinkingHandler));
    // Rust 侧失败统一 emit ai-error 事件(错误已随事件回传),invoke 正常 resolve
    await invoke("ai_stream", {
      config: serviceConfig,
      request: aiRequest,
      requestId,
    });
  } catch (err) {
    // invoke 层面的异常(如命令不存在 / IPC 中断):非中止才报错
    if (isAborted()) return;
    onEvent({ kind: "error", error: classifyIpcError(err) });
  } finally {
    opts?.signal?.removeEventListener("abort", abortHandler);
    unlistens.forEach((fn) => fn());
  }
}

/** 连接测试:invoke Rust 端 ai_test(统一超时/鉴权校验) */
export async function testConnection(config: ProviderConfig): Promise<TestConnectionResult> {
  const serviceConfig = {
    protocol: config.type,
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    model: config.model,
    extraParams: config.extraParams ?? null,
  };
  try {
    const r = await invoke<TestConnectionResult>("ai_test", { config: serviceConfig });
    return r;
  } catch (err) {
    return { ok: false, error: classifyIpcError(err) };
  }
}

/** 拉取模型列表(设置页模型下拉):OpenAI/Gemini 走接口,Claude 回退内置;失败返回空数组 */
export async function listModels(config: ProviderConfig): Promise<string[]> {
  const serviceConfig = {
    protocol: config.type,
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    model: config.model,
  };
  try {
    return await invoke<string[]>("ai_list_models", { config: serviceConfig });
  } catch {
    return [];
  }
}

/** IPC 错误归类:与 Rust 端 AppError 结构对齐 */
function classifyIpcError(err: unknown): ProviderError {
  const e = err as { kind?: string; message?: string } | undefined;
  const kind = e?.kind;
  const message = e?.message ?? String(err);
  switch (kind) {
    case "Auth":
      return { type: "auth", message };
    case "RateLimit":
      return { type: "rate_limit", message };
    case "Network":
      return { type: "network", message };
    case "Upstream":
      return { type: "network", message };
    default:
      return { type: "unknown", message };
  }
}

export type { ProviderError };
