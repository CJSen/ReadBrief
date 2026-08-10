export type Plan = "free" | "pro";

export interface CheckResult {
  pro: boolean;
  plan: Plan;
}

export type Usage =
  | { feature: "prompt"; current: number }
  | { feature: "shortcut"; current: number }
  | { feature: "any" };

export interface LicenseProvider {
  check(usage: Usage): CheckResult;
}

export const FREE_PROMPT_LIMIT = 3;
export const FREE_SHORTCUT_LIMIT = 2;

export function isWithinFreeLimit(usage: Usage, pro: boolean): boolean {
  if (pro) {
    return true;
  }
  switch (usage.feature) {
    case "prompt":
      return usage.current < FREE_PROMPT_LIMIT;
    case "shortcut":
      return usage.current < FREE_SHORTCUT_LIMIT;
    case "any":
      return true;
  }
}
