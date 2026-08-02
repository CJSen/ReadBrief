#[cfg(test)]
mod tests {
    use crate::config::{self, AppConfig};

    #[test]
    fn parse_config_fills_defaults() {
        let cfg = config::parse_config(r#"{"language":"en"}"#);
        assert_eq!(cfg.language, "en");
        assert_eq!(cfg.theme, "system");
        assert_eq!(cfg.api.protocol, "openai");
        assert!(cfg.prompts.is_empty());
    }

    #[test]
    fn parse_config_full_structure() {
        let raw = r#"
        {
          "api": {"protocol": "claude", "apiKey": "sk-ant-test", "baseUrl": "", "model": "claude-sonnet"},
          "prompts": [{"id": "p1", "name": "总结", "content": "用{{text}}总结", "model": "gpt", "shortcut": null, "outputFormat": "md"}],
          "shortcuts": [{"id": "s1", "accelerator": "CmdOrCtrl+Shift+Z", "promptId": "p1", "action": "summarize"}],
          "language": "zh",
          "theme": "dark"
        }"#;
        let cfg: AppConfig = config::parse_config(raw);
        assert_eq!(cfg.api.protocol, "claude");
        assert_eq!(cfg.api.api_key, "sk-ant-test");
        assert_eq!(cfg.prompts.len(), 1);
        assert_eq!(cfg.prompts[0].content, "用{{text}}总结");
        assert_eq!(cfg.shortcuts.len(), 1);
        assert_eq!(cfg.shortcuts[0].accelerator, "CmdOrCtrl+Shift+Z");
        assert_eq!(cfg.theme, "dark");
    }

    #[test]
    fn parse_config_invalid_returns_defaults() {
        let cfg = config::parse_config("not json");
        assert_eq!(cfg.language, "zh");
        assert!(cfg.prompts.is_empty());
    }

    #[test]
    fn parse_config_services() {
        let raw = r#"
        {
          "services": [
            {"id": "s1", "name": "OpenAI 官方", "protocol": "openai", "apiKey": "sk-a", "baseUrl": "", "model": "gpt-4o-mini", "isDefault": true, "stream": true},
            {"id": "s2", "name": "DeepSeek", "protocol": "openai", "apiKey": "sk-b", "baseUrl": "https://api.deepseek.com/v1", "model": "deepseek-chat", "isDefault": false, "stream": true}
          ]
        }"#;
        let cfg: AppConfig = config::parse_config(raw);
        assert_eq!(cfg.services.len(), 2);
        assert_eq!(cfg.services[0].name.as_deref(), Some("OpenAI 官方"));
        assert!(cfg.services[0].is_default);
        assert_eq!(cfg.services[1].base_url, "https://api.deepseek.com/v1");
    }

    #[test]
    fn parse_config_general_settings_defaults() {
        // 旧配置缺失通用设置字段 → 应补齐默认值,不 panic
        let cfg = config::parse_config(r#"{"language":"zh"}"#);
        assert!(cfg.launch_on_start);
        assert!(cfg.min_to_tray);
        assert!(cfg.selection_on);
        assert!(cfg.esc_close);
        assert!(cfg.click_outside);
        assert_eq!(cfg.summary_language, "system");
        assert!(!cfg.diagnostics);
        assert_eq!(cfg.font_scale, 1.0);
    }

    #[test]
    fn parse_config_general_settings_values() {
        let raw = r#"
        {
          "launchOnStart": false,
          "minToTray": false,
          "selectionOn": false,
          "escClose": false,
          "clickOutside": true,
          "summaryLanguage": "en",
          "diagnostics": true,
          "fontScale": 1.1
        }"#;
        let cfg: AppConfig = config::parse_config(raw);
        assert!(!cfg.launch_on_start);
        assert!(!cfg.min_to_tray);
        assert!(!cfg.selection_on);
        assert!(!cfg.esc_close);
        assert!(cfg.click_outside);
        assert_eq!(cfg.summary_language, "en");
        assert!(cfg.diagnostics);
        assert_eq!(cfg.font_scale, 1.1);
    }
}
