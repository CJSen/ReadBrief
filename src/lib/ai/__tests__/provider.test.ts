import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { serializeOpenAI, parseOpenAIStream } from "../openai";
import { serializeClaude, parseClaudeStream } from "../claude";
import { serializeGemini, parseGeminiStream } from "../gemini";
import { classifyError, classifyStatus } from "../errors";
import { SseParser } from "../sse";
import { streamChat, testConnection } from "../provider";
import type { InternalRequest } from "../types";

// Mock Tauri IPC:streamChat/testConnection 已改为 invoke ai_stream/ai_test + 事件监听
const invokeMock = vi.hoisted(() => vi.fn());
const listenMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: listenMock,
  type: {},
}));

/** 捕获 listen 注册的处理器,供测试手动触发事件 */
function captureHandlers(): Record<string, (e: unknown) => void> {
  const handlers: Record<string, (e: unknown) => void> = {};
  listenMock.mockImplementation((name: string, cb: (e: unknown) => void) => {
    handlers[name] = cb;
    return Promise.resolve(() => {});
  });
  return handlers;
}

const baseReq: InternalRequest = {
  system: "你是总结助手",
  user: "请总结这段文字",
  history: [{ role: "assistant", content: "好的" }],
  stream: true,
  maxTokens: 512,
};

const cfg = {
  openai: { type: "openai" as const, apiKey: "sk-test", model: "gpt-4o-mini" },
  claude: { type: "claude" as const, apiKey: "sk-ant-test", model: "claude-sonnet" },
  gemini: { type: "gemini" as const, apiKey: "AIza-test", model: "gemini-2.0-flash" },
};

describe("序列化 OpenAI", () => {
  it("生成 messages 数组、stream、Bearer 鉴权", () => {
    const s = serializeOpenAI(baseReq, cfg.openai);
    expect(s.url).toContain("/chat/completions");
    expect(s.headers.Authorization).toBe("Bearer sk-test");
    const body = s.body as { messages: unknown[]; stream: boolean; max_tokens: number };
    expect(body.messages).toHaveLength(3);
    expect(body.messages[0]).toEqual({ role: "system", content: "你是总结助手" });
    expect(body.stream).toBe(true);
    expect(body.max_tokens).toBe(512);
  });
});

describe("序列化 Claude", () => {
  it("生成 system、max_tokens、x-api-key、anthropic-version", () => {
    const s = serializeClaude(baseReq, cfg.claude);
    expect(s.url).toContain("/v1/messages");
    expect(s.headers["x-api-key"]).toBe("sk-ant-test");
    expect(s.headers["anthropic-version"]).toBe("2023-06-01");
    const body = s.body as {
      system: string;
      max_tokens: number;
      messages: unknown[];
      stream: boolean;
    };
    expect(body.system).toBe("你是总结助手");
    expect(body.max_tokens).toBe(512);
    expect(body.stream).toBe(true);
    expect(body.messages).toHaveLength(2);
  });
});

describe("序列化 Gemini", () => {
  it("生成 contents/parts 结构,文本在 parts[].text", () => {
    const s = serializeGemini(baseReq, cfg.gemini);
    expect(s.url).toContain("streamGenerateContent");
    expect(s.url).toContain("key=AIza-test");
    const body = s.body as {
      contents: Array<{ parts: Array<{ text: string }> }>;
    };
    expect(body.contents.length).toBeGreaterThanOrEqual(2);
    expect(body.contents[0].parts[0].text).toBe("你是总结助手");
    expect(body.contents.at(-1)?.parts.at(-1)?.text).toBe("请总结这段文字");
  });
});

describe("SSE 解析器", () => {
  it("解析多个 data 事件", () => {
    const events: string[] = [];
    const p = new SseParser((e) => events.push(e.data));
    p.parse("data: hello\n\ndata: world\n\n");
    expect(events).toEqual(["hello", "world"]);
  });

  it("处理跨 chunk 拆分", () => {
    const events: string[] = [];
    const p = new SseParser((e) => events.push(e.data));
    p.parse("data: hel");
    p.parse("lo\n\n");
    expect(events).toEqual(["hello"]);
  });
});

describe("OpenAI 流式解析", () => {
  it("逐字 delta 输出并 end 时 done", () => {
    const deltas: string[] = [];
    const { feed, end } = parseOpenAIStream((e) => {
      if (e.kind === "delta") {
        deltas.push(e.text);
      }
    });
    feed('data: {"choices":[{"delta":{"content":"你"}}]}\n\n');
    feed('data: {"choices":[{"delta":{"content":"好"}}]}\n\n');
    feed('data: [DONE]\n\n');
    expect(deltas).toEqual(["你", "好"]);
    end();
  });
});

describe("Claude 流式解析", () => {
  it("解析 content_block_delta", () => {
    const deltas: string[] = [];
    const { feed, end } = parseClaudeStream((e) => {
      if (e.kind === "delta") {
        deltas.push(e.text);
      }
    });
    feed(
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"总"}}\n\n',
    );
    feed(
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"结"}}\n\n',
    );
    expect(deltas).toEqual(["总", "结"]);
    end();
  });
});

describe("Gemini 流式解析", () => {
  it("解析 candidates[].content.parts[].text", () => {
    const deltas: string[] = [];
    const { feed, end } = parseGeminiStream((e) => {
      if (e.kind === "delta") {
        deltas.push(e.text);
      }
    });
    feed(
      'data: {"candidates":[{"content":{"parts":[{"text":"结"},{"text":"束"}]}}]}\n\n',
    );
    expect(deltas).toEqual(["结", "束"]);
    end();
  });
});

describe("错误归类", () => {
  it("401 → auth", () => {
    expect(classifyStatus(401).type).toBe("auth");
    expect(classifyError({ status: 401 })).toMatchObject({ type: "auth" });
  });
  it("429 → rate_limit", () => {
    expect(classifyStatus(429).type).toBe("rate_limit");
    expect(classifyError({ response: { status: 429 } })).toMatchObject({
      type: "rate_limit",
    });
  });
  it("网络异常 → network", () => {
    expect(classifyError(new TypeError("Failed to fetch")).type).toBe("network");
  });
  it("500 → network(服务端异常)", () => {
    expect(classifyStatus(500).type).toBe("network");
  });
});

describe("streamChat", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    listenMock.mockReset();
  });
  afterEach(() => invokeMock.mockClear());

  it("invoke ai_stream 并把 delta/done 事件转发", async () => {
    invokeMock.mockResolvedValue(null);
    const handlers = captureHandlers();
    const events: string[] = [];
    const p = streamChat(baseReq, cfg.openai, (e) => {
      if (e.kind === "delta") events.push(e.text);
      if (e.kind === "done") events.push("DONE");
    });
    // 等待 listen 注册 + invoke 被调用(requestId 生成)
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalled());
    const requestId = invokeMock.mock.calls[0][1].requestId;
    handlers["ai-delta"]({ payload: { requestId, text: "hi" } });
    handlers["ai-done"]({ payload: { requestId } });
    await p;
    expect(events).toEqual(["hi", "DONE"]);
    expect(invokeMock).toHaveBeenCalledWith("ai_stream", expect.objectContaining({ requestId: expect.any(String) }));
  });

  it("仅转发匹配 requestId 的事件", async () => {
    invokeMock.mockResolvedValue(null);
    const handlers = captureHandlers();
    const events: string[] = [];
    const p = streamChat(baseReq, cfg.openai, (e) => {
      if (e.kind === "delta") events.push(e.text);
    });
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalled());
    // 不匹配的 requestId:不应转发
    handlers["ai-delta"]({ payload: { requestId: "other", text: "x" } });
    expect(events).toEqual([]);
    await p;
  });

  it("ai-error 事件转发为 error 事件", async () => {
    invokeMock.mockResolvedValue(null);
    const handlers = captureHandlers();
    const kinds: string[] = [];
    const p = streamChat(baseReq, cfg.openai, (e) => kinds.push(e.kind));
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalled());
    const requestId = invokeMock.mock.calls[0][1].requestId;
    handlers["ai-error"]({ payload: { requestId, error: { type: "auth", message: "bad" } } });
    expect(kinds).toEqual(["error"]);
    await p;
  });

  it("ai-thinking 事件转发为 thinking 事件并携带思考增量(思考型模型)", async () => {
    invokeMock.mockResolvedValue(null);
    const handlers = captureHandlers();
    const events: Array<{ kind: string; text?: string }> = [];
    const p = streamChat(baseReq, cfg.openai, (e) => events.push(e));
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalled());
    const requestId = invokeMock.mock.calls[0][1].requestId;
    handlers["ai-thinking"]({ payload: { requestId, text: "先分析" } });
    handlers["ai-thinking"]({ payload: { requestId, text: "再推理" } });
    expect(events).toEqual([
      { kind: "thinking", text: "先分析" },
      { kind: "thinking", text: "再推理" },
    ]);
    await p;
  });

  it("中止后忽略后续事件（不落库）", async () => {
    invokeMock.mockResolvedValue(null);
    const controller = new AbortController();
    const handlers = captureHandlers();
    const kinds: string[] = [];
    const p = streamChat(baseReq, cfg.openai, (e) => kinds.push(e.kind), {
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalled());
    const requestId = invokeMock.mock.calls[0][1].requestId;
    controller.abort();
    handlers["ai-delta"]({ payload: { requestId, text: "x" } });
    handlers["ai-done"]({ payload: { requestId } });
    await p;
    expect(kinds).toEqual([]);
  });

  it("invoke 抛错且未中止时转发 error 事件", async () => {
    invokeMock.mockImplementation(() =>
      Promise.reject(Object.assign(new Error("请求超时"), { kind: "Network" })),
    );
    const handlers = captureHandlers();
    const kinds: string[] = [];
    const p = streamChat(baseReq, cfg.openai, (e) => kinds.push(e.kind));
    await p;
    expect(kinds).toEqual(["error"]);
    expect(handlers["ai-delta"]).toBeDefined();
  });
});

describe("testConnection", () => {
  // 注:不能在此块用 beforeEach 重置 mock —— vitest 4 会把 mock 内 rejected
  // promise 误报为 unhandled rejection(仅 reject 场景);改为测试内手动 mockClear

  it("成功回显耗时", async () => {
    invokeMock.mockClear();
    invokeMock.mockResolvedValue({ ok: true, latencyMs: 123 });
    const r = await testConnection(cfg.openai);
    expect(r.ok).toBe(true);
    expect(r.latencyMs).toBe(123);
    expect(invokeMock).toHaveBeenCalledWith("ai_test", expect.anything());
  });

  it("失败返回错误类型", async () => {
    invokeMock.mockClear();
    invokeMock.mockResolvedValue({
      ok: false,
      latencyMs: 5,
      error: { type: "rate_limit", message: "限流" },
    });
    const r = await testConnection(cfg.openai);
    expect(r.ok).toBe(false);
    expect(r.error?.type).toBe("rate_limit");
  });

  it("invoke 异常归类为错误", async () => {
    invokeMock.mockClear();
    // 返回 rejected promise 而非 throw,规避 vitest 4 对 mock throw 的 unhandled 误报
    invokeMock.mockImplementation(() =>
      Promise.reject(Object.assign(new Error("连接失败"), { kind: "Network" })),
    );
    const r = await testConnection(cfg.openai);
    expect(r.ok).toBe(false);
    expect(r.error?.type).toBe("network");
  });
});
