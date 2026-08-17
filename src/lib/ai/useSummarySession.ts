import { useCallback, useRef, useState, type RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { streamChat } from "../ai/provider";
import type { ProviderError, ProviderType, StreamEvent } from "../ai/types";
import { maxTokensForProtocol } from "../ai/constants";
import type { AppConfig } from "../config/types";
import { getDefaultService } from "../config/types";
import { getLanguage } from "../i18n";
import type { PromptTag } from "../prompts/builtins";
import {
  getRole,
  getFormatRule,
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
 * 按提示词类别解析标题与正文:
 * - summary:首行=标题(中英文混排不截断),其余=要点正文(模型未换行时整段兜底正文)。
 * - translate/qa:模型遵循「翻译：/问答：」前缀约定则首行作标题(保留前缀),其后为正文;
 *   未遵循(无换行或无前缀)时回退为提示词名作标题、整段作正文,避免丢失输出。
 * - general:首行=标题(无前缀),其余=正文;无换行/空标题时回退提示词名作标题。
 */
function parseOutput(
  summary: string,
  tag: PromptTag | string,
  promptName: string,
): { title: string; body: string } {
  const text = summary.trim();
  if (tag === "summary") {
    const nl = summary.indexOf("\n");
    const rawTitle = (nl >= 0 ? summary.slice(0, nl) : summary).trim();
    const title = rawTitle || "总结";
    let body = nl >= 0 ? summary.slice(nl + 1).trim() : "";
    if (!body) body = text;
    return { title, body };
  }
  if (tag === "translate" || tag === "qa") {
    const nl = summary.indexOf("\n");
    const firstLine = (nl >= 0 ? summary.slice(0, nl) : summary).trim();
    // 模型遵循「翻译：/问答：」前缀约定 → 首行作标题,其后为正文
    if (nl >= 0 && /^(翻译|问答)[：:]/.test(firstLine)) {
      const body = summary.slice(nl + 1).trim();
      return { title: firstLine, body: body || text };
    }
    // 未遵循约定 → 标题用提示词名,正文为完整输出
    return { title: promptName, body: text };
  }
  // general:首行=标题(无前缀),其余=正文;无换行/空标题时回退提示词名
  const nl = summary.indexOf("\n");
  const rawTitle = (nl >= 0 ? summary.slice(0, nl) : summary).trim();
  const title = rawTitle || promptName;
  const body = nl >= 0 ? summary.slice(nl + 1).trim() : "";
  return { title, body: body || text };
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
  /** 思考型模型阶段标记:streaming 且模型返回 reasoning_content 时为 true(浮窗显示「思考中」) */
  thinking: boolean;
  /** 本次会话的思考内容(思考型模型;仅当前会话展示,不落库) */
  reasoning: string;
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
  /** 当前生效提示词名称(供浮窗标题栏/历史展示) */
  promptName: string;
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
  /** 思考型模型阶段标记:收到 ai-thinking 事件置 true,首个正文 delta/done/error/reset 时清除 */
  const [thinking, setThinking] = useState(false);
  /** 本次会话思考内容(思考型模型的 reasoning 增量累计;仅展示,不落库) */
  const [reasoning, setReasoning] = useState("");
  const reasoningRef = useRef("");
  /** 当前生效提示词名称(供浮窗标题栏/历史展示,取代写死的「要点总结」) */
  const [promptName, setPromptName] = useState("");

  const abortRef = useRef<AbortController | null>(null);
  const outputRef = useRef("");
  const promptIdRef = useRef<string | null>(null);
  const modelRef = useRef<string | null>(null);
  /** historyId 的可变镜像:供 run/saveHistory 在流式期间读取原记录 id(重新生成替换用),避免闭包过期 */
  const historyIdRef = useRef<number | null>(null);

  /** 解析当前提示词:capture 携带 promptId 优先(内置∪用户并集),否则用户提示词优先、内置兜底 */
  const resolvePrompt = useCallback((text: string) => {
    const userPrompts = cfgRef.current?.prompts ?? [];
    // 默认提示词:用户提示词优先,内置提示词兜底。
    // 此前仅取用户提示词(prompts[0]),无自定义提示词时 prompt 为 undefined,
    // 导致 name 回退成「要点总结」而非真实提示词名(浮窗标题/历史 promptName 错显)。
    const fallbackList = [...userPrompts, ...BUILTIN_PROMPTS];
    const prompt = promptIdRef.current
      ? (findBuiltinPrompt(promptIdRef.current) ?? userPrompts.find((p) => p.id === promptIdRef.current))
      : fallbackList[0];
    const lang = resolveSummaryLang(cfgRef.current);
    // 按提示词类别取格式规则:summary 沿用原总结规则;translate/qa 用各自带标题前缀的规则;
    // general 无规则(空串),仅保留角色基线。修复「隐藏系统提示词把一切强转总结」的问题。
    const tag: PromptTag = (prompt?.tag as PromptTag) ?? "summary";
    const role = getRole(tag, lang);
    const rule = getFormatRule(tag, lang);
    const system = rule ? `${role}\n\n${rule}` : role;
    // name 始终取提示词名称;仅极端无提示词时才回退「要点总结」
    const name = prompt?.name ?? (lang === "en" ? "Summary" : "要点总结");
    if (prompt?.content) {
      // 提示词含 {{text}} 占位符则替换为包裹文本;不含则把原文以分隔符附在其后,避免丢失且防注入
      const user =
        prompt.content.indexOf("{{text}}") >= 0
          ? prompt.content.replace(/\{\{text\}\}/g, wrapText(text))
          : `${prompt.content}\n\n${wrapText(text)}`;
      return { system, user, name, tag };
    }
    // 无 content(极少见):仍用提示词名称,保证浮窗标题/历史 promptName 显示一致,不悬空成「要点总结」
    return { system, user: wrapText(text), name, tag };
  }, [cfgRef]);

  /**
   * 落库:按提示词类别解析标题与正文后入库。
   * meta.tag/meta.name 由调用方(已解析出的 prompt)传入,避免重复解析。
   * replaceId 非空 = 重新生成场景 → update 原记录(保持原文/标签/收藏),否则 create 新记录。
   */
  const saveHistory = useCallback(
    async (
      source: string,
      summary: string,
      replaceId: number | null,
      meta: { tag: string; name: string },
    ) => {
      try {
        const { title, body } = parseOutput(summary, meta.tag, meta.name);
        const model = cfgRef.current ? getDefaultService(cfgRef.current).model : "";
        const promptName = meta.name;
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
    [cfgRef],
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
      setThinking(false);
      reasoningRef.current = "";
      setReasoning("");
      setState("streaming");

      const prompt = resolvePrompt(text);
      setPromptName(prompt.name);
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
        // 按协议取默认 max_tokens(claude 配额分离 / gemini 思考占配额 / openai 兼容预留思考)
        const maxTokens = maxTokensForProtocol(config.type);
        await streamChat(
          {
            system: prompt.system,
            user: prompt.user,
            stream: true,
            maxTokens,
            model: config.model,
          },
          config,
          (event: StreamEvent) => {
            if (event.kind === "thinking") {
              // 思考型模型:累计思考增量,标记「思考中」(思考内容不落库)
              setThinking(true);
              reasoningRef.current += event.text;
              setReasoning(reasoningRef.current);
            } else if (event.kind === "delta") {
              // 首个正文增量到达:思考阶段结束
              setThinking(false);
              outputRef.current += event.text;
              setOutput(outputRef.current);
            } else if (event.kind === "error") {
              setThinking(false);
              streamFailed = true;
              setError(event.error);
              setState("error");
            } else if (event.kind === "done") {
              // 成功结束才进入 done 态并写历史;失败/中止路径绝不落库。
              // 重新生成(replace)传原记录 id → update 同一记录;新总结传 null → create 新记录
              if (!streamFailed) {
                setThinking(false);
                setState("done");
                void saveHistory(text, outputRef.current, replace ? originalId : null, {
                  tag: prompt.tag,
                  name: prompt.name,
                });
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
    setThinking(false);
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
    setThinking(false);
    reasoningRef.current = "";
    setReasoning("");
    setState("idle");
    historyIdRef.current = null;
    setHistoryId(null);
    promptIdRef.current = null;
    modelRef.current = null;
    setPromptName("");
  }, []);

  return {
    output,
    state,
    error,
    historyId,
    thinking,
    reasoning,
    run,
    stop,
    reset,
    outputRef,
    switchPrompt,
    setPromptId,
    setModelId,
    promptName,
  };
}
