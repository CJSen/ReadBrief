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
    // 诊断开关即时生效(无需重启)
    crate::apply_diagnostics_level(cfg.diagnostics);
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

/// 导出诊断日志(轮转日志 + 崩溃记录合并为单个文本文件),返回导出路径。
/// 打开时机由前端控制(通知浮窗消失后调 reveal_path),此处只负责导出。
#[tauri::command]
pub fn export_logs() -> AppResult<String> {
    let buf = collect_logs_content(&crate::db::app_data_dir());

    let ts = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let dir = crate::db::app_data_dir().join("exports");
    std::fs::create_dir_all(&dir).map_err(|e| AppError::from(e.to_string()))?;
    let path = dir.join(format!("readbrief-logs-{ts}.txt"));
    std::fs::write(&path, buf).map_err(|e| AppError::from(e.to_string()))?;
    Ok(path.to_string_lossy().to_string())
}

/// 在访达中定位指定文件(macOS/Windows;Linux 不支持时报错返回)
#[tauri::command]
pub fn reveal_path(app: tauri::AppHandle, path: String) -> AppResult<()> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .reveal_item_in_dir(&path)
        .map_err(|e| AppError::from(e.to_string()))
}

/// 收集日志目录中 readbrief*.log 与 crash.log,按文件名排序合并为一个文本
pub fn collect_logs_content(log_dir: &std::path::Path) -> String {
    let mut files: Vec<std::path::PathBuf> = std::fs::read_dir(log_dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| {
                    let name = p.file_name().unwrap_or_default().to_string_lossy();
                    (name.starts_with("readbrief") && name.ends_with(".log")) || name == "crash.log"
                })
                .collect()
        })
        .unwrap_or_default();
    files.sort();

    let mut buf = String::new();
    if files.is_empty() {
        buf.push_str("无日志文件\n");
    }
    for f in &files {
        let name = f.file_name().unwrap_or_default().to_string_lossy();
        buf.push_str(&format!("══════ {name} ══════\n"));
        match std::fs::read_to_string(f) {
            Ok(c) => buf.push_str(&c),
            Err(e) => buf.push_str(&format!("<读取失败: {e}>\n")),
        }
        buf.push('\n');
    }
    buf
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 合并日志按名称排序且带标题() {
        let dir = std::env::temp_dir().join(format!("rb_logs_test_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("readbrief.log"), "当前日志").unwrap();
        std::fs::write(dir.join("readbrief_20260820.log"), "昨日归档").unwrap();
        std::fs::write(dir.join("crash.log"), "崩溃记录").unwrap();
        std::fs::write(dir.join("无关.txt"), "不应出现").unwrap();

        let out = collect_logs_content(&dir);
        assert!(out.contains("══════ crash.log ══════\n崩溃记录"));
        assert!(out.contains("══════ readbrief.log ══════\n当前日志"));
        assert!(out.contains("══════ readbrief_20260820.log ══════\n昨日归档"));
        assert!(!out.contains("不应出现"));
        // 排序:crash.log < readbrief.log < readbrief_20260820.log('.'<'_')
        let c1 = out.find("crash.log").unwrap();
        let c2 = out.find("readbrief.log ").unwrap();
        let c3 = out.find("readbrief_20260820.log").unwrap();
        assert!(c1 < c2 && c2 < c3);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn 空日志目录输出提示() {
        let dir = std::env::temp_dir().join(format!("rb_logs_empty_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(collect_logs_content(&dir), "无日志文件\n");
        // 目录不存在同样安全
        assert_eq!(
            collect_logs_content(&std::env::temp_dir().join("rb_logs_not_exist_xyz")),
            "无日志文件\n"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
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

/// 返回当前应用编译目标架构（aarch64 / x86_64 等），供前端匹配正确的安装包
#[tauri::command]
pub fn get_app_arch() -> AppResult<String> {
    Ok(std::env::consts::ARCH.to_string())
}

/// 返回当前应用编译目标平台（macos / windows / linux），供前端按平台筛选对应安装包
#[tauri::command]
pub fn get_platform() -> AppResult<String> {
    Ok(std::env::consts::OS.to_string())
}

/// OCR 文本识别：接收图片字节数据，返回识别出的文本
#[tauri::command]
pub fn ocr(image: Vec<u8>) -> AppResult<crate::ocr::types::OcrResult> {
    let request = crate::ocr::types::OcrRequest { image, languages: None };
    crate::ocr::recognize(request).map_err(|e| e.into())
}

/// 截图 OCR：调用系统截图工具截取屏幕区域，进行 OCR 识别，返回识别出的文本。
/// 前端调用后弹出系统截图选择框，用户选区完成后自动识别。
#[tauri::command]
pub fn screenshot_ocr() -> AppResult<crate::ocr::types::OcrResult> {
    let temp_path = std::env::temp_dir().join(format!("readbrief_screenshot_{}.png", std::process::id()));

    #[cfg(target_os = "macos")]
    {
        let output = std::process::Command::new("/usr/sbin/screencapture")
            .arg("-i")
            .arg("-r")
            .arg(&temp_path)
            .output()
            .map_err(|e| crate::error::AppError::Internal(format!("截图失败: {e}")))?;

        if !output.status.success() {
            return Err(crate::error::AppError::Internal("截图已取消".into()));
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        return Err(crate::error::AppError::Internal("当前平台暂不支持截图 OCR".into()));
    }

    // 读取截图文件
    let image_data = match std::fs::read(&temp_path) {
        Ok(data) => data,
        Err(e) => {
            let _ = std::fs::remove_file(&temp_path);
            return Err(crate::error::AppError::Internal(format!("读取截图失败: {e}")));
        }
    };

    // 清理临时文件
    let _ = std::fs::remove_file(&temp_path);

    // 执行 OCR
    let request = crate::ocr::types::OcrRequest { image: image_data, languages: None };
    crate::ocr::recognize(request).map_err(|e| e.into())
}

/// 显示 OCR 冻结图浮层
///
/// 在指定位置显示 PNG 格式的图片作为 OCR 冻结图。
/// 浮层会覆盖在全屏 App 上方，且不激活 ReadBrief。
///
/// # Arguments
/// * `image_data` - PNG 格式的图片数据
/// * `x` - 显示位置 x 坐标（逻辑点）
/// * `y` - 显示位置 y 坐标（逻辑点）
/// * `width` - 显示宽度（逻辑点）
/// * `height` - 显示高度（逻辑点）
#[tauri::command]
pub fn show_ocr_overlay(
    image_data: Vec<u8>,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> AppResult<()> {
    crate::ocr::overlay::show_ocr_overlay(&image_data, x, y, width, height)
        .map_err(|e| crate::error::AppError::Internal(e))
}

/// 隐藏 OCR 冻结图浮层
#[tauri::command]
pub fn hide_ocr_overlay() {
    crate::ocr::overlay::hide_ocr_overlay();
}

/// 检查 OCR 浮层是否可见
#[tauri::command]
pub fn is_ocr_overlay_visible() -> bool {
    crate::ocr::overlay::is_ocr_overlay_visible()
}

/// 截图并显示 OCR 冻结图
///
/// 完整流程：截图 → 显示冻结图 → OCR 识别 → 返回文本
/// 冻结图会覆盖在全屏 App 上方，且不激活 ReadBrief。
#[tauri::command]
pub fn screenshot_and_freeze() -> AppResult<crate::ocr::types::OcrResult> {
    #[cfg(target_os = "macos")]
    {
        use crate::screenshot::macos::{capture_current_screen, crop_session};

        // 1. 截取当前屏幕
        let session = capture_current_screen()
            .ok_or_else(|| crate::error::AppError::Internal("截图失败".into()))?;

        // 2. 将截图编码为 PNG
        let png_data = crop_session(&session, 0, 0, session.width, session.height)
            .ok_or_else(|| crate::error::AppError::Internal("截图编码失败".into()))?;

        // 3. 显示冻结图（覆盖全屏）
        crate::ocr::overlay::show_ocr_overlay(
            &png_data,
            session.screen_x,
            session.screen_y,
            session.screen_width,
            session.screen_height,
        )?;

        // 4. 执行 OCR
        let request = crate::ocr::types::OcrRequest {
            image: png_data,
            languages: None,
        };
        crate::ocr::recognize(request).map_err(|e| e.into())
    }

    #[cfg(not(target_os = "macos"))]
    {
        Err(crate::error::AppError::Internal("当前平台暂不支持截图 OCR".into()))
    }
}
