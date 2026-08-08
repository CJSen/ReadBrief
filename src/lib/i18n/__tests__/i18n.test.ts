import { describe, expect, it, beforeEach } from "vitest";
import { messages, setLanguage, getLanguage, t, subscribeLanguage } from "../index";

beforeEach(() => setLanguage("zh"));

describe("i18n", () => {
  it("默认中文", () => {
    expect(getLanguage()).toBe("zh");
    expect(t("float.stop")).toBe("停止");
  });

  it("切换英文生效", () => {
    setLanguage("en");
    expect(getLanguage()).toBe("en");
    expect(t("float.stop")).toBe("Stop");
    expect(t("errors.auth")).toContain("API key");
  });

  it("英文文案不短于中文(避免截断前提)", () => {
    const keys = Object.keys(messages.zh).flatMap((g) =>
      Object.keys(messages.zh[g as keyof typeof messages.zh]).map(
        (k) => `${g}.${k}`,
      ),
    );
    for (const key of keys) {
      const zhLen = t(key).length;
      setLanguage("en");
      const enLen = t(key).length;
      setLanguage("zh");
      expect(enLen, `key=${key} 英文不应短于中文`).toBeGreaterThanOrEqual(
        zhLen,
      );
    }
  });

  it("未知 key 原样返回", () => {
    expect(t("not.exists")).toBe("not.exists");
  });

  it("订阅语言变化", () => {
    let changed = 0;
    const unsub = subscribeLanguage(() => changed++);
    setLanguage("en");
    expect(changed).toBe(1);
    unsub();
    setLanguage("zh");
    expect(changed).toBe(1);
  });
});
