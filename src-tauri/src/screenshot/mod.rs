pub mod types;

#[cfg(target_os = "macos")]
pub mod macos;

use crate::error::{AppError, AppResult};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{Emitter, Manager};
use types::{ScreenshotInfo, ScreenshotSession, SelectionRect};

/// 当前截图会话（进程级单例）
static SESSION: Mutex<Option<ScreenshotSession>> = Mutex::new(None);

/// 截图会话是否已取消
static CANCELLED: AtomicBool = AtomicBool::new(false);

/// 前端图片是否已加载完成
static OVERLAY_READY: Mutex<Option<tokio::sync::oneshot::Sender<()>>> = Mutex::new(None);

/// 前端首帧是否已真正合成到屏幕(双 rAF 后上报)。
/// 与 OVERLAY_READY 区别:onLoad 只代表图片解码完成,不代表该帧已提交到屏幕,
/// 两者之间窗口可能露出背景 → 用 alpha 门控+此信号消除(极快白闪)。
static OVERLAY_PAINTED: Mutex<Option<std::sync::mpsc::Sender<()>>> = Mutex::new(None);

/// 检查屏幕录制权限
#[cfg(target_os = "macos")]
pub fn screen_capture_trusted() -> bool {
    unsafe extern "C" {
        fn CGPreflightScreenCaptureAccess() -> bool;
    }
    unsafe { CGPreflightScreenCaptureAccess() }
}

#[cfg(not(target_os = "macos"))]
pub fn screen_capture_trusted() -> bool {
    true
}

/// 请求屏幕录制权限
#[cfg(target_os = "macos")]
pub fn request_screen_capture() {
    unsafe extern "C" {
        fn CGRequestScreenCaptureAccess() -> bool;
    }
    unsafe {
        CGRequestScreenCaptureAccess();
    }
}

#[cfg(not(target_os = "macos"))]
pub fn request_screen_capture() {}

/// 开始截图捕获：截取当前屏幕，创建 overlay 窗口
#[tauri::command]
pub async fn start_screenshot_capture(app: tauri::AppHandle) -> AppResult<()> {
    // 重置状态
    CANCELLED.store(false, Ordering::SeqCst);

    // 检查屏幕录制权限
    if !screen_capture_trusted() {
        log::warn!("截图 OCR 失败: 未授权屏幕录制权限");
        crate::windows::show_float(&app);
        let _ = app.emit("float-shown", ());
        crate::shortcuts::dispatch_capture(
            &app,
            crate::shortcuts::CapturedText {
                text: String::new(),
                source: "screenshot-ocr-unauthorized".to_string(),
                prompt_id: None,
                service_id: None,
            },
        );
        return Err(AppError::Internal("未授权屏幕录制权限".into()));
    }

    // 截取当前屏幕
    #[cfg(target_os = "macos")]
    let session = macos::capture_current_screen()
        .ok_or_else(|| AppError::Internal("截图失败".into()))?;

    #[cfg(not(target_os = "macos"))]
    {
        return Err(AppError::Internal("当前平台暂不支持截图 OCR".into()));
    }

    // 检查是否已取消
    if CANCELLED.load(Ordering::SeqCst) {
        log::info!("截图已取消（capture 后）");
        return Err(AppError::Internal("截图已取消".into()));
    }

    // 存入会话
    let info = ScreenshotInfo {
        image_base64: base64_encode(&session.png_bytes),
        screen_width: session.screen_width,
        screen_height: session.screen_height,
        scale_factor: session.scale_factor,
    };
    // 被截显示器的全局原点(CG 逻辑坐标):overlay 窗口必须定位到该显示器,
    // 多显示器下若固定 (0,0) 会把外接屏的冻结图盖到主屏上(用户感知为「闪一下」),
    // 且选区坐标 → 像素坐标的换算也会全错。
    let (screen_x, screen_y) = (session.screen_x, session.screen_y);

    {
        let mut guard = SESSION.lock().map_err(|e| AppError::from(e.to_string()))?;
        *guard = Some(session);
    }

    // 创建 oneshot channel 等待前端图片加载完成
    let (tx, rx) = tokio::sync::oneshot::channel::<()>();
    {
        let mut guard = OVERLAY_READY.lock().map_err(|e| AppError::from(e.to_string()))?;
        *guard = Some(tx);
    }

    // 通知前端准备图片（但还不显示窗口）
    let _ = app.emit("ocr-overlay-show", &info);

    // 等待前端图片加载完成或超时
    let screen_width = info.screen_width;
    let screen_height = info.screen_height;

    tokio::select! {
        result = rx => {
            if result.is_ok() && !CANCELLED.load(Ordering::SeqCst) {
                // 前端图片已加载，显示窗口
                let app_clone = app.clone();
                app.run_on_main_thread(move || {
                    show_overlay_fullscreen(&app_clone, screen_x, screen_y, screen_width, screen_height);
                }).map_err(|e| AppError::from(e.to_string()))?;
            }
        }
        _ = tokio::time::sleep(tokio::time::Duration::from_millis(1200)) => {
            // 超时，直接显示窗口(前端已用 img onLoad 门控遮罩,超时显示也不会暗闪)
            if !CANCELLED.load(Ordering::SeqCst) {
                let app_clone = app.clone();
                app.run_on_main_thread(move || {
                    show_overlay_fullscreen(&app_clone, screen_x, screen_y, screen_width, screen_height);
                }).map_err(|e| AppError::from(e.to_string()))?;
            }
        }
    }

    log::info!("截图捕获完成: {}x{} scale={}", info.screen_width, info.screen_height, info.scale_factor);
    Ok(())
}

/// 显示 overlay 窗口（全屏覆盖，支持全屏应用）
///
/// 关键点（参考 native.rs 的 make_floating_panel）：
/// 1. 使用 NSPanel + NonactivatingPanel：不激活应用
/// 2. collectionBehavior = CanJoinAllSpaces | FullScreenAuxiliary：跨 Space + 全屏辅助
/// 3. 使用 orderFront（非 makeKeyAndOrderFront）：不激活应用
/// 4. 使用 makeKeyWindow：让窗口成为 key window 以接收键盘事件（不激活应用）
#[cfg(target_os = "macos")]
fn show_overlay_fullscreen(app: &tauri::AppHandle, screen_x: f64, screen_y: f64, screen_width: f64, screen_height: f64) {
    use objc2::rc::Retained;
    use objc2::ffi::object_setClass;
    use objc2::runtime::AnyObject;
    use objc2_app_kit::{
        NSPanel, NSColor, NSWindow, NSWindowCollectionBehavior, NSWindowStyleMask,
        NSModalPanelWindowLevel,
    };

    let Some(win) = app.get_webview_window("overlay") else {
        return;
    };

    // 首帧防闪信道:前端确认冻结图已真正合成到屏幕后(双 rAF)上报,
    // 在此之前窗口以 alpha=0 显示(用户不可见)。
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    {
        let mut guard = OVERLAY_PAINTED.lock().unwrap_or_else(|e| e.into_inner());
        *guard = Some(tx);
    }

    // 设置窗口尺寸为屏幕大小,并定位到**被截取的显示器**(而非固定主屏原点)。
    // screen_x/screen_y 为 CGDisplayBounds 的全局逻辑坐标(左上原点),与 tao 坐标系一致。
    let _ = win.set_size(tauri::Size::Logical(tauri::LogicalSize::new(
        screen_width,
        screen_height,
    )));
    let _ = win.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(
        screen_x, screen_y,
    )));

    // 获取 NSWindow 并转换为 NSPanel
    if let Ok(ns_window_ptr) = win.ns_window() {
        if !ns_window_ptr.is_null() {
            unsafe {
                let ns_window = Retained::retain(ns_window_ptr as *mut AnyObject)
                    .and_then(|any| any.downcast::<NSWindow>().ok());

                if let Some(ns_window) = ns_window {
                    // 1. 转换为 ReadBriefPanel(NSPanel 子类,与浮窗 make_floating_panel 同款)。
                    //    不能用裸 NSPanel:borderless(无 Titled mask)下 canBecomeKeyWindow
                    //    默认返回 NO,makeKeyWindow() 被静默忽略 → WebView 收不到键盘事件
                    //    (Esc 失效)。子类重写为 YES,详见 native.rs。
                    let panel_cls = crate::native::ensure_panel_class();
                    let raw = Retained::as_ptr(&ns_window) as *mut AnyObject;
                    object_setClass(raw, panel_cls);

                    // downcast 为 NSPanel
                    let ns_panel = ns_window.downcast::<NSPanel>().expect("NSWindow → NSPanel failed");

                    // 2. 添加 NonactivatingPanel 样式（不激活应用）
                    let mut mask = ns_panel.styleMask();
                    mask.insert(NSWindowStyleMask::NonactivatingPanel);
                    ns_panel.setStyleMask(mask);

                    // 3. 设置集合行为：跨 Space + 全屏辅助
                    let mut behavior = ns_panel.collectionBehavior();
                    behavior.insert(NSWindowCollectionBehavior::CanJoinAllSpaces);
                    behavior.insert(NSWindowCollectionBehavior::FullScreenAuxiliary);
                    ns_panel.setCollectionBehavior(behavior);

                    // 4. 设置窗口层级：NSModalPanelWindowLevel (8)
                    //    全屏穿透由 CanJoinAllSpaces + FullScreenAuxiliary 保证，不依赖高 level
                    ns_panel.setLevel(NSModalPanelWindowLevel);

                    // 5. 失焦不自动隐藏
                    ns_panel.setHidesOnDeactivate(false);

                    // 6. 允许成为 key window（重要！接收键盘事件必需）
                    ns_panel.setBecomesKeyOnlyIfNeeded(false);
                    // 模态面板层级下仍可响应(与浮窗一致)
                    ns_panel.setWorksWhenModal(true);

                    // 7. 背景色必须是 clearColor —— 参考 Easydict 的
                    //    `window.backgroundColor = .clear`:
                    //    传 None/nil 会重置为系统默认 windowBackgroundColor(浅色模式下白色),
                    //    orderFront 后 WebView 首帧提交前会露出整屏白底(极快白闪根因)。
                    ns_panel.setBackgroundColor(Some(&NSColor::clearColor()));
                    ns_panel.setOpaque(false);

                    // 7.5 防闪:先以 alpha=0 显示,窗口合成但用户不可见,
                    //     直到前端上报首帧已绘制(或 250ms 兜底)才恢复 1.0。
                    //     这样 orderFront 与 WebView 首帧之间的任何空白/背景都不可见。
                    ns_panel.setAlphaValue(0.0);

                    // 8. 显示窗口（关键：使用 orderFront，不使用 makeKeyAndOrderFront）
                    //    orderFront 不激活应用，makeKeyAndOrderFront 会激活应用
                    ns_panel.orderFront(None);

                    // 9. 让窗口成为 key window（接收键盘事件，如 ESC）
                    //    makeKeyWindow 不激活应用，只是让窗口成为 key window
                    //    这样前端的 keydown 事件监听器才能接收到 ESC
                    ns_panel.makeKeyWindow();

                    // 10. 恢复 WKWebView 为 first responder:setStyleMask/类转换会重置它,
                    //     不恢复则键盘事件到不了前端 keydown(与浮窗同款坑)
                    crate::native::make_webview_first_responder(&win);
                }
            }
        }
    }

    // 11. 临时注册全局 Esc 快捷键取消截图(不依赖 WebView 焦点,pot-desktop 同款兜底)
    crate::shortcuts::register_overlay_esc(app);

    // 12. 等首帧绘制信号(或 250ms 兜底)后把 alpha 恢复为 1.0。
    //     必须在独立线程等:主线程此刻正处理显示流程,阻塞会卡住事件循环。
    let app3 = app.clone();
    std::thread::spawn(move || {
        let _ = rx.recv_timeout(std::time::Duration::from_millis(250));
        let app4 = app3.clone();
        let _ = app3.run_on_main_thread(move || {
            if let Some(w) = app4.get_webview_window("overlay") {
                crate::native::set_float_alpha(&w, 1.0);
            }
        });
    });
}

/// 显示 overlay 窗口（非 macOS 平台）
#[cfg(not(target_os = "macos"))]
fn show_overlay_fullscreen(app: &tauri::AppHandle, screen_x: f64, screen_y: f64, screen_width: f64, screen_height: f64) {
    let Some(win) = app.get_webview_window("overlay") else {
        return;
    };

    let _ = win.set_size(tauri::Size::Logical(tauri::LogicalSize::new(
        screen_width,
        screen_height,
    )));
    let _ = win.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(
        screen_x, screen_y,
    )));
    let _ = win.show();
    let _ = win.set_focus();
    // 临时注册全局 Esc 快捷键取消截图(与 macOS 行为一致)
    crate::shortcuts::register_overlay_esc(app);
}

/// 前端通知图片已加载完成，可以显示 overlay 窗口
#[tauri::command]
pub fn notify_overlay_ready() -> AppResult<()> {
    let mut guard = OVERLAY_READY.lock().map_err(|e| AppError::from(e.to_string()))?;
    if let Some(tx) = guard.take() {
        let _ = tx.send(());
    }
    Ok(())
}

/// 前端通知首帧已绘制（冻结图已真正上屏），可以恢复窗口 alpha=1
#[tauri::command]
pub fn notify_overlay_painted() -> AppResult<()> {
    let mut guard = OVERLAY_PAINTED.lock().map_err(|e| AppError::from(e.to_string()))?;
    if let Some(tx) = guard.take() {
        let _ = tx.send(());
    }
    Ok(())
}

/// 完成截图选区：裁剪 + OCR
#[tauri::command]
pub fn finish_screenshot_selection(
    app: tauri::AppHandle,
    rect: SelectionRect,
) -> AppResult<crate::ocr::types::OcrResult> {
    // 检查是否已取消
    if CANCELLED.load(Ordering::SeqCst) {
        return Err(AppError::Internal("截图已取消".into()));
    }

    // 取出会话
    let session = {
        let mut guard = SESSION.lock().map_err(|e| AppError::from(e.to_string()))?;
        guard.take()
    };

    let Some(session) = session else {
        return Err(AppError::Internal("无截图会话".into()));
    };

    // 再次检查是否已取消
    if CANCELLED.load(Ordering::SeqCst) {
        return Err(AppError::Internal("截图已取消".into()));
    }

    // 通知前端清空图片（避免下次闪旧图）
    let _ = app.emit("ocr-overlay-hide", ());

    // 选区已完成,注销临时 Esc 快捷键(此后 overlay 隐藏,错误路径下用户仍可 Esc 兜底)
    crate::shortcuts::unregister_overlay_esc(&app);

    // 在主线程隐藏 overlay
    let app2 = app.clone();
    app.run_on_main_thread(move || {
        if let Some(win) = app2.get_webview_window("overlay") {
            let _ = win.hide();
        }
    })
    .map_err(|e| AppError::from(e.to_string()))?;

    // CSS 坐标 → 像素坐标
    let scale = session.scale_factor;
    let pixel_x = (rect.x * scale).round() as u32;
    let pixel_y = (rect.y * scale).round() as u32;
    let pixel_w = (rect.width * scale).round() as u32;
    let pixel_h = (rect.height * scale).round() as u32;

    // 边界检查
    let pixel_x = pixel_x.min(session.width.saturating_sub(1));
    let pixel_y = pixel_y.min(session.height.saturating_sub(1));
    let pixel_w = pixel_w.min(session.width - pixel_x);
    let pixel_h = pixel_h.min(session.height - pixel_y);

    if pixel_w < 2 || pixel_h < 2 {
        return Err(AppError::Invalid("选区太小".into()));
    }

    // 裁剪
    let cropped_png = macos::crop_session(&session, pixel_x, pixel_y, pixel_w, pixel_h)
        .ok_or_else(|| AppError::Internal("裁剪失败".into()))?;

    // OCR 前再次检查是否已取消
    if CANCELLED.load(Ordering::SeqCst) {
        return Err(AppError::Internal("截图已取消".into()));
    }

    // OCR
    let request = crate::ocr::types::OcrRequest {
        image: cropped_png,
        languages: None,
    };
    let result = crate::ocr::recognize(request)?;

    // OCR 完成后再次检查是否已取消
    if CANCELLED.load(Ordering::SeqCst) {
        return Err(AppError::Internal("截图已取消".into()));
    }

    log::info!("截图 OCR 完成: len={}", result.text.chars().count());
    Ok(result)
}

/// 取消截图捕获
#[tauri::command]
pub fn cancel_screenshot_capture(app: tauri::AppHandle) -> AppResult<()> {
    // 标记为已取消（最先执行，确保后续流程能检查到）
    CANCELLED.store(true, Ordering::SeqCst);

    // 注销临时 Esc 快捷键(幂等;Esc 全局热键触发本函数时也走这里)
    crate::shortcuts::unregister_overlay_esc(&app);

    // 清理会话
    {
        let mut guard = SESSION.lock().map_err(|e| AppError::from(e.to_string()))?;
        *guard = None;
    }

    // 清理 overlay_ready / painted channel（避免阻塞 / 悬空信号）
    {
        let mut guard = OVERLAY_READY.lock().map_err(|e| AppError::from(e.to_string()))?;
        *guard = None;
    }
    {
        let mut guard = OVERLAY_PAINTED.lock().map_err(|e| AppError::from(e.to_string()))?;
        *guard = None;
    }

    // 通知前端清空图片
    let _ = app.emit("ocr-overlay-hide", ());

    // 在主线程隐藏 overlay
    let app2 = app.clone();
    app.run_on_main_thread(move || {
        if let Some(win) = app2.get_webview_window("overlay") {
            let _ = win.hide();
        }
    })
    .map_err(|e| AppError::from(e.to_string()))?;

    log::info!("截图捕获已取消");
    Ok(())
}

/// 获取当前截图的 base64 编码（供 overlay 显示）
#[tauri::command]
pub fn get_screenshot_image() -> AppResult<ScreenshotInfo> {
    let guard = SESSION.lock().map_err(|e| AppError::from(e.to_string()))?;
    let session = guard.as_ref().ok_or_else(|| AppError::Internal("无截图会话".into()))?;

    Ok(ScreenshotInfo {
        image_base64: base64_encode(&session.png_bytes),
        screen_width: session.screen_width,
        screen_height: session.screen_height,
        scale_factor: session.scale_factor,
    })
}

/// 派发 OCR 结果到浮窗（供 overlay 前端调用）
#[tauri::command]
pub fn dispatch_ocr_result(app: tauri::AppHandle, text: String) -> AppResult<()> {
    // 取出暂存的 prompt_id 和 service_id
    let (prompt_id, service_id) = {
        let mut guard = crate::shortcuts::PENDING_OCR_PROMPT
            .lock()
            .map_err(|e| AppError::from(e.to_string()))?;
        guard.take().unwrap_or((None, None))
    };

    // 显示浮窗
    let was_visible = crate::windows::is_float_visible();
    crate::native::stash_cursor_position();
    crate::windows::show_float(&app);
    if !was_visible {
        let _ = app.emit("float-shown", ());
    }

    // 派发 OCR 结果
    if !text.trim().is_empty() {
        crate::shortcuts::dispatch_capture(
            &app,
            crate::shortcuts::CapturedText {
                text,
                source: "screenshot-ocr".to_string(),
                prompt_id,
                service_id,
            },
        );
    } else {
        crate::shortcuts::dispatch_capture(
            &app,
            crate::shortcuts::CapturedText {
                text: String::new(),
                source: "screenshot-ocr-empty".to_string(),
                prompt_id,
                service_id,
            },
        );
    }

    Ok(())
}

/// base64 编码
fn base64_encode(data: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(data)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_session_lifecycle() {
        let mut guard = SESSION.lock().unwrap();
        assert!(guard.is_none());

        *guard = Some(ScreenshotSession {
            png_bytes: vec![1, 2, 3],
            pixel_data: vec![4, 5, 6],
            width: 100,
            height: 100,
            bytes_per_row: 400,
            scale_factor: 2.0,
            screen_x: 0.0,
            screen_y: 0.0,
            screen_width: 100.0,
            screen_height: 100.0,
            display_id: 1,
        });
        assert!(guard.is_some());

        *guard = None;
        assert!(guard.is_none());
    }
}
