use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::Emitter;
use tauri_plugin_global_shortcut::GlobalShortcutExt;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutBinding {
    pub accelerator: String,
    pub action: String,
    pub prompt_id: Option<String>,
    /// 快捷键绑定的模型(与 ShortcutConfig.model 一致)
    #[serde(default)]
    pub model: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapturedText {
    pub text: String,
    pub source: String,
    pub prompt_id: Option<String>,
    /// 触发该次总结的快捷键绑定的模型(模型由快捷键决定,而非提示词)
    #[serde(default)]
    pub model: Option<String>,
}

/// 已注册的快捷键列表(用于热更新前 unregister)
static REGISTERED: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// 划词监听暂停标志(托盘「暂停划词监听」/ 通用设置开关)
static CAPTURE_PAUSED: AtomicBool = AtomicBool::new(false);

/// 浮窗 WebView 是否已就绪(前端 mount 后上报)。
/// 解决「应用刚启动/快捷键触发时浮窗页面尚未加载,事件丢失」的时序问题:
/// 未就绪时把捕获结果缓存到 PENDING_CAPTURE,浮窗 ready 后补发。
static FLOAT_READY: AtomicBool = AtomicBool::new(false);
static PENDING_CAPTURE: Mutex<Option<CapturedText>> = Mutex::new(None);

pub fn is_capture_paused() -> bool {
    CAPTURE_PAUSED.load(Ordering::SeqCst)
}

pub fn set_capture_paused(paused: bool) {
    CAPTURE_PAUSED.store(paused, Ordering::SeqCst);
}

/// 浮窗前端加载完成时调用:标记就绪并补发缓存的捕获结果
#[tauri::command]
pub fn float_mark_ready(app: tauri::AppHandle) -> AppResult<()> {
    FLOAT_READY.store(true, Ordering::SeqCst);
    if let Ok(mut pending) = PENDING_CAPTURE.lock() {
        if let Some(cap) = pending.take() {
            let _ = app.emit("capture-result", cap);
        }
    }
    Ok(())
}

/// 派发捕获结果:浮窗就绪直接 emit,否则缓存待补发。
/// 空捕获(无选中文本)不上报 —— 浮窗弹出后 ReadBrief 自身成为前台应用,
/// 若快捷键再次触发,AX 读到的是浮窗自身(必然为空),上报会清空输入区已有内容。
pub fn dispatch_capture(app: &tauri::AppHandle, captured: CapturedText) {
    if captured.text.trim().is_empty() {
        return;
    }
    if FLOAT_READY.load(Ordering::SeqCst) {
        let _ = app.emit("capture-result", captured);
    } else if let Ok(mut pending) = PENDING_CAPTURE.lock() {
        *pending = Some(captured);
    }
}

/// 启动时按 config.json 注册全局快捷键。
/// 划词总结的默认绑定(⌘+Shift+Z)以 config 中的默认项存在,用户可在设置页修改/删除,
/// 不再由后端无条件「注入」一个隐藏且无法修改的全局快捷键。
pub fn register_default_shortcut(app: &tauri::AppHandle) -> AppResult<()> {
    reload_shortcuts(app)
}

/// 从 config.json 读取快捷键并全量重注册(热更新)。
/// 只注册 config 中显式绑定(accelerator 非空)的快捷键;
/// 默认绑定(划词总结 = ⌘+Shift+Z)以 config 默认项的形式存在,用户可在设置页修改/删除。
/// 若用户清空了所有快捷键,则不再注册任何全局快捷键(不再无条件注入隐藏热键)。
pub fn reload_shortcuts(app: &tauri::AppHandle) -> AppResult<()> {
    // 1. 注销旧的
    let mut registered = REGISTERED.lock().map_err(|e| AppError::from(e.to_string()))?;
    for accel in registered.iter() {
        let _ = app.global_shortcut().unregister(accel.as_str());
    }
    registered.clear();

    // 2. 读取配置:只取显式绑定的快捷键(accelerator 非空)
    let cfg = crate::config::load_config();
    let bindings: Vec<(String, String, Option<String>, Option<String>)> = cfg
        .shortcuts
        .iter()
        .filter(|s| !s.accelerator.is_empty())
        .map(|s| {
            (
                s.accelerator.clone(),
                s.action.clone(),
                s.prompt_id.clone(),
                s.model.clone(),
            )
        })
        .collect();

    // 3. 注册(非法快捷键跳过并打印警告，不阻塞应用启动)
    for (accelerator, action, prompt_id, model) in bindings {
        let action_c = action.clone();
        let prompt_id_c = prompt_id.clone();
        let model_c = model.clone();
        match app.global_shortcut().on_shortcut(accelerator.as_str(), move |app, _shortcut, event| {
            // 插件对「按下 + 抬起」各回调一次(global-hotkey HotKeyState),
            // 只响应按下 —— 否则 capture/show_overlay/emit 全流程执行两遍,
            // 第二次 show_overlay 的 alpha=0→1 让浮窗「闪现 → 消失 → 再现」。
            if event.state != tauri_plugin_global_shortcut::ShortcutState::Pressed {
                return;
            }
            handle_trigger(app.clone(), action_c.clone(), prompt_id_c.clone(), model_c.clone());
        }) {
            Ok(()) => registered.push(accelerator),
            Err(e) => {
                log::warn!("跳过非法快捷键「{accelerator}」: {e}");
            }
        }
    }
    Ok(())
}

fn handle_trigger(app: tauri::AppHandle, action: String, prompt_id: Option<String>, model: Option<String>) {
    match action.as_str() {
        // 划词总结 / 呼出输入框:通过 Accessibility 捕获选中文本(纯 AX,暂不回退剪贴板)
        "summarize" | "paste" => {
            if is_capture_paused() && action == "summarize" {
                return;
            }
            // 只在面板从隐藏→显示时发 float-shown(触发前端 resetSession 新会话)。
            // 面板已显示时(如总结进行中用户误按全局快捷键)不 reset,避免丢失正在进行的会话数据;
            // 新捕获仍会经 dispatch_capture 更新输入并重新总结。
            let was_visible = crate::windows::is_float_visible();
            // 预捕获鼠标位置:在 capture_selection(耗时 AX 读取)之前采集,
            // 避免到 show_overlay 主线程执行时鼠标已移动 → 浮窗跟随鼠标。
            crate::native::stash_cursor_position();
            let captured = capture_selection(app.clone());
            crate::windows::show_float(&app);
            if !was_visible {
                let _ = app.emit("float-shown", ());
            }
            dispatch_capture(&app, captured);
        }
        "toggle-float" => {
            crate::windows::show_float(&app);
            let _ = app.emit("toggle-float-window", ());
        }
        // 绑定到具体提示词:携带 promptId 触发
        _ if !action.is_empty() => {
            if is_capture_paused() {
                return;
            }
            let was_visible = crate::windows::is_float_visible();
            crate::native::stash_cursor_position();
            let captured = capture_selection(app.clone());
            let mut with_prompt = captured;
            with_prompt.prompt_id = prompt_id;
            with_prompt.model = model;
            crate::windows::show_float(&app);
            if !was_visible {
                let _ = app.emit("float-shown", ());
            }
            dispatch_capture(&app, with_prompt);
        }
        _ => {
            // 未知 action:显式告警而非静默吞噬,便于排查配置错误
            log::warn!("忽略未知 action: {action}");
        }
    }
}

/// 划词捕获:仅走 macOS Accessibility(AX),读取失败返回空文本,不自动回退剪贴板。
/// 暂时搁置剪贴板方案,对齐 pot-desktop 的「快捷键 → AX 读取选中文本」路径。
/// source 语义: selection=捕获成功 / empty=无选中文本 / unauthorized=未授权辅助功能
fn capture_selection(app: tauri::AppHandle) -> CapturedText {
    #[cfg(target_os = "macos")]
    {
        let _ = &app;
        // 先检查授权:未授权时前端引导去系统设置开启辅助功能,而非静默空白
        if !accessibility_trusted() {
            return CapturedText {
                text: String::new(),
                source: "unauthorized".to_string(),
                prompt_id: None,
                model: None,
            };
        }
        let text = read_selection_text().unwrap_or_default();
        if !text.trim().is_empty() {
            return CapturedText {
                text,
                source: "selection".to_string(),
                prompt_id: None,
                model: None,
            };
        }
        // 无选中文本:输入区留空,由用户手动粘贴或输入
        CapturedText {
            text: String::new(),
            source: "empty".to_string(),
            prompt_id: None,
            model: None,
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        CapturedText {
            text: String::new(),
            source: "empty".to_string(),
            prompt_id: None,
            model: None,
        }
    }
}

/// 读取前台应用选中文本 —— pot-desktop 同款方案:
/// `selection::get_text()` = AX 读取优先,失败时 AppleScript 模拟 ⌘C 复制(自动保存/恢复剪贴板)兜底。
/// 相比纯 AX 在 Safari 等应用中读取更可靠。
#[cfg(target_os = "macos")]
fn read_selection_text() -> Option<String> {
    if !accessibility_trusted() {
        return None;
    }
    let text = selection::get_text();
    if text.trim().is_empty() {
        return None;
    }
    Some(text)
}

#[cfg(target_os = "macos")]
fn accessibility_trusted() -> bool {
    unsafe extern "C" {
        fn AXIsProcessTrusted() -> bool;
    }
    unsafe { AXIsProcessTrusted() }
}

#[cfg(target_os = "macos")]
fn prompt_accessibility() {
    use core_foundation::base::{CFTypeRef, TCFType};
    use core_foundation::dictionary::CFDictionary;
    use core_foundation::string::CFString;

    unsafe extern "C" {
        fn AXIsProcessTrustedWithOptions(options: CFTypeRef) -> bool;
    }
    let key = CFString::new("AXTrustedCheckOptionPrompt");
    let val = CFString::new("1");
    let dict = CFDictionary::from_CFType_pairs(&[(key.as_CFType(), val.as_CFType())]);
    unsafe {
        AXIsProcessTrustedWithOptions(dict.as_concrete_TypeRef() as CFTypeRef);
    }
}

#[cfg(not(target_os = "macos"))]
fn read_selection_text() -> Option<String> {
    None
}

/// 读剪贴板(托盘「粘贴并总结」等显式动作使用;划词捕获暂不走此路径)
fn read_clipboard(app: &tauri::AppHandle) -> String {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    app.clipboard().read_text().unwrap_or_default()
}

/// 当前生效的快捷键绑定列表(供前端设置页展示)。
/// 直接返回 config 中已绑定的快捷键,不再回退注入隐藏的默认 ⌘+Shift+Z。
#[tauri::command]
pub fn shortcut_get_bindings() -> AppResult<Vec<ShortcutBinding>> {
    let cfg = crate::config::load_config();
    let bindings: Vec<ShortcutBinding> = cfg
        .shortcuts
        .iter()
        .map(|s| ShortcutBinding {
            accelerator: s.accelerator.clone(),
            action: s.action.clone(),
            prompt_id: s.prompt_id.clone(),
            model: s.model.clone(),
        })
        .collect();
    Ok(bindings)
}

#[tauri::command]
pub fn capture_read(app: tauri::AppHandle) -> AppResult<CapturedText> {
    Ok(capture_selection(app))
}

#[tauri::command]
pub fn clipboard_read_text(app: tauri::AppHandle) -> AppResult<String> {
    Ok(read_clipboard(&app))
}

#[tauri::command]
pub fn clipboard_write_text(app: tauri::AppHandle, text: String) -> AppResult<()> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    app.clipboard()
        .write_text(text)
        .map_err(|e| AppError::from(e.to_string()))
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub fn accessibility_status() -> AppResult<bool> {
    Ok(accessibility_trusted())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn accessibility_status() -> AppResult<bool> {
    Ok(true)
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub fn request_accessibility() -> AppResult<bool> {
    prompt_accessibility();
    Ok(true)
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn request_accessibility() -> AppResult<bool> {
    Ok(true)
}
