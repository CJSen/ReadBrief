use crate::error::AppResult;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicI32, AtomicU8, Ordering};
use tauri::{Emitter, Manager, WindowEvent};

pub const FLOAT_STATE_IDLE: u8 = 0;
pub const FLOAT_STATE_STREAMING: u8 = 1;
pub const FLOAT_STATE_DONE: u8 = 2;
pub const FLOAT_STATE_ERROR: u8 = 3;

static FLOAT_STATE: AtomicU8 = AtomicU8::new(FLOAT_STATE_IDLE);
static FLOAT_FIXED: AtomicI32 = AtomicI32::new(0);
pub(crate) static FLOAT_VISIBLE: AtomicI32 = AtomicI32::new(0);
/// 浮窗最近一次显示时刻(ms):失焦自动隐藏保护
static LAST_SHOW_MS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
/// 显示后忽略失焦的窗口期(ms),避免激活抖动/焦点竞争导致的误隐藏
const FOCUS_GRACE_MS: u64 = 400;

/// 标记浮窗可见(供 native::show_overlay 调用)
pub fn mark_float_visible() {
    FLOAT_VISIBLE.store(1, Ordering::SeqCst);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    LAST_SHOW_MS.store(now, Ordering::SeqCst);
}

/// 浮窗当前是否可见(供快捷键判断:是否需要触发「新会话」reset)
pub fn is_float_visible() -> bool {
    FLOAT_VISIBLE.load(Ordering::SeqCst) != 0
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FloatStatePayload {
    pub state: u8,
    pub fixed: bool,
}

pub fn set_float_state(app: &tauri::AppHandle, state: u8, fixed: bool) {
    FLOAT_STATE.store(state, Ordering::SeqCst);
    FLOAT_FIXED.store(if fixed { 1 } else { 0 }, Ordering::SeqCst);
    let _ = app.emit(
        "float-state-changed",
        FloatStatePayload {
            state,
            fixed,
        },
    );
}

pub fn get_float_state() -> u8 {
    FLOAT_STATE.load(Ordering::SeqCst)
}

pub fn is_float_fixed() -> bool {
    FLOAT_FIXED.load(Ordering::SeqCst) != 0
}

#[tauri::command]
pub fn float_set_state(app: tauri::AppHandle, state: u8, fixed: bool) -> AppResult<()> {
    set_float_state(&app, state, fixed);
    Ok(())
}

#[tauri::command]
pub fn float_show(app: tauri::AppHandle) -> AppResult<()> {
    show_float(&app);
    Ok(())
}

#[tauri::command]
pub fn float_hide(app: tauri::AppHandle) -> AppResult<()> {
    hide_float(&app);
    Ok(())
}

/// 历史页「重新生成」:写入原文并让浮窗自动总结
#[tauri::command]
pub fn float_regenerate(app: tauri::AppHandle, text: String) -> AppResult<()> {
    if !text.trim().is_empty() {
        crate::shortcuts::dispatch_capture(
            &app,
            crate::shortcuts::CapturedText {
                text,
                source: "history".to_string(),
                prompt_id: None,
                service_id: None,
            },
        );
    }
    show_float(&app);
    Ok(())
}

#[tauri::command]
pub fn float_toggle(app: tauri::AppHandle) -> AppResult<()> {
    if FLOAT_VISIBLE.load(Ordering::SeqCst) == 0 {
        show_float(&app);
    } else {
        hide_float(&app);
    }
    Ok(())
}

#[tauri::command]
pub fn open_settings(app: tauri::AppHandle) -> AppResult<()> {
    if let Some(win) = app.get_webview_window("settings") {
        let _ = win.show();
        let _ = win.set_focus();
    }
    // 每次打开设置都回到「通用」分区,不保留上次停留位置。
    // 定向入口(状态栏「关于ReadBrief」/更新提示)用 open_settings_section 或后置 emit 覆盖。
    let _ = app.emit("navigate-settings", "general");
    Ok(())
}

/// 打开设置窗口并跳转到指定分区(状态栏「关于ReadBrief」等入口使用)。
/// 显示窗口后向前端 emit `navigate-settings` 事件,由 AppSettings 切换到目标 section。
#[tauri::command]
pub fn open_settings_section(app: tauri::AppHandle, section: String) -> AppResult<()> {
    if let Some(win) = app.get_webview_window("settings") {
        let _ = win.show();
        let _ = win.set_focus();
    }
    let _ = app.emit("navigate-settings", section);
    Ok(())
}

/// 打开 macOS 系统设置 → 隐私与安全性 → 指定权限面板。
/// 用于「去授权」后系统原生弹窗不再弹出时(仅弹一次),引导用户到系统设置手动开启。
#[cfg(target_os = "macos")]
#[tauri::command]
pub fn open_privacy_settings(kind: String) -> AppResult<()> {
    use std::process::Command;
    let anchor = match kind.as_str() {
        "screen" => "Privacy_ScreenCapture",
        _ => "Privacy_Accessibility",
    };
    // 现代(macOS 13+)与旧版方案都尝试,命中其一即可
    let schemes = [
        format!("x-apple.systempreferences:com.apple.settings.PrivacySecurity?{anchor}"),
        format!("x-apple.systempreferences:com.apple.preference.security?{anchor}"),
    ];
    for scheme in schemes {
        if Command::new("open")
            .arg(&scheme)
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
        {
            return Ok(());
        }
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn open_privacy_settings(_kind: String) -> AppResult<()> {
    Ok(())
}

#[tauri::command]
pub fn show_main(app: tauri::AppHandle) -> AppResult<()> {
    match app.get_webview_window("main") {
        Some(win) => {
            // 窗口已存在:直接在主线程 show + set_focus。
            // Accessory 应用下从 JS 直接 show 无法激活 App(窗口会停在后台/不显示),
            // 故显示动作必须在 Rust 主线程执行(与浮窗 show_overlay 同一可靠路径)。
            // 此时窗口内容此前已渲染完成,直接显示不会白屏。
            let app2 = app.clone();
            let _ = app.run_on_main_thread(move || {
                let _ = win.show();
                let _ = win.set_focus();
                crate::native::force_webview_repaint(&win);
                // 通知前端「主窗口已显示」,触发一次数据重载(Windows WebView2 首帧不提交的兜底)
                let _ = app2.emit_to("main", "main-shown", ());
            });
        }
        // 窗口已被销毁(关闭「最小化到托盘」后点红叉):重建为 hidden,由前端挂载后 invoke reveal_main_window 显示
        None => {
            if rebuild_main_window(&app).is_ok() {
                // rebuild 出的窗口 visible:false,前端 React 首帧提交后 invoke reveal_main_window,无白屏
            } else {
                log::error!("重建主窗口失败");
            }
        }
    }
    Ok(())
}

/// 前端在 React 首帧提交后调用:真正显示主窗口(主线程 show + set_focus)。
/// 主窗在 tauri.conf.json 设 visible:false 创建,避免 WebView 默认白底先闪现;
/// 待页面渲染完成再由本命令在 Rust 主线程激活显示,用户看到的是已渲染好的页面,既不白屏也不会"打不开"。
/// 关键:macOS Accessory 形态下 window.show() 必须由 Rust 主线程执行才能激活 App,
/// 从 JS 回调直接 show 会被系统忽略(窗口停在后台)。
#[tauri::command]
pub fn reveal_main_window(app: tauri::AppHandle) -> AppResult<()> {
    if let Some(win) = app.get_webview_window("main") {
        let app2 = app.clone();
        let _ = app.run_on_main_thread(move || {
            let _ = win.show();
            let _ = win.set_focus();
            crate::native::force_webview_repaint(&win);
            // 通知前端「主窗口已显示」,触发一次数据重载(Windows WebView2 首帧不提交的兜底)
            let _ = app2.emit_to("main", "main-shown", ());
        });
    }
    Ok(())
}

#[tauri::command]
pub fn hide_main(app: tauri::AppHandle) -> AppResult<()> {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.hide();
    }
    Ok(())
}

pub fn show_float(app: &tauri::AppHandle) {
    // 关键约束(经 tao/wry 源码确认):
    // - tauri 的 set_focus 在 macOS = makeKeyAndOrderFront + activateIgnoringOtherApps → 必然激活应用、切出全屏
    // - AppKit 的 NSWindow 操作必须在主线程(快捷键回调是非主线程,直接调用会被静默忽略)
    // - 显示流程(参考 Bob/Pot):光标位置 → 面板化 → 移动窗口 → orderFrontRegardless → show,全程不激活应用
    #[cfg(target_os = "macos")]
    {
        let app2 = app.clone();
        let _ = app.run_on_main_thread(move || {
            crate::native::show_overlay(&app2);
        });
    }
    #[cfg(not(target_os = "macos"))]
    {
        crate::native::show_overlay(app);
    }
}

pub fn hide_float(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("float") {
        let was_visible = FLOAT_VISIBLE.swap(0, Ordering::SeqCst);
        // 隐藏前先把 alpha 置 0(窗口此时仍可见,setAlphaValue 立即提交到窗口服务)。
        // 确保窗口进入隐藏态时 alpha 属性已是 0 —— 否则下次 show_overlay 的 orderFront
        // 会用旧 alpha=1 在旧位置合成一帧(闪现),alpha=0 才随后提交(用户看到「先闪现再消失」)。
        crate::native::set_float_alpha(&win, 0.0);
        // Windows:移出屏幕外(保持 visible)避免透明 WebView2 重载;其余平台直接 hide。
        crate::native::hide_float_window(&win);
        // 窗口隐藏后通知前端清空 UI 状态(input/capture/output 等)。
        // 必须在 win.hide() 之后 emit:窗口已不可见,前端清空过程用户看不到。
        // 下次 show_overlay 时 WebView 已是空白态,不会闪现上次内容(首次正常、后续闪现的根因)。
        if was_visible != 0 {
            let _ = app.emit("float-hidden", ());
        }
    }
}

/// 拖拽浮窗:用 set_position 移动窗口(等价 hide_float_window 移出屏幕外的同源安全移动,
/// 不会触发透明 WebView2 重载)。前端用 Pointer 事件 + setPointerCapture 跟手拖拽,
/// 替代 OS 原生拖拽(start_dragging / CSS app-region)——后者在 Windows 透明 WebView2
/// + WS_EX_NOACTIVATE 浮窗上会触发 WebView 重载、丢失数据。x/y 为设备像素(前端已乘 scaleFactor)。
#[tauri::command]
pub fn float_drag_move(app: tauri::AppHandle, x: i32, y: i32) -> AppResult<()> {
    if let Some(win) = app.get_webview_window("float") {
        let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
    }
    Ok(())
}

/// 主窗口关闭处理:min_to_tray 开启时隐藏而非退出;关闭时窗口销毁后,show_main 会重建
fn setup_main_close_handler(_app: &tauri::AppHandle, win: &tauri::WebviewWindow) {
    let win_handle = win.clone();
    win.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            let cfg = crate::config::load_config();
            if cfg.min_to_tray {
                api.prevent_close();
                let _ = win_handle.hide();
            }
            // min_to_tray 关闭:允许销毁窗口,由 show_main/tray/Dock 重建
        }
    });
}

/// 重建主窗口(被销毁后,如 min_to_tray 关闭时点红叉)
fn rebuild_main_window(app: &tauri::AppHandle) -> tauri::Result<tauri::WebviewWindow> {
    let win = tauri::WebviewWindowBuilder::new(
        app,
        "main",
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title("ReadBrief")
    .inner_size(960.0, 640.0)
    .min_inner_size(720.0, 480.0)
    .center()
    .resizable(true)
    .visible(false)
    .build()?;
    setup_main_close_handler(app, &win);
    Ok(win)
}

pub fn setup_window_handlers(app: &tauri::AppHandle) {
    // 主窗:点关闭 → 若开启「最小化到托盘」则隐藏而非退出
    if let Some(win) = app.get_webview_window("main") {
        setup_main_close_handler(app, &win);
    }
    // 浮窗:点击关闭 → 隐藏而非销毁;失焦(点击外部)且未固定 + 开启点击外部关闭 → 隐藏
    if let Some(win) = app.get_webview_window("float") {
        // 初始化(主线程)即面板化为系统级浮层:
        // CanJoinAllSpaces | Transient | FullScreenAuxiliary + StatusBar level, 持久生效
        crate::native::make_floating_panel(&win);
        // Windows:安装「点击外部关闭」低级鼠标钩子(WS_EX_NOACTIVATE 下 Focused 不触发)
        crate::native::install_click_outside_hook(app);
        let app_handle = app.clone();
        win.on_window_event(move |event| match event {
            WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                hide_float(&app_handle);
            }
            WindowEvent::Focused(false) => {
                // 显示后短暂窗口期内的失焦忽略(激活/焦点竞争抖动,非用户主动点击外部)
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0);
                if now.saturating_sub(LAST_SHOW_MS.load(Ordering::SeqCst)) < FOCUS_GRACE_MS {
                    return;
                }
                let cfg = crate::config::load_config();
                // 生成中不自动隐藏(设计稿:仅对流式中以外状态生效)
                if cfg.click_outside
                    && !is_float_fixed()
                    && get_float_state() != FLOAT_STATE_STREAMING
                {
                    hide_float(&app_handle);
                }
            }
            _ => {}
        });
    }
    // 设置窗:点击关闭 → 隐藏而非销毁(否则无法再次打开)
    if let Some(win) = app.get_webview_window("settings") {
        let app_handle = app.clone();
        win.on_window_event(move |event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                if let Some(win) = app_handle.get_webview_window("settings") {
                    let _ = win.hide();
                }
            }
        });
    }
}
