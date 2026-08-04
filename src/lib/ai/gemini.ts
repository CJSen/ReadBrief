import { SseParser } from "./sse";
import {
  type InternalRequest,
  type ProviderConfig,
  type SerializedRequest,
  type StreamEvent,
} from "./types";
import { GEMINI_DEFAULT_TEMPERATURE } from "./constants";

export function serializeGemini(
  req: InternalRequest,
  config: ProviderConfig,
): SerializedRequest {
  const contents: Array<{ role: "user" | "model"; parts: Array<{ text: string }> }> = [];
  const append = (role: "user" | "model", text: string) => {
    if (!text) {
      return;
    }
    const last = contents[contents.length - 1];
    if (last && last.role === role) {
      last.parts.push({ text });
    } else {
      contents.push({ role, parts: [{ text }] });
    }
  };

  for (const m of req.history ?? []) {
    append(m.role === "assistant" ? "model" : "user", m.content);
  }
  if (req.system) {
    // Gemini 无独立 system 字段,并入首条 user 内容
    if (contents.length > 0 && contents[0].role === "user") {
      contents[0].parts.unshift({ text: req.system });
    } else {
      contents.unshift({ role: "user", parts: [{ text: req.system }] });
    }
  }
  append("user", req.user);

  const base = (config.baseUrl ?? "https://generativelanguage.googleapis.com").replace(
    /\/$/,
    "",
  );
  return {
    url: `${base}/v1beta/models/${req.model ?? config.model}:streamGenerateContent?alt=sse&key=${config.apiKey}`,
    headers: {
      "Content-Type": "application/json",
    },
    body: {
      contents,
      generationConfig: {
        maxOutputTokens: req.maxTokens,
        temperature: GEMINI_DEFAULT_TEMPERATURE,
      },
    },
  };
}

export function parseGeminiStream(emit: (event: StreamEvent) => void): {
  feed: (chunk: string) => void;
  end: () => void;
} {
  let fullText = "";
  const parser = new SseParser(({ data }) => {
    try {
      const json = JSON.parse(data) as {
        candidates?: Array<{
          content?: { parts?: Array<{ text?: string }> };
          finishReason?: string;
        }>;
        error?: { message?: string };
      };
      if (json.error) {
        emit({ kind: "error", error: { type: "unknown", message: json.error.message ?? "" } });
        return;
      }
      const parts = json.candidates?.[0]?.content?.parts ?? [];
      for (const part of parts) {
        if (part.text) {
          fullText += part.text;
          emit({ kind: "delta", text: part.text });
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
