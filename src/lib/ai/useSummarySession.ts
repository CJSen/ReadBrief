import { useCallback, useRef, useState, type RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { streamChat } from "../ai/provider";
import type { ProviderError, ProviderType, StreamEvent } from "../ai/types";
import { SUMMARY_MAX_TOKENS } from "../ai/constants";
import type { AppConfig } from "../config/types";
import { getDefaultService } from "../config/types";
import { getLanguage } from "../i18n";
import {
  DEFAULT_SYSTEM_ZH,
  DEFAULT_SYSTEM_EN,
  SUMMARY_FORMAT_RULE_ZH,
  SUMMARY_FORMAT_RULE_EN,
  findBuiltinPrompt,
  BUILTIN_PROMPTS,
} from "../prompts/builtins";

export type FloatState = "idle" | "streaming" | "done" | "error";

/** 待总结文本分隔符(防提示注入:把用户文本与指令明确隔离) */
const TEXT_DELIM_OPEN = "\n<text_to_summarize>\n";
const TEXT_DELIM_CLOSE = "\n</text_to_summarize>\n";

/** 包裹待总结文本,使模型将其视为数据而非指令 */
function wrapText(text: string): string {
  return `${TEXT_DELIM_OPEN}${text}${TEXT_DELIM_CLOSE}`;
}

/**
 * 从分隔符式输出解析标题与正文。
 * - 首行为标题,全量保留不截断(与浮窗显示一致;中英文混排标题如产品名不再被截断)。
 * - 其余为正文(要点列表);模型未换行时整段兜底为正文。
 */
function splitTitleBody(summary: string): { title: string; body: string } {
  const nl = summary.indexOf("\n");
  const rawTitle = (nl >= 0 ? summary.slice(0, nl) : summary).trim();
  const title = rawTitle || "总结";
  let body = nl >= 0 ? summary.slice(nl + 1).trim() : "";
  if (!body) body = summary.trim();
  return { title, body };
}

/** 解析总结输出语言:system = 跟随界面语言 */
function resolveSummaryLang(cfg: AppConfig | null): "zh" | "en" {
  const lang = cfg?.summaryLanguage ?? "system";
  if (lang === "zh" || lang === "en") return lang;
  return getLanguage() === "en" ? "en" : "zh";
}

export interface SummarySession {
  output: string;
  state: FloatState;
  error: ProviderError | null;
  historyId: number | null;
  /** 总结:opts.replace=true 表示重新生成(成功后 update 原历史记录,而非新建) */
  run: (text: string, opts?: { replace?: boolean }) => Promise<void>;
  stop: () => void;
  reset: () => void;
  /** 供 UI 即时同步 output 的 ref */
  outputRef: { current: string };
  /** 切换当前生效提示词(内置∪用户并集循环) */
  switchPrompt: (currentInput: string) => void;
  /** 由捕获事件设置本次会话使用的提示词 id */
  setPromptId: (id: string | null) => void;
  /** 由捕获事件设置本次会话使用的模型(快捷键绑定;为空则用默认服务模型) */
  setModelId: (model: string | null) => void;
}

/**
 * 总结会话 hook(P2-7):收敛 AppFloat 中的流式总结编排逻辑
 * (streamChat 事件处理 / abort 控制 / 历史落库门控)。
 *
 * 关键行为(与 P0-3 修复一致):
 * - 仅成功结束的总结才写历史;失败/中止路径绝不落库
 * - 首触发时配置未就绪会自动拉取 config_get 兜底
 */
export function useSummarySession(
  cfgRef: RefObject<AppConfig | null>,
): SummarySession {
  const [output, setOutput] = useState("");
  const [state, setState] = useState<FloatState>("idle");
  const [error, setError] = useState<ProviderError | null>(null);
  const [historyId, setHistoryId] = useState<number | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const outputRef = useRef("");
  const promptIdRef = useRef<string | null>(null);
  const modelRef = useRef<string | null>(null);
  /** historyId 的可变镜像:供 run/saveHistory 在流式期间读取原记录 id(重新生成替换用),避免闭包过期 */
  const historyIdRef = useRef<number | null>(null);

  /** 解析当前提示词:capture 携带 promptId 优先(内置∪用户并集),否则默认第一个用户提示词 */
  const resolvePrompt = useCallback((text: string) => {
    const prompts = cfgRef.current?.prompts ?? [];
    const prompt = promptIdRef.current
      ? (findBuiltinPrompt(promptIdRef.current) ?? prompts.find((p) => p.id === promptIdRef.current))
      : prompts[0];
    const lang = resolveSummaryLang(cfgRef.current);
    // 强制格式规则始终追加到 system 末尾,保证自定义提示词下也能解析出独立标题 + 要点列表
    const system = `${lang === "en" ? DEFAULT_SYSTEM_EN : DEFAULT_SYSTEM_ZH}\n\n${
      lang === "en" ? SUMMARY_FORMAT_RULE_EN : SUMMARY_FORMAT_RULE_ZH
    }`;
    if (prompt?.content) {
      // 提示词含 {{text}} 占位符则替换为包裹文本;不含则把原文以分隔符附在其后,避免丢失且防注入
      const user =
        prompt.content.indexOf("{{text}}") >= 0
          ? prompt.content.replace(/\{\{text\}\}/g, wrapText(text))
          : `${prompt.content}\n\n${wrapText(text)}`;
      return { system, user, name: prompt.name };
    }
    return { system, user: wrapText(text), name: lang === "en" ? "Summary" : "要点总结" };
  }, [cfgRef]);

  /**
   * 落库:分隔符式输出首行存 ai_title,正文(要点列表)存 summary。
   * replaceId 非空 = 重新生成场景 → update 原记录(保持原文/标签/收藏),否则 create 新记录。
   */
  const saveHistory = useCallback(
    async (source: string, summary: string, replaceId: number | null) => {
      try {
        const { title, body } = splitTitleBody(summary);
        const model = cfgRef.current ? getDefaultService(cfgRef.current).model : "";
        const promptName = resolvePrompt(source).name;
        if (replaceId != null) {
          await invoke("history_update_summary", {
            id: replaceId,
            summary: body,
            aiTitle: title,
            model,
            promptName,
          });
          historyIdRef.current = replaceId;
          setHistoryId(replaceId);
        } else {
          const id = await invoke<number>("history_create", {
            sourceText: source,
            summary: body,
            aiTitle: title,
            model,
            promptName,
            tags: [],
          });
          historyIdRef.current = id;
          setHistoryId(id);
        }
        void invoke("tray_refresh");
      } catch {
        // 忽略入库失败
      }
    },
    [cfgRef, resolvePrompt],
  );

  const run = useCallback(
    async (text: string, opts?: { replace?: boolean }) => {
      const replace = opts?.replace === true;
      // 重新生成(replace):保留原 historyId,流式成功后 update 同一记录(原文/标签/收藏不变);
      // 新总结:重置 historyId,成功后 create 新记录
      const originalId = historyIdRef.current;
      if (!replace) {
        historyIdRef.current = null;
        setHistoryId(null);
      }
      // 用 ref 读取配置:快捷键触发瞬间 config_get 可能未完成,state 尚未就绪
      // 兜底:cfgRef 尚未就绪时先拉取一次配置,避免首触发静默无响应
      if (!cfgRef.current) {
        try {
          const c = await invoke<AppConfig>("config_get");
          cfgRef.current = c;
        } catch {
          // 拉取失败按无配置处理
        }
      }
      const services = cfgRef.current?.services?.length
        ? cfgRef.current.services
        : cfgRef.current
          ? [cfgRef.current.api]
          : [];
      // 快捷键绑定模型时:优先在服务列表中按模型匹配,保证该模型所在服务的协议/密钥正确;
      // 未命中或未绑定时回退默认服务
      const service =
        (modelRef.current
          ? services.find((s) => s.model === modelRef.current)
          : undefined) ??
        (cfgRef.current ? getDefaultService(cfgRef.current) : null);
      if (!service?.apiKey || !text.trim()) return;
      abortRef.current?.abort();
      abortRef.current = new AbortController();
      outputRef.current = "";
      setOutput("");
      setError(null);
      setState("streaming");

      const prompt = resolvePrompt(text);
      const config = {
        type: service.protocol as ProviderType,
        apiKey: service.apiKey,
        baseUrl: service.baseUrl,
        // 快捷键绑定模型优先;未绑定用服务默认模型
        model: modelRef.current || service.model,
      };

      try {
        // 本次会话是否已失败:流中 error 事件后即使再收到 done 也绝不落库
        let streamFailed = false;
        await streamChat(
          {
            system: prompt.system,
            user: prompt.user,
            stream: true,
            maxTokens: SUMMARY_MAX_TOKENS,
            model: config.model,
          },
          config,
          (event: StreamEvent) => {
            if (event.kind === "delta") {
              outputRef.current += event.text;
              setOutput(outputRef.current);
            } else if (event.kind === "error") {
              streamFailed = true;
              setError(event.error);
              setState("error");
            } else if (event.kind === "done") {
              // 成功结束才进入 done 态并写历史;失败/中止路径绝不落库。
              // 重新生成(replace)传原记录 id → update 同一记录;新总结传 null → create 新记录
              if (!streamFailed) {
                setState("done");
                void saveHistory(text, outputRef.current, replace ? originalId : null);
              }
            }
          },
          { signal: abortRef.current.signal },
        );
      } catch (err) {
        // 主动中止(新会话重置 / 停止按钮)不覆盖当前状态 —— 否则旧请求的 abort
        // 会把新会话刚重置的 idle 或 stop 后的 done 误置为 error
        if (err instanceof DOMException && err.name === "AbortError") {
          return;
        }
        setError({ type: "network", message: "请求已中止" });
        setState("error");
      }
    },
    [cfgRef, resolvePrompt, saveHistory],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
    setState("done");
  }, []);

  // 切换提示词:循环到下一个,并用当前输入重新总结(内置∪用户并集)
  const switchPrompt = useCallback(
    (currentInput: string) => {
      const allPrompts = [
        ...BUILTIN_PROMPTS,
        ...(cfgRef.current?.prompts ?? []).filter((p) => !p.isBuiltin),
      ];
      if (!allPrompts.length) return;
      const cur = promptIdRef.current;
      const idx = cur ? Math.max(0, allPrompts.findIndex((p) => p.id === cur)) : 0;
      const next = allPrompts[(idx + 1) % allPrompts.length];
      promptIdRef.current = next.id;
      if (currentInput) void run(currentInput);
    },
    [cfgRef, run],
  );

  const setPromptId = useCallback((id: string | null) => {
    promptIdRef.current = id;
  }, []);

  const setModelId = useCallback((model: string | null) => {
    modelRef.current = model;
  }, []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    outputRef.current = "";
    setOutput("");
    setError(null);
    setState("idle");
    historyIdRef.current = null;
    setHistoryId(null);
    promptIdRef.current = null;
    modelRef.current = null;
  }, []);

  return {
    output,
    state,
    error,
    historyId,
    run,
    stop,
    reset,
    outputRef,
    switchPrompt,
    setPromptId,
    setModelId,
  };
}
