import { SseParser } from "./sse";
import {
  type InternalRequest,
  type ProviderConfig,
  type SerializedRequest,
  type StreamEvent,
} from "./types";

export function serializeOpenAI(
  req: InternalRequest,
  config: ProviderConfig,
): SerializedRequest {
  const messages: Array<{ role: string; content: string }> = [];
  if (req.system) {
    messages.push({ role: "system", content: req.system });
  }
  for (const m of req.history ?? []) {
    messages.push({ role: m.role, content: m.content });
  }
  messages.push({ role: "user", content: req.user });

  const base = (config.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
  return {
    url: `${base}/chat/completions`,
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: {
      model: req.model ?? config.model,
      messages,
      stream: req.stream,
      max_tokens: req.maxTokens,
    },
  };
}

export function parseOpenAIStream(emit: (event: StreamEvent) => void): {
  feed: (chunk: string) => void;
  end: () => void;
} {
  let fullText = "";
  const parser = new SseParser(({ data }) => {
    if (data === "[DONE]") {
      return;
    }
    try {
      const json = JSON.parse(data) as {
        choices?: Array<{
          delta?: { content?: string };
          message?: { content?: string };
          finish_reason?: string | null;
        }>;
        error?: { message?: string };
      };
      if (json.error) {
        emit({ kind: "error", error: { type: "unknown", message: json.error.message ?? "" } });
        return;
      }
      const choice = json.choices?.[0];
      const delta = choice?.delta?.content ?? choice?.message?.content ?? "";
      if (delta) {
        fullText += delta;
        emit({ kind: "delta", text: delta });
      }
    } catch {
      // 忽略无法解析的分片
    }
  });

  return {
    feed: (chunk) => parser.parse(chunk),
    end: () => {
      parser.end();
      emit({ kind: "done", text: fullText });
    },
  };
}
