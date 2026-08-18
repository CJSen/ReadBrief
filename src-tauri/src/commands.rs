use crate::error::{AppError, AppResult};
use crate::config::{self, AppConfig};
use tauri::Emitter;

#[tauri::command]
pub async fn config_get() -> AppResult<AppConfig> {
    tauri::async_runtime::spawn_blocking(config::load_config)
        .await
        .map_err(|e| AppError::from(e.to_string()))
}

#[tauri::command]
pub fn config_save(app: tauri::AppHandle, cfg: AppConfig) -> AppResult<()> {
    config::save_config(&cfg)?;
    // 快捷键可能已变更:热更新全局注册
    crate::shortcuts::reload_shortcuts(&app)?;
    // 通知所有窗口配置已变更（Esc 关闭悬浮窗等开关需即时生效）
    let _ = app.emit("config-changed", &cfg);
    Ok(())
}

#[tauri::command]
pub fn config_reset() -> AppResult<AppConfig> {
    let cfg = AppConfig::default();
    config::save_config(&cfg)?;
    Ok(cfg)
}

/// 划词监听开关(设置中心「启用划词监听」/ 托盘暂停)
#[tauri::command]
pub fn set_capture_paused(app: tauri::AppHandle, paused: bool) -> AppResult<()> {
    crate::shortcuts::set_capture_paused(paused);
    let _ = app.emit(if paused { "capture-paused" } else { "capture-resumed" }, ());
    crate::tray::refresh_tray(&app);
    Ok(())
}

/// 导出全部数据(历史 + 配置)为 JSON,返回导出文件路径
#[tauri::command]
pub fn export_data(
    state: tauri::State<'_, crate::history::AppState>,
) -> AppResult<String> {
    use serde_json::json;
    let conn = state.db.lock().map_err(|e| AppError::from(e.to_string()))?;
    let records = crate::history::list(&conn, None)?;
    let cfg = config::load_config();
    let ts = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let dir = crate::db::app_data_dir().join("exports");
    std::fs::create_dir_all(&dir).map_err(|e| AppError::from(e.to_string()))?;
    let path = dir.join(format!("readbrief-export-{ts}.json"));
    let payload = json!({
        "exportedAt": chrono::Local::now().to_rfc3339(),
        "config": cfg,
        "history": records,
    });
    let content = serde_json::to_string_pretty(&payload).map_err(|e| AppError::from(e.to_string()))?;
    std::fs::write(&path, content).map_err(|e| AppError::from(e.to_string()))?;
    Ok(path.to_string_lossy().to_string())
}

/// 打开应用数据目录(设置页「打开数据文件夹」)
#[tauri::command]
pub fn open_data_dir(app: tauri::AppHandle) -> AppResult<()> {
    use tauri_plugin_opener::OpenerExt;
    let dir = crate::db::app_data_dir();
    let path = dir.to_string_lossy().to_string();
    app.opener()
        .open_path(path, None::<&str>)
        .map_err(|e| AppError::from(e.to_string()))
}

/// 开机启动状态(通用设置「开机启动」)
#[tauri::command]
pub fn autostart_status(app: tauri::AppHandle) -> AppResult<bool> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch()
        .is_enabled()
        .map_err(|e| AppError::from(e.to_string()))
}

/// 设置开机启动(写入系统 LaunchAgent)
#[tauri::command]
pub fn autostart_set(app: tauri::AppHandle, enabled: bool) -> AppResult<()> {
    use tauri_plugin_autostart::ManagerExt;
    let autolaunch = app.autolaunch();
    if enabled {
        autolaunch.enable().map_err(|e| AppError::from(e.to_string()))?;
    } else {
        autolaunch.disable().map_err(|e| AppError::from(e.to_string()))?;
    }
    Ok(())
}

/// 返回当前应用编译目标架构（aarch64 / x86_64 等），供前端匹配正确的 dmg 安装包
#[tauri::command]
pub fn get_app_arch() -> AppResult<String> {
    Ok(std::env::consts::ARCH.to_string())
}
