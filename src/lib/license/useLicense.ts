import { useMemo } from "react";
import { FormatKeyLicenseProvider, type CheckResult } from ".";
import { getDefaultService, type AppConfig } from "../config/types";

/**
 * 许可证判定 hook(P2-7):收敛 PromptManager / ShortcutsPage 两处重复的
 * FormatKeyLicenseProvider 构造 + check 调用,统一从配置解析 pro 状态。
 *
 * ⚠️ 当前为占位语义:本地无后端,任何合法 BYOK 密钥都判 pro(见 P0-5 决策,暂不处理)。
 */
export function useLicense(cfg: AppConfig): CheckResult {
  return useMemo(() => {
    const provider = new FormatKeyLicenseProvider(
      () => cfg.api.apiKey || getDefaultService(cfg).apiKey,
    );
    return provider.check({ feature: "any" });
  }, [cfg]);
}
