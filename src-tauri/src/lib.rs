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
use tauri_plugin_log::{RotationStrategy, Target, TargetKind};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(build_log_plugin())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_dialog::init())
        // 单实例:Windows 下双击桌面图标/开始菜单再次启动,OS 不会像 macOS 那样阻止第二进程,
        // 不强制则会起多个 ReadBrief。插件在主实例收到回调,把已运行实例的主窗口唤到前台。
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            let _ = crate::windows::show_main(app.clone());
        }))
        .invoke_handler(tauri::generate_handler![
            ai::ai_stream,
            ai::ai_test,
            ai::ai_list_models,
            commands::config_get,
            commands::config_save,
            commands::config_reset,
            commands::set_capture_paused,
            commands::export_data,
            commands::export_logs,
            commands::open_data_dir,
            commands::reveal_path,
            commands::autostart_status,
            commands::autostart_set,
            commands::get_app_arch,
            commands::get_platform,
            history::history_create,
            history::history_list,
            history::history_count,
            history::history_get,
            history::history_delete,
            history::history_toggle_favorite,
            history::history_clear,
            history::history_today_count,
            history::history_prune_count,
            history::history_prune,
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
            windows::float_drag_move,
            windows::float_regenerate,
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
        shortcuts::register_open_settings_shortcut(app.handle())?;
        tray::setup_tray(app.handle())?;
        Ok(())
    });

    #[cfg(not(target_os = "macos"))]
    let builder = builder.setup(|app| {
        setup_app(app)?;
        windows::setup_window_handlers(app.handle());
        shortcuts::register_default_shortcut(app.handle())?;
        shortcuts::register_open_settings_shortcut(app.handle())?;
        tray::setup_tray(app.handle())?;
        Ok(())
    });

    builder
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // macOS:点击 Dock 图标 → 重新打开主窗口(窗口隐藏或销毁后均需恢复入口)
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                let _ = windows::show_main(app_handle.clone());
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (app_handle, event);
        });
}

/// 初始化数据库:失败时弹可读错误弹窗并终止启动(而非静默 panic)
fn setup_app<R: tauri::Runtime>(app: &mut tauri::App<R>) -> Result<(), Box<dyn std::error::Error>> {
    // 按配置的 diagnostics 开关设置运行时日志级别(开=Debug 全量,关=仅 warn/error)
    let diagnostics = crate::config::load_config().diagnostics;
    apply_diagnostics_level(diagnostics);
    install_panic_hook();

    match db::open_connection() {
        Ok(conn) => {
            // 启动时按保留时长清理一次超期历史(收藏记录豁免;失败不阻断启动)
            let retention = crate::config::load_config().history_retention;
            if let Err(e) = history::prune_expired(&conn, &retention) {
                log::warn!("启动清理超期历史失败: {e}");
            }
            app.manage(AppState {
                db: std::sync::Arc::new(std::sync::Mutex::new(conn)),
            });
            // 启动对账:让系统自启动状态对齐配置意图,修复 Windows 手动升级后自启动丢失
            reconcile_autostart(app);
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

/// 日志插件:Stdout(开发可见) + 文件轮转落盘。
/// 日志与配置/数据库同目录(~/Library/Application Support/ReadBrief/),「打开数据文件夹」一键可达。
/// 级别上限 Debug,实际输出由 apply_diagnostics_level 运行时控制。
fn build_log_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri_plugin_log::Builder::new()
        .targets([
            Target::new(TargetKind::Stdout),
            Target::new(TargetKind::Folder {
                path: crate::db::app_data_dir(),
                file_name: Some("readbrief".into()),
            }),
        ])
        .level(log::LevelFilter::Debug)
        .max_file_size(5 * 1024 * 1024)
        .rotation_strategy(RotationStrategy::KeepSome(3))
        .format(|out, message, record| {
            out.finish(format_args!(
                "[{}][{}][{}] {}",
                chrono::Local::now().format("%Y-%m-%d %H:%M:%S"),
                record.level(),
                record.target(),
                message
            ))
        })
        .build()
}

/// 运行时切换日志级别(诊断开关即时生效,无需重启):
/// 开 → Debug 全量;关 → 仅 warn/error(warn/error 始终落盘,崩溃类信息不丢)
pub fn apply_diagnostics_level(enabled: bool) {
    let level = if enabled {
        log::LevelFilter::Debug
    } else {
        log::LevelFilter::Warn
    };
    log::set_max_level(level);
    // 启动/切换留痕。warn 级别:任何状态下都落盘 —— 用户导出的日志无论开关与否都带版本号,
    // 且开启动作本身(远程支持工作流:「打开开关再复现」)会在日志中留下明确起点。
    log::warn!(
        "ReadBrief v{} 诊断日志已{}",
        env!("CARGO_PKG_VERSION"),
        if enabled { "开启(Debug 全量)" } else { "关闭(仅 warn/error)" }
    );
}

/// panic 时把崩溃信息追加写入数据目录 crash.log(先调默认 hook 保留原有行为)
fn install_panic_hook() {
    let log_dir = crate::db::app_data_dir();
    let original = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        original(info);
        let line = format!("[{}] PANIC: {info}\n\n", chrono::Local::now().to_rfc3339());
        let _ = std::fs::create_dir_all(&log_dir);
        let _ = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(log_dir.join("crash.log"))
            .and_then(|mut f| std::io::Write::write_all(&mut f, line.as_bytes()));
    }));
}

/// 启动对账：让系统自启动注册状态对齐配置意图(`launch_on_start`)。
///
/// 背景：Windows 上手动双击新版安装包升级时，NSIS 走 uninstall+reinstall 流程，
/// 卸载脚本会删除 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\ReadBrief` 注册表项，
/// 而安装脚本不会重新注册（应用内自动更新 `/UPDATE` 模式则不会删该项）。
/// 由于 `config.json` 默认不随卸载删除（除非用户勾选「删除应用数据」），
/// 这里在每次启动用配置意图校正系统状态，使升级后首次启动即自愈。
fn reconcile_autostart<R: tauri::Runtime>(app: &tauri::App<R>) {
    use tauri_plugin_autostart::ManagerExt;
    let intended = crate::config::load_config().launch_on_start;
    let current = match app.autolaunch().is_enabled() {
        Ok(v) => v,
        Err(e) => {
            log::warn!("读取自启动状态失败，跳过启动对账: {e}");
            return;
        }
    };
    if intended == current {
        return;
    }
    let res = if intended {
        app.autolaunch().enable()
    } else {
        app.autolaunch().disable()
    };
    match res {
        Ok(()) => log::info!(
            "自启动已对齐配置意图: {}",
            if intended { "开启" } else { "关闭" }
        ),
        Err(e) => log::warn!("自启动对账失败(意图={intended}): {e}"),
    }
}
