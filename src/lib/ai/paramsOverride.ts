import { t, getLanguage } from "../i18n";

/**
 * deepseek 预填值已迁移到快捷键级动态默认(Rust 侧 shortcuts.rs 注册时解析,
 * UI 侧 ShortcutsPage 的 dsPreset 按语言生成带注释展示版)。
 * 服务级预填已按产品决策移除:服务=连接方式,行为差异(如关思考)归快捷键(用途)层。
 */

/** deepseek 预填的规范形态(strip 注释并 trim 后),供 UI 判定「内容是否等于默认值」 */
export const DS_CANONICAL_EXTRA = '{\n  "thinking": { "type": "disabled" }\n}';

/** 系统控制的字段:extraParams 里的同名键会被 Rust 侧忽略(日志点名) */
const RESERVED_PARAM_KEYS = [
  "model",
  "messages",
  "contents",
  "stream",
  "max_tokens",
  "maxOutputTokens",
  "system",
];

/**
 * 剥离 JSON 里的注释(// 行注释与 /* 块注释 *\/),字符串内部的 // 不受影响。
 * extra_params 面向人手阅读,允许带注释;但上游 API 不接受,发送前必须剥掉。
 *
 * 必须与 Rust 侧 `ai.rs::strip_json_comments` 行为一致,否则会出现
 * 「前端校验通过、后端跳过附加参数」的不一致。
 */
export function stripJsonComments(input: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < input.length; i += 1) {
    const c = input[i];
    if (inString) {
      out += c;
      if (c === "\\") {
        // 跳过被转义的下一字符,避免 \" 误判为字符串结束
        out += input[i + 1] ?? "";
        i += 1;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === "/") {
      const next = input[i + 1];
      if (next === "/") {
        // 行注释:丢弃到换行(保留换行,维持行号以便定位错误)
        while (i < input.length && input[i] !== "\n") i += 1;
        out += "\n";
        continue;
      }
      if (next === "*") {
        i += 2;
        while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) {
          if (input[i] === "\n") out += "\n";
          i += 1;
        }
        i += 1; // 跳过块注释的 '/'
        continue;
      }
    }
    out += c;
  }
  return out;
}

export interface ParamsIssue {
  level: "error" | "warn";
  text: string;
}

/**
 * 校验附加参数。仅用于提示 —— 不阻断保存,也不阻断请求:
 * 非法内容由 Rust 侧降级为「不附加任何参数」,绝不因此让划词总结失败。
 */
export function checkParams(text: string): ParamsIssue | null {
  const raw = text.trim();
  if (!raw) return null;
  let v: unknown;
  try {
    // 允许带注释:先剥离再解析(与 Rust 侧发送前处理保持一致)
    v = JSON.parse(stripJsonComments(raw));
  } catch (e) {
    return { level: "error", text: t("ai.paramsJsonError", { err: (e as Error).message }) };
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    return { level: "error", text: t("ai.paramsNotObject") };
  }
  const hit = Object.keys(v).filter((k) => RESERVED_PARAM_KEYS.includes(k));
  if (hit.length) {
    // 分隔符随语言切换:中文用顿号,英文用逗号
    const sep = getLanguage() === "en" ? ", " : "、";
    return { level: "warn", text: t("ai.paramsReserved", { keys: hit.join(sep) }) };
  }
  return null;
}
