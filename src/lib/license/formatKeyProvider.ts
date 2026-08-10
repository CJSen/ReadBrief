import type { CheckResult, LicenseProvider, Usage } from "./types";
import { isWithinFreeLimit } from "./types";

const PRO_KEY_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: "openai", pattern: /^sk-[A-Za-z0-9_-]{20,}$/ },
  { name: "claude", pattern: /^sk-ant-[A-Za-z0-9_-]{20,}$/ },
  { name: "gemini", pattern: /^AIza[A-Za-z0-9_-]{30,}$/ },
];

export class FormatKeyLicenseProvider implements LicenseProvider {
  constructor(private readonly getApiKey: () => string) {}

  check(_usage: Usage): CheckResult {
    const pro = PRO_KEY_PATTERNS.some(({ pattern }) =>
      pattern.test(this.getApiKey()),
    );
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
