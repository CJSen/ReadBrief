import type { CheckResult, LicenseProvider, Usage } from "./types";
import { isWithinFreeLimit } from "./types";

const PRO_KEY_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: "openai", pattern: /^sk-[A-Za-z0-9_-]{20,}$/ },
  { name: "claude", pattern: /^sk-ant-[A-Za-z0-9_-]{20,}$/ },
  { name: "gemini", pattern: /^AIza[A-Za-z0-9_-]{30,}$/ },
];

export class FormatKeyLicenseProvider implements LicenseProvider {
  // 临时解锁:当前处于开发/免费阶段,解除所有 Pro 限制(后续接真实许可后再恢复按密钥判定)。
  // 保留构造参数以兼容调用方,暂不使用。
  constructor(_getApiKey: () => string) {}

  check(_usage: Usage): CheckResult {
    const pro = true;
    return {
      pro,
      plan: pro ? "pro" : "free",
    };
  }

  canCreate(usage: Usage): boolean {
    return isWithinFreeLimit(usage, this.check(usage).pro);
  }
}

export function matchesProKeyFormat(key: string): boolean {
  return PRO_KEY_PATTERNS.some(({ pattern }) => pattern.test(key));
}
