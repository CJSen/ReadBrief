pub mod ai;
pub mod commands;
pub mod config;
pub mod db;
pub mod error;
pub mod history;
pub mod native;
pub mod shortcuts;
pub mod tray;
pub mod windows;

/// 从 Rust 结构体导出 TS 类型到 src/lib/config/generated.ts(P2-8 schema 单一权威)。
/// 运行方式: `cargo test -p readbrief export_types`
#[cfg(test)]
mod tests {
    use ts_rs::TS;

    #[test]
    fn export_types() {
        crate::config::ApiConfig::export_all().expect("导出 ApiConfig TS 类型失败");
        crate::config::PromptConfig::export_all().expect("导出 PromptConfig TS 类型失败");
        crate::config::ShortcutConfig::export_all().expect("导出 ShortcutConfig TS 类型失败");
        crate::config::AppConfig::export_all().expect("导出 AppConfig TS 类型失败");
    }
}

#[cfg(test)]
mod config_tests;
#[cfg(test)]
mod windows_tests;
#[cfg(test)]
mod history_tests;

use history::AppState;
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            ai::ai_stream,
            ai::ai_test,
            ai::ai_list_models,
            commands::config_get,
            commands::config_save,
            commands::config_reset,
            commands::set_capture_paused,
            commands::export_data,
            commands::open_data_dir,
            commands::autostart_status,
            commands::autostart_set,
            history::history_create,
            history::history_list,
            history::history_count,
            history::history_get,
            history::history_delete,
            history::history_toggle_favorite,
            history::history_clear,
            history::history_today_count,
            history::history_update_tags,
            history::history_update_summary,
            history::history_all_tags,
            history::history_create_tag,
            history::history_update_tag,
            history::history_delete_tag,
            shortcuts::shortcut_get_bindings,
            shortcuts::capture_read,
            shortcuts::float_mark_ready,
            shortcuts::clipboard_read_text,
            shortcuts::clipboard_write_text,
            shortcuts::accessibility_status,
            shortcuts::request_accessibility,
            shortcuts::screen_recording_status,
            shortcuts::request_screen_recording,
            tray::tray_refresh,
            windows::float_show,
            windows::float_hide,
            windows::float_toggle,
            windows::float_set_state,
            windows::float_regenerate,
            windows::float_start_drag,
            windows::open_settings,
            windows::open_settings_section,
            windows::open_privacy_settings,
            windows::show_main,
            windows::reveal_main_window,
            windows::hide_main,
        ]);

    #[cfg(target_os = "macos")]
    let builder = builder.setup(|app| {
        // Accessory 策略(LSUIElement 形态): 应用不拥有 Space、激活不触发 Space 归位,
        // key 面板在全屏 Space 上才能正常建立 IME 输入上下文(候选框跟随面板)。
        // 这是 Bob/Pot/Easydict 等全屏可用浮层应用的标准形态。
        // 见 audit/ime-fullscreen-space-diagnosis.md 方案 B。
        app.set_activation_policy(tauri::ActivationPolicy::Accessory);
        setup_app(app)?;
        windows::setup_window_handlers(app.handle());
        shortcuts::register_default_shortcut(app.handle())?;
        tray::setup_tray(app.handle())?;
        Ok(())
    });

    #[cfg(not(target_os = "macos"))]
    let builder = builder.setup(|app| {
        setup_app(app)?;
        shortcuts::register_default_shortcut(app.handle())?;
        tray::setup_tray(app.handle())?;
        Ok(())
    });

    builder
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // macOS:点击 Dock 图标 → 重新打开主窗口(窗口隐藏或销毁后均需恢复入口)
            if let tauri::RunEvent::Reopen { .. } = event {
                let _ = windows::show_main(app_handle.clone());
            }
        });
}

/// 初始化数据库:失败时弹可读错误弹窗并终止启动(而非静默 panic)
fn setup_app<R: tauri::Runtime>(app: &mut tauri::App<R>) -> Result<(), Box<dyn std::error::Error>> {
    // 按配置的 diagnostics 开关初始化日志级别:开启才输出 debug/info
    let diagnostics = crate::config::load_config().diagnostics;
    init_logger(diagnostics);

    match db::open_connection() {
        Ok(conn) => {
            app.manage(AppState {
                db: std::sync::Arc::new(std::sync::Mutex::new(conn)),
            });
            Ok(())
        }
        Err(e) => {
            let msg = format!(
                "数据库初始化失败：{e}\n\n应用数据目录: {}\n\n若为目录权限问题，请检查该目录是否可写；若为数据库损坏，应用将自动重建。",
                db::app_data_dir().display()
            );
            app.dialog()
                .message(msg)
                .title("ReadBrief 启动失败")
                .kind(tauri_plugin_dialog::MessageDialogKind::Error)
                .blocking_show();
            Err(e.into())
        }
    }
}

/// 统一日志门面(P3-1):按 diagnostics 开关决定输出级别。
/// 开启 → info/debug 全量输出;关闭 → 仅 warn/error。
fn init_logger(diagnostics: bool) {
    let filter = if diagnostics {
        log::LevelFilter::Debug
    } else {
        log::LevelFilter::Warn
    };
    env_logger::Builder::new()
        .filter_level(filter)
        .format_timestamp_secs()
        .try_init()
        .ok(); // 重复初始化静默忽略
}
