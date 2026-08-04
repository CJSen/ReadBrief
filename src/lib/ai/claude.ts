import { SseParser } from "./sse";
import {
  type InternalRequest,
  type ProviderConfig,
  type SerializedRequest,
  type StreamEvent,
} from "./types";

export function serializeClaude(
  req: InternalRequest,
  config: ProviderConfig,
): SerializedRequest {
  const messages: Array<{ role: string; content: string }> = [];
  for (const m of req.history ?? []) {
    messages.push({ role: m.role === "system" ? "user" : m.role, content: m.content });
  }
  messages.push({ role: "user", content: req.user });

  const base = (config.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "");
  return {
    url: `${base}/v1/messages`,
    headers: {
      "x-api-key": config.apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: {
      model: req.model ?? config.model,
      max_tokens: req.maxTokens,
      system: req.system,
      messages,
      stream: req.stream,
    },
  };
}

export function parseClaudeStream(emit: (event: StreamEvent) => void): {
  feed: (chunk: string) => void;
  end: () => void;
} {
  let fullText = "";
  const parser = new SseParser(({ data }) => {
    try {
      const json = JSON.parse(data) as {
        type?: string;
        delta?: { type?: string; text?: string };
        error?: { message?: string; type?: string };
      };
      if (json.error) {
        emit({ kind: "error", error: { type: "unknown", message: json.error.message ?? "" } });
        return;
      }
      if (json.type === "content_block_delta" && json.delta?.type === "text_delta") {
        const text = json.delta.text ?? "";
        if (text) {
          fullText += text;
          emit({ kind: "delta", text });
        }
      }
    } catch {
      // 忽略
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
