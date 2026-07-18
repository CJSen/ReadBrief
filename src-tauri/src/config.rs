use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/config/generated.ts")]
pub struct ApiConfig {
    #[ts(optional = nullable)]
    pub id: Option<String>,
    #[ts(optional = nullable)]
    pub name: Option<String>,
    pub protocol: String,
    pub api_key: String,
    pub base_url: String,
    pub model: String,
    #[serde(default)]
    pub is_default: bool,
    #[serde(default)]
    pub stream: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/config/generated.ts")]
pub struct PromptConfig {
    pub id: String,
    pub name: String,
    pub content: String,
    pub model: String,
    #[ts(optional = nullable)]
    pub shortcut: Option<String>,
    pub output_format: String,
    /// 是否为内置提示词(不可修改/删除)
    #[serde(default)]
    pub is_builtin: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/config/generated.ts")]
pub struct ShortcutConfig {
    pub id: String,
    pub accelerator: String,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub prompt_id: Option<String>,
    pub action: String,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub name: Option<String>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub description: Option<String>,
    #[serde(default)]
    pub is_default: bool,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub model: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/config/generated.ts")]
pub struct AppConfig {
    pub api: ApiConfig,
    #[serde(default)]
    pub services: Vec<ApiConfig>,
    #[serde(default)]
    pub prompts: Vec<PromptConfig>,
    #[serde(default)]
    pub shortcuts: Vec<ShortcutConfig>,
    #[serde(default = "default_language")]
    pub language: String,
    #[serde(default = "default_theme")]
    pub theme: String,
    // 通用设置(全部带默认值,旧配置缺失时自动补齐)
    #[serde(default = "default_true")]
    pub launch_on_start: bool,
    #[serde(default = "default_true")]
    pub min_to_tray: bool,
    #[serde(default = "default_true")]
    pub selection_on: bool,
    #[serde(default = "default_true")]
    pub esc_close: bool,
    #[serde(default)]
    pub click_outside: bool,
    // 总结输出语言:system(跟随界面) / zh / en
    #[serde(default = "default_summary_lang")]
    pub summary_language: String,
    // 匿名诊断数据开关
    #[serde(default)]
    pub diagnostics: bool,
    // 字体缩放:1.0 = 100%
    #[serde(default = "default_font_scale")]
    pub font_scale: f32,
}

fn default_language() -> String {
    "zh".to_string()
}

fn default_theme() -> String {
    "system".to_string()
}

fn default_true() -> bool {
    true
}

fn default_summary_lang() -> String {
    "system".to_string()
}

fn default_font_scale() -> f32 {
    1.0
}

impl Default for ApiConfig {
    fn default() -> Self {
        Self {
            id: None,
            name: None,
            protocol: "openai".to_string(),
            api_key: String::new(),
            base_url: String::new(),
            model: String::new(),
            is_default: true,
            stream: true,
        }
    }
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            api: ApiConfig::default(),
            services: Vec::new(),
            prompts: Vec::new(),
            shortcuts: Vec::new(),
            language: default_language(),
            theme: default_theme(),
            launch_on_start: default_true(),
            min_to_tray: default_true(),
            selection_on: default_true(),
            esc_close: default_true(),
            click_outside: default_true(),
            summary_language: default_summary_lang(),
            diagnostics: false,
            font_scale: default_font_scale(),
        }
    }
}

pub fn config_path() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("ReadBrief")
        .join("config.json")
}

pub fn load_config() -> AppConfig {
    let path = config_path();
    if !path.exists() {
        return AppConfig::default();
    }
    let content = std::fs::read_to_string(&path).unwrap_or_default();
    parse_config(&content)
}

pub fn parse_config(content: &str) -> AppConfig {
    let value: serde_json::Value = serde_json::from_str(content).unwrap_or_default();
    let mut cfg = AppConfig::default();

    if let Some(api) = value.get("api") {
        if let Ok(a) = serde_json::from_value::<ApiConfig>(api.clone()) {
            cfg.api = a;
        }
    }
    if let Some(services) = value.get("services").and_then(|v| v.as_array()) {
        cfg.services = services
            .iter()
            .filter_map(|s| serde_json::from_value::<ApiConfig>(s.clone()).ok())
            .collect();
    }
    if let Some(prompts) = value.get("prompts").and_then(|v| v.as_array()) {
        cfg.prompts = prompts
            .iter()
            .filter_map(|p| serde_json::from_value::<PromptConfig>(p.clone()).ok())
            .collect();
    }
    if let Some(shortcuts) = value.get("shortcuts").and_then(|v| v.as_array()) {
        cfg.shortcuts = shortcuts
            .iter()
            .filter_map(|s| serde_json::from_value::<ShortcutConfig>(s.clone()).ok())
            .collect();
    }
    if let Some(lang) = value.get("language").and_then(|v| v.as_str()) {
        cfg.language = lang.to_string();
    }
    if let Some(theme) = value.get("theme").and_then(|v| v.as_str()) {
        cfg.theme = theme.to_string();
    }
    // 通用设置字段(宽松解析,失败保持默认值)
    cfg.launch_on_start = value
        .get("launchOnStart")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    cfg.min_to_tray = value
        .get("minToTray")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    cfg.selection_on = value
        .get("selectionOn")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    cfg.esc_close = value.get("escClose").and_then(|v| v.as_bool()).unwrap_or(true);
    cfg.click_outside = value
        .get("clickOutside")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    cfg.summary_language = value
        .get("summaryLanguage")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(default_summary_lang);
    cfg.diagnostics = value
        .get("diagnostics")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    cfg.font_scale = value
        .get("fontScale")
        .and_then(|v| v.as_f64())
        .map(|f| f as f32)
        .unwrap_or(1.0);
    cfg
}

pub fn save_config(cfg: &AppConfig) -> AppResult<()> {
    let path = config_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| AppError::from(e.to_string()))?;
    }
    let json = serde_json::to_string_pretty(cfg).map_err(|e| AppError::from(e.to_string()))?;
    std::fs::write(&path, json).map_err(|e| AppError::from(e.to_string()))
}
