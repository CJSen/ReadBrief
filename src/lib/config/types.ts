/**
 * 前端配置类型 —— 由 Rust 侧唯一权威源生成(P2-8 schema 单一权威)。
 *
 * ⚠️ 本文件的类型定义由 `src-tauri/src/config.rs` 的 `#[ts(export)]` 导出，
 * 重新生成方式:
 *   cd src-tauri && cargo test export_types
 * 生成产物: src/lib/config/generated.ts（不要手改该文件）
 *
 * 这里仅做:重新导出 + 保留前端辅助函数(getServices / getDefaultService / ProviderType)。
 */

// 从 Rust 生成的单一权威类型源重新导出(Rust Option<T> → `T | null`)
import type {
  ApiConfig,
  AppConfig,
  PromptConfig,
  ShortcutConfig,
} from "./generated";

export type { ApiConfig, AppConfig, PromptConfig, ShortcutConfig };

export type ProviderType = "openai" | "claude" | "gemini" | "deepseek";

export function getServices(cfg: AppConfig): ApiConfig[] {
  const services = cfg.services?.length ? cfg.services : [cfg.api];
  return services;
}

export function getDefaultService(cfg: AppConfig): ApiConfig {
  const services = getServices(cfg);
  return services.find((s) => s.isDefault) ?? services[0];
}
