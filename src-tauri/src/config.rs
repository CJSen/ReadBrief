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
    /// 提示词类别:summary(总结)/translate(翻译)/qa(问答)/general(通用)。
    /// 决定拼接哪套系统提示词模板与历史标题解析方式。
    /// 旧配置缺该字段时回退 "summary"(行为与改动前一致)。
    #[serde(default = "default_prompt_tag")]
    pub tag: String,
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
    // 首启引导:用户完成或跳过四步引导后置 true(旧配置缺失时视为未完成)
    #[serde(default)]
    pub onboarding_done: bool,
    // 首启引导当前步骤(0..3):重启软件后引导可从该步继续,避免中途重启后从头再来。
    // 仅 onboarding_done=false 时有意义;完成/跳过时置空。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub onboarding_step: Option<u32>,
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

fn default_prompt_tag() -> String {
    "summary".to_string()
}

fn default_onboarding_done() -> bool {
    false
}

/// 内置快捷键的默认绑定：开箱即用时即存在，但全部可在设置页修改/删除，
/// 不再由后端无条件「注入」到系统。划词总结默认 ⌘+Shift+Z（Windows/Linux 为 Ctrl+Shift+Z）。
fn default_shortcuts() -> Vec<ShortcutConfig> {
    #[cfg(target_os = "macos")]
    let summarize_accel = "Cmd+Shift+Z".to_string();
    #[cfg(not(target_os = "macos"))]
    let summarize_accel = "Ctrl+Shift+Z".to_string();
    #[cfg(target_os = "macos")]
    let open_main_accel = "Cmd+Shift+H".to_string();
    #[cfg(not(target_os = "macos"))]
    let open_main_accel = "Ctrl+Shift+H".to_string();
    vec![
        ShortcutConfig {
            id: "summarize".to_string(),
            accelerator: summarize_accel,
            prompt_id: Some("builtin-summarize".to_string()),
            action: "summarize".to_string(),
            name: Some("划词总结".to_string()),
            description: Some("选中文本后触发内置总结提示词".to_string()),
            is_default: true,
            model: None,
        },
        ShortcutConfig {
            id: "open-main".to_string(),
            accelerator: open_main_accel,
            prompt_id: None,
            action: "open-main".to_string(),
            name: Some("打开主窗口".to_string()),
            description: Some("显示并聚焦 ReadBrief 主窗口".to_string()),
            is_default: true,
            model: None,
        },
        ShortcutConfig {
            id: "paste".to_string(),
            accelerator: String::new(),
            prompt_id: Some("builtin-qa".to_string()),
            action: "paste".to_string(),
            name: Some("呼出输入框".to_string()),
            description: Some("粘贴任意文本进行问答".to_string()),
            is_default: true,
            model: None,
        },
        ShortcutConfig {
            id: "translate".to_string(),
            accelerator: String::new(),
            prompt_id: Some("builtin-translate".to_string()),
            action: "prompt".to_string(),
            name: Some("翻译并总结".to_string()),
            description: Some("翻译后总结选中内容".to_string()),
            is_default: true,
            model: None,
        },
    ]
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
            shortcuts: default_shortcuts(),
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
            onboarding_done: default_onboarding_done(),
            onboarding_step: None,
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
    cfg.onboarding_done = value
        .get("onboardingDone")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    cfg.onboarding_step = value
        .get("onboardingStep")
        .and_then(|v| v.as_u64())
        .map(|n| n as u32);

    // 迁移:补齐用户从未显式配置过的内置快捷键默认绑定(划词总结默认 ⌘+Shift+Z)。
    // 若 config 中已存在该内置 id(含用户主动清空的情况),则尊重用户选择,不再注入隐藏默认值。
    let existing_ids: std::collections::HashSet<String> =
        cfg.shortcuts.iter().map(|s| s.id.clone()).collect();
    for d in default_shortcuts() {
        if !existing_ids.contains(&d.id) {
            cfg.shortcuts.push(d);
        }
    }

    // 迁移(0.1.0):「呼出输入框」默认提示词由「总结提示词」改为「问答提示词」。
    // 仅当仍处于旧默认态(prompt_id=builtin-summarize 且 action=paste,即从未在设置页改过
    // —— UI 上改过提示词会把 action 置为 "prompt")时才就地更新,尊重用户的显式选择。
    for s in cfg.shortcuts.iter_mut() {
        if s.id == "paste"
            && s.action == "paste"
            && s.prompt_id.as_deref() == Some("builtin-summarize")
        {
            s.prompt_id = Some("builtin-qa".to_string());
        }
    }
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
