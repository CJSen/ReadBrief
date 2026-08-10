import { describe, expect, it } from "vitest";
import {
  FormatKeyLicenseProvider,
  matchesProKeyFormat,
  isWithinFreeLimit,
  FREE_PROMPT_LIMIT,
  FREE_SHORTCUT_LIMIT,
} from "../index";

describe("FormatKeyLicenseProvider", () => {
  it("OpenAI 格式 key 解锁 Pro", () => {
    const p = new FormatKeyLicenseProvider(() => "sk-abcdefghijklmnopqrstuvwxyz");
    expect(p.check({ feature: "any" }).pro).toBe(true);
    expect(p.check({ feature: "any" }).plan).toBe("pro");
  });

  it("Claude 格式 key 解锁 Pro", () => {
    const p = new FormatKeyLicenseProvider(() => "sk-ant-api03-abcdefghijklmnopqrstuv");
    expect(p.check({ feature: "any" }).pro).toBe(true);
  });

  it("Gemini 格式 key 解锁 Pro", () => {
    const p = new FormatKeyLicenseProvider(() => "AIzaSyA-verylongkeyabcdefghijklmnopqrstuvwxyz");
    expect(p.check({ feature: "any" }).pro).toBe(true);
  });

  it("无效 key 保持 free", () => {
    const p = new FormatKeyLicenseProvider(() => "invalid");
    expect(p.check({ feature: "any" }).pro).toBe(false);
    expect(p.check({ feature: "any" }).plan).toBe("free");
  });

  it("空 key 保持 free", () => {
    const p = new FormatKeyLicenseProvider(() => "");
    expect(p.check({ feature: "any" }).pro).toBe(false);
  });
});

describe("matchesProKeyFormat", () => {
  it("识别各协议格式", () => {
    expect(matchesProKeyFormat("sk-validkey123456789012")).toBe(true);
    expect(matchesProKeyFormat("sk-ant-validkey1234567890123456")).toBe(true);
    expect(matchesProKeyFormat("AIzaSyA-verylongkeyabcdefghijklmnopqrstuvwxyz")).toBe(true);
    expect(matchesProKeyFormat("nonsense")).toBe(false);
  });
});

describe("免费额度限制", () => {
  it("免费用户第 3 个提示词可创建,第 4 个不可", () => {
    expect(isWithinFreeLimit({ feature: "prompt", current: 2 }, false)).toBe(true);
    expect(isWithinFreeLimit({ feature: "prompt", current: FREE_PROMPT_LIMIT }, false)).toBe(
      false,
    );
  });

  it("免费用户第 2 个快捷键可创建,第 3 个不可", () => {
    expect(isWithinFreeLimit({ feature: "shortcut", current: 1 }, false)).toBe(true);
    expect(
      isWithinFreeLimit({ feature: "shortcut", current: FREE_SHORTCUT_LIMIT }, false),
    ).toBe(false);
  });

  it("Pro 用户无限制", () => {
    expect(
      isWithinFreeLimit({ feature: "prompt", current: 100 }, true),
    ).toBe(true);
    expect(
      isWithinFreeLimit({ feature: "shortcut", current: 100 }, true),
    ).toBe(true);
  });
});
