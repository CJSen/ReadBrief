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
    /// 快捷键绑定的 AI 服务 id(引用式,与 ShortcutConfig.service_id 一致)
    #[serde(default)]
    pub service_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapturedText {
    pub text: String,
    pub source: String,
    pub prompt_id: Option<String>,
    /// 触发该次总结的快捷键绑定的 AI 服务 id(服务由快捷键决定,模型从服务解析)
    #[serde(default)]
    pub service_id: Option<String>,
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

/// 截图 OCR 流程中暂存的 prompt_id 和 service_id（供 overlay 选区完成后使用）
pub(crate) static PENDING_OCR_PROMPT: Mutex<Option<(Option<String>, Option<String>)>> = Mutex::new(None);

/// overlay(截图框选层)显示期间是否已临时注册 Esc 全局快捷键
static OVERLAY_ESC_REGISTERED: AtomicBool = AtomicBool::new(false);

/// overlay 显示期间临时注册 Esc = 全局取消截图。
/// 不依赖 WebView 键盘焦点 —— 应用未激活 / firstResponder 丢失时前端 keydown 不可靠,
/// 参考 pot-desktop:框选期间用全局热键处理 Esc,且热键会吞掉该按键不传给前台应用。
/// 由 show_overlay_fullscreen 注册,cancel/finish 时注销。
///
/// ⚠️ 回调内严禁同步调用 cancel_screenshot_capture:该函数经 unregister_overlay_esc →
/// 插件 unregister() 内部 `shortcuts.lock()`,而插件的事件分发闭包此刻正持有同一把
/// 不可重入 Mutex 调用本回调 → 重入死锁,主线程在 Carbon 热键回调里永久卡死
/// (表现:按 Esc 后应用整体冻结,只能杀进程)。必须丢到独立线程异步执行。
pub fn register_overlay_esc(app: &tauri::AppHandle) {
    if OVERLAY_ESC_REGISTERED.swap(true, Ordering::SeqCst) {
        return;
    }
    if let Err(e) = app.global_shortcut().on_shortcut("Escape", |app, _shortcut, event| {
        if event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed {
            let app2 = app.clone();
            std::thread::spawn(move || {
                let _ = crate::screenshot::cancel_screenshot_capture(app2);
            });
        }
    }) {
        OVERLAY_ESC_REGISTERED.store(false, Ordering::SeqCst);
        log::warn!("注册 Esc 取消截图快捷键失败: {e}");
    }
}

/// overlay 隐藏/选区完成时注销临时 Esc 快捷键(幂等)
pub fn unregister_overlay_esc(app: &tauri::AppHandle) {
    if !OVERLAY_ESC_REGISTERED.swap(false, Ordering::SeqCst) {
        return;
    }
    if let Err(e) = app.global_shortcut().unregister("Escape") {
        log::warn!("注销 Esc 取消截图快捷键失败: {e}");
    }
}

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
            log::debug!("浮窗就绪,补发缓存的捕获结果");
            let _ = app.emit("capture-result", cap);
        }
    }
    Ok(())
}

/// 派发捕获结果:浮窗就绪直接 emit,否则缓存待补发。
/// 空捕获(无选中文本)不上报 —— 浮窗弹出后 ReadBrief 自身成为前台应用,
/// 若快捷键再次触发,AX 读到的是浮窗自身(必然为空),上报会清空输入区已有内容。
pub fn dispatch_capture(app: &tauri::AppHandle, captured: CapturedText) {
    // 注意:空文本(unauthorized/empty)也要上报。前端依据 source 展示「未授权辅助功能」引导或
    // 「未捕获到选中文本」提示;且前端已对空文本跳过 setInput/run(不会清空已有输入)。
    // 若在此处提前 return,unauthorized 事件丢失:浮窗既无授权引导,标题又回退成「要点总结」,
    // 与授权后行为不一致。
    if FLOAT_READY.load(Ordering::SeqCst) {
        log::debug!("捕获结果派发到浮窗");
        let _ = app.emit("capture-result", captured);
    } else if let Ok(mut pending) = PENDING_CAPTURE.lock() {
        log::debug!("浮窗未就绪,捕获结果缓存待补发");
        *pending = Some(captured);
    }
}

/// 启动时按 config.json 注册全局快捷键。
/// 划词总结的默认绑定(⌘+Shift+Z)以 config 中的默认项存在,用户可在设置页修改/删除,
/// 不再由后端无条件「注入」一个隐藏且无法修改的全局快捷键。
pub fn register_default_shortcut(app: &tauri::AppHandle) -> AppResult<()> {
    reload_shortcuts(app)
}

/// 应用级固定快捷键:⌘, / Ctrl+, 打开设置页(macOS 系统惯例)。
/// 与 config 驱动的快捷键(reload_shortcuts)分开管理:不进设置页快捷键列表、不可被增删改。
pub fn register_open_settings_shortcut(app: &tauri::AppHandle) -> AppResult<()> {
    #[cfg(target_os = "macos")]
    let accel = "Cmd+,";
    #[cfg(not(target_os = "macos"))]
    let accel = "Ctrl+,";

    match app.global_shortcut().on_shortcut(accel, move |app, _shortcut, event| {
        if event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed {
            let _ = crate::windows::open_settings(app.clone());
        }
    }) {
        Ok(()) => {}
        // 注册失败不阻塞启动(如被系统其它 App 占用),仅告警
        Err(e) => log::warn!("注册「{accel}」打开设置快捷键失败: {e}"),
    }
    Ok(())
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
                s.service_id.clone(),
            )
        })
        .collect();

    // 3. 注册(非法快捷键跳过并打印警告，不阻塞应用启动)
    for (accelerator, action, prompt_id, service_id) in bindings {
        let action_c = action.clone();
        let prompt_id_c = prompt_id.clone();
        let service_id_c = service_id.clone();
        match app.global_shortcut().on_shortcut(accelerator.as_str(), move |app, _shortcut, event| {
            // 插件对「按下 + 抬起」各回调一次(global-hotkey HotKeyState),
            // 只响应按下 —— 否则 capture/show_overlay/emit 全流程执行两遍,
            // 第二次 show_overlay 的 alpha=0→1 让浮窗「闪现 → 消失 → 再现」。
            if event.state != tauri_plugin_global_shortcut::ShortcutState::Pressed {
                return;
            }
            handle_trigger(app.clone(), action_c.clone(), prompt_id_c.clone(), service_id_c.clone());
        }) {
            Ok(()) => registered.push(accelerator),
            Err(e) => {
                log::warn!("跳过非法快捷键「{accelerator}」: {e}");
            }
        }
    }
    Ok(())
}

fn handle_trigger(app: tauri::AppHandle, action: String, prompt_id: Option<String>, service_id: Option<String>) {
    // 只记 action/绑定标识等元数据,不记任何文本内容
    log::info!(
        "快捷键触发: action={action} prompt={} service={}",
        prompt_id.as_deref().unwrap_or("-"),
        service_id.as_deref().unwrap_or("-")
    );
    match action.as_str() {
        // 划词总结 / 呼出输入框:通过 Accessibility 捕获选中文本(纯 AX,暂不回退剪贴板)
        "summarize" | "paste" => {
            if is_capture_paused() && action == "summarize" {
                // warn 级别:关闭诊断时也落盘 —— 「按快捷键没反应」最常见原因就是暂停忘开
                log::warn!("划词监听已暂停,忽略本次触发(可在托盘菜单或设置中恢复)");
                return;
            }
            // 只在面板从隐藏→显示时发 float-shown(触发前端 resetSession 新会话)。
            // 面板已显示时(如总结进行中用户误按全局快捷键)不 reset,避免丢失正在进行的会话数据;
            // 新捕获仍会经 dispatch_capture 更新输入并重新总结。
            let was_visible = crate::windows::is_float_visible();
            // 预捕获鼠标位置:在 capture_selection(耗时 AX 读取)之前采集,
            // 避免到 show_overlay 主线程执行时鼠标已移动 → 浮窗跟随鼠标。
            crate::native::stash_cursor_position();
            let mut captured = capture_selection(app.clone());
            // 快捷键若绑定了 AI 服务(引用式),经此分支带到前端,
            // 前端按 service_id 解析出该服务的模型/密钥,改服务配置即自动跟随。
            captured.service_id = service_id;
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
        // 打开主窗口(状态栏菜单 / 快捷键设置项):仅聚焦主窗口,无需捕获文本
        "open-main" => {
            let _ = crate::windows::show_main(app.clone());
        }
        // 截图 OCR:冻结截图 → 用户选区 → OCR 识别 → LLM 总结
        "screenshot-ocr" => {
            // 检查屏幕录制权限
            #[cfg(target_os = "macos")]
            if !crate::screenshot::screen_capture_trusted() {
                log::warn!("截图 OCR 失败: 未授权屏幕录制权限");
                // 显示浮窗并提示用户授权
                crate::windows::show_float(&app);
                let _ = app.emit("float-shown", ());
                dispatch_capture(&app, CapturedText {
                    text: String::new(),
                    source: "screenshot-ocr-unauthorized".to_string(),
                    prompt_id: prompt_id.clone(),
                    service_id: service_id.clone(),
                });
                return;
            }
            // 新流程：截取屏幕 → 显示 overlay → 用户选区后由 overlay 前端调用 finish_screenshot_selection
            let app2 = app.clone();
            let prompt_id2 = prompt_id.clone();
            let service_id2 = service_id.clone();
            std::thread::spawn(move || {
                log::info!("开始冻结截图 OCR");
                // 在新线程中创建 tokio runtime 来调用 async 函数
                let rt = tokio::runtime::Runtime::new().unwrap();
                match rt.block_on(crate::screenshot::start_screenshot_capture(app2.clone())) {
                    Ok(()) => {
                        // 截图成功，overlay 已显示，等待用户选区
                        // prompt_id 和 service_id 保存到全局状态，供 finish_screenshot_selection 使用
                        if let Ok(mut guard) = PENDING_OCR_PROMPT.lock() {
                            *guard = Some((prompt_id2, service_id2));
                        }
                    }
                    Err(e) => {
                        log::warn!("截图 OCR 失败: {e}");
                    }
                }
            });
        }
        // 绑定到具体提示词:携带 promptId 触发
        _ if !action.is_empty() => {
            if is_capture_paused() {
                log::warn!("划词监听已暂停,忽略本次触发(可在托盘菜单或设置中恢复)");
                return;
            }
            let was_visible = crate::windows::is_float_visible();
            crate::native::stash_cursor_position();
            let captured = capture_selection(app.clone());
            let mut with_prompt = captured;
            with_prompt.prompt_id = prompt_id;
            with_prompt.service_id = service_id;
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

/// 划词捕获:Windows 走 selection crate(UIA 优先 + Ctrl+C 兜底,自动恢复剪贴板);
/// macOS 走 Accessibility(AX)。读取失败/无选中文本返回 source=empty。
/// source 语义: selection=捕获成功 / empty=无选中文本 / unauthorized=未授权辅助功能(macOS)
fn capture_selection(app: tauri::AppHandle) -> CapturedText {
    #[cfg(target_os = "macos")]
    {
        let _ = &app;
        // 先检查授权:未授权时前端引导去系统设置开启辅助功能,而非静默空白
        if !accessibility_trusted() {
            log::warn!("划词捕获失败: 未授权辅助功能");
            return CapturedText {
                text: String::new(),
                source: "unauthorized".to_string(),
                prompt_id: None,
                service_id: None,
            };
        }
        let text = read_selection_text().unwrap_or_default();
        if !text.trim().is_empty() {
            // 只记长度,不记内容(隐私承诺:日志不含任何文本)
            log::info!("划词捕获成功: source=selection len={}", text.chars().count());
            return CapturedText {
                text,
                source: "selection".to_string(),
                prompt_id: None,
                service_id: None,
            };
        }
        // 无选中文本:输入区留空,由用户手动粘贴或输入
        log::info!("划词捕获为空: source=empty");
        CapturedText {
            text: String::new(),
            source: "empty".to_string(),
            prompt_id: None,
            service_id: None,
        }
    }
    #[cfg(windows)]
    {
        let _ = &app;
        // Windows 取词:selection crate(UIA 优先 + Ctrl+C 兜底,自动恢复剪贴板)。
        // UIA 对未提升权限的普通应用通用;目标进程以管理员运行时取词会被 UIPI 拦截
        // (与 mac 上辅助功能授权同理,需以管理员身份运行 ReadBrief 才能取提权窗口的词)。
        let text = read_selection_text().unwrap_or_default();
        if !text.trim().is_empty() {
            log::info!("划词捕获成功(windows): source=selection len={}", text.chars().count());
            return CapturedText {
                text,
                source: "selection".to_string(),
                prompt_id: None,
                service_id: None,
            };
        }
        log::info!("划词捕获为空(windows): source=empty");
        CapturedText {
            text: String::new(),
            source: "empty".to_string(),
            prompt_id: None,
            service_id: None,
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = &app;
        CapturedText {
            text: String::new(),
            source: "empty".to_string(),
            prompt_id: None,
            service_id: None,
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
    // debug 细分:AX 返回 0 字符多为目标应用不支持辅助功能属性(如 Safari 部分场景),
    // 与「有选中文本但为纯空白」区分,便于定位划词失败原因
    log::debug!("AX 选中文本读取: len={}", text.chars().count());
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

#[cfg(windows)]
fn read_selection_text() -> Option<String> {
    let text = selection::get_text();
    log::debug!("Windows 选中文本读取: len={}", text.chars().count());
    if text.trim().is_empty() {
        None
    } else {
        Some(text)
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
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
            service_id: s.service_id.clone(),
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
    // 返回弹窗后的真实授权状态:已授权=true;未授权=false(可能因用户取消或曾拒绝而不再弹窗)
    Ok(accessibility_trusted())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn request_accessibility() -> AppResult<bool> {
    Ok(true)
}

/// 屏幕录制授权:用于截图 OCR 总结等功能读取屏幕内容。
/// 注意:macOS 在授权后需要重启应用才能生效(系统限制),授权状态为尽力检测。
#[cfg(target_os = "macos")]
fn screen_capture_trusted() -> bool {
    unsafe extern "C" {
        fn CGPreflightScreenCaptureAccess() -> bool;
    }
    unsafe { CGPreflightScreenCaptureAccess() }
}

#[cfg(target_os = "macos")]
fn prompt_screen_capture() {
    unsafe extern "C" {
        fn CGRequestScreenCaptureAccess() -> bool;
    }
    unsafe {
        CGRequestScreenCaptureAccess();
    }
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub fn screen_recording_status() -> AppResult<bool> {
    Ok(screen_capture_trusted())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn screen_recording_status() -> AppResult<bool> {
    Ok(true)
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub fn request_screen_recording() -> AppResult<bool> {
    prompt_screen_capture();
    // 返回弹窗后的真实授权状态(屏幕录制授权后需重启生效,此处仅尽力检测)
    Ok(screen_capture_trusted())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn request_screen_recording() -> AppResult<bool> {
    Ok(true)
}
