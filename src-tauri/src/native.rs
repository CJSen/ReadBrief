//! macOS 原生浮层控制器 —— 实现 Bob / Pot / Easydict 风格的系统级 NSPanel 浮层窗口。
//!
//! 架构:
//!   Global Shortcut → Rust Backend → (获取鼠标坐标 CGEvent) + (读取选中文本 AX)
//!                                   → Native NSPanel Overlay → React UI
//!
//! 核心手段(macOS):
//! 1. 运行期把 Tauri 创建的 NSWindow(TaoWindow 子类) 通过 `object_setClass` 转换为 `NSPanel`,
//!    并置 `NSWindowStyleMaskNonactivatingPanel` —— 面板可接收键盘输入但不激活应用,
//!    因此 Chrome/IDE 全屏时面板直接覆盖显示, 不会切回桌面 Space。
//! 2. `collectionBehavior = CanJoinAllSpaces | FullScreenAuxiliary | Transient`
//!    → 任意 Space(含 Chrome/Safari/VSCode 全屏 Space)直接悬浮。
//! 3. `level = NSModalPanelWindowLevel`(8) —— 输入法候选框同为「面板级」(≈8),用 8
//!    让候选字能显示在浮窗之上;此前 101/25 均高于候选框,导致候选字被遮挡
//!    (见 make_floating_panel 注释)。全屏穿透由 CanJoinAllSpaces+FullScreenAuxiliary 保证。
//! 4. 显示用 `orderFront:`(非 `makeKeyAndOrderFront`, 非 Tauri `show`/`set_focus`)
//!    —— 不激活应用, 不切换 Space。
//! 5. `becomesKeyOnlyIfNeeded = YES` —— 仅在点击输入框等需要键盘的控件时才成为 key window。

#[cfg(target_os = "macos")]
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use tauri::{AppHandle, Manager, PhysicalPosition};

// ═══════════════ Windows 平台层：不激活浮层（NSPanel → TOPMOST+NOACTIVATE+TOOLWINDOW） ═══════════════
// 把 macOS 上验证过的「不激活浮层」设计翻译成 Win32 语汇：
//   NSPanel(NonactivatingPanel) → WS_EX_TOPMOST | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW
//   orderFront（非 makeKeyAndOrderFront）→ ShowWindow(SW_SHOWNA)（显示但不激活）
//   CanJoinAllSpaces+FullScreenAuxiliary → Windows 无 Space 概念，TOPMOST 天然全屏覆盖
//   AX 取词 → selection crate 的 UIA 路径
#[cfg(windows)]
use windows::Win32::Foundation::{HWND, HINSTANCE, LPARAM, LRESULT, POINT, RECT, WPARAM};
#[cfg(windows)]
use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
#[cfg(windows)]
use windows::Win32::UI::Input::KeyboardAndMouse::SetFocus;
#[cfg(windows)]
use windows::Win32::UI::WindowsAndMessaging::*;
#[cfg(windows)]
use std::ffi::c_void;
#[cfg(windows)]
use std::sync::atomic::{AtomicPtr, Ordering};

// ═══════════════ CoreGraphics:光标位置 ═══════════════

#[cfg(target_os = "macos")]
#[repr(C)]
#[derive(Debug, Clone, Copy)]
struct CGPoint {
    x: f64,
    y: f64,
}

#[cfg(target_os = "macos")]
unsafe extern "C" {
    fn CGEventCreate(source: *const std::ffi::c_void) -> *const std::ffi::c_void;
    fn CGEventGetLocation(event: *const std::ffi::c_void) -> CGPoint;
    fn CFRelease(cf: *const std::ffi::c_void);
}

/// 获取当前光标位置(逻辑点 points,原点为主屏左上角;非主线程可调用)
#[cfg(target_os = "macos")]
pub fn cursor_position() -> Option<(f64, f64)> {
    unsafe {
        let event = CGEventCreate(std::ptr::null());
        if event.is_null() {
            return None;
        }
        let loc = CGEventGetLocation(event);
        CFRelease(event);
        Some((loc.x, loc.y))
    }
}

#[cfg(windows)]
pub fn cursor_position() -> Option<(f64, f64)> {
    unsafe {
        let mut pt = POINT::default();
        if GetCursorPos(&mut pt).is_ok() {
            Some((pt.x as f64, pt.y as f64))
        } else {
            None
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn cursor_position() -> Option<(f64, f64)> {
    None
}

// ═══════════════ NSPanel 浮层转换 ═══════════════

/// 浮窗是否已完成 NSPanel 转换(幂等守卫, 全进程一次)。
/// 转换发生在主线程(setup / show_overlay 均经 run_on_main_thread), 无并发问题。
#[cfg(target_os = "macos")]
static PANEL_CONVERTED: AtomicBool = AtomicBool::new(false);

/// 预捕获的鼠标位置(快捷键触发瞬间采集, 供 show_overlay 使用)。
///
/// 解决「浮窗跟随鼠标」问题:
/// handle_trigger 在快捷键回调线程调用 cursor_position() → capture_selection(耗时) →
/// show_float → run_on_main_thread(show_overlay)。到 show_overlay 在主线程执行时,
/// 鼠标可能已移动到新位置 → cursor_position() 返回新坐标 → 浮窗出现在新位置而非
/// 快捷键按下时的位置。用户感知为"浮窗跟着鼠标跑"。
///
/// 修复:快捷键触发瞬间预捕获位置存入此 static, show_overlay 优先使用它(take 消费)。
use std::sync::Mutex;
static PENDING_CURSOR: Mutex<Option<(f64, f64)>> = Mutex::new(None);

/// 快捷键触发瞬间预捕获鼠标位置(在 capture_selection 之前调用)。
pub fn stash_cursor_position() {
    if let Some(pos) = cursor_position() {
        if let Ok(mut guard) = PENDING_CURSOR.lock() {
            *guard = Some(pos);
        }
    }
}

#[cfg(target_os = "macos")]
fn float_ns_window(win: &tauri::WebviewWindow) -> Option<objc2::rc::Retained<objc2_app_kit::NSWindow>> {
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2_app_kit::NSWindow;

    unsafe {
        if let Ok(ptr) = win.ns_window() {
            if ptr.is_null() {
                return None;
            }
            Retained::retain(ptr as *mut AnyObject)
                .and_then(|any| any.downcast::<NSWindow>().ok())
        } else {
            None
        }
    }
}

/// 设置浮窗整体 alpha。供 hide_float 在隐藏前把 alpha 置 0 提交,确保窗口进入隐藏态时
/// alpha 属性已是 0 —— 否则下次 show_overlay 的 orderFront 会用旧 alpha=1 在旧位置
/// 合成一帧(闪现)。必须在主线程调用。
#[cfg(target_os = "macos")]
pub fn set_float_alpha(win: &tauri::WebviewWindow, alpha: f64) {
    if let Some(ns_window) = float_ns_window(win) {
        ns_window.setAlphaValue(alpha);
    }
}

#[cfg(not(target_os = "macos"))]
pub fn set_float_alpha(_win: &tauri::WebviewWindow, _alpha: f64) {}

/// 隐藏浮窗(跨平台)。
///
/// Windows 关键修复:透明 WebView2 窗口若用 `ShowWindow(SW_HIDE)` 隐藏,再次
/// `SW_SHOWNA` 显示时 compositor 会重建 → WebView 重载(表现为「点外部/X/Esc 不消失却刷新、
/// 数据丢失」)。改为移到屏幕外(-20000,-20000)并保持 visible,等价于不可见但**不触发重载**,
/// 关闭/点外部动作即时生效,下次显示数据不丢。
/// macOS/Linux:直接 `hide()`,无此重载问题。
#[cfg(windows)]
pub fn hide_float_window(win: &tauri::WebviewWindow) {
    if let Ok(hwnd) = win.hwnd() {
        unsafe {
            let _ = SetWindowPos(
                hwnd,
                Some(HWND_TOPMOST),
                -20000,
                -20000,
                0,
                0,
                SWP_NOSIZE | SWP_NOACTIVATE,
            );
        }
    }
    let _ = win.set_position(tauri::PhysicalPosition::new(-20000, -20000));
}

#[cfg(not(target_os = "windows"))]
pub fn hide_float_window(win: &tauri::WebviewWindow) {
    let _ = win.hide();
}

/// 强制 WebView2 立即重绘(Windows 专用)。
///
/// 根因:主窗口以 `visible:false` 创建、再由 Rust 主线程 `ShowWindow` 显示时,WebView2 的
/// DirectComposition 合成层常不提交「显示后」的首帧 —— 前端数据已加载进 React state、DOM 已更新,
/// 但合成层未绘制,表现为「主窗口空白、需点击/获焦才显示数据」。
/// 修法:显示后微调窗口尺寸(+1 再还原),触发 WM_SIZE → WebView2 重排并立即重绘,
/// 等价于强制首帧提交,无需用户交互即可显示已加载的内容。
#[cfg(windows)]
pub fn force_webview_repaint(win: &tauri::WebviewWindow) {
    if let Ok(size) = win.inner_size() {
        // 先 +1 触发 WM_SIZE(WebView2 重排重绘),再还原回原尺寸(消除可见位移)。
        let w = size.width;
        let h = size.height;
        let _ = win.set_size(tauri::Size::Physical(tauri::PhysicalSize::new(w, h + 1)));
        let _ = win.set_size(tauri::Size::Physical(tauri::PhysicalSize::new(w, h)));
    }
}

#[cfg(not(target_os = "windows"))]
pub fn force_webview_repaint(_win: &tauri::WebviewWindow) {}

/// 在 NSView 子视图树中查找 WKWebView(Tauri/wry 的 WebView 即此类型)并返回其引用。
///
/// 为什么需要它:`make_floating_panel` 中 setStyleMask 会重置 first responder,必须恢复。
/// 但若把 contentView(普通 NSView 容器)设为 first responder,而非其内部的 WKWebView,
/// 会导致 IME 候选框不显示 —— contentView 不实现 `NSTextInputClient` 协议,输入法的
/// input context 无法绑定到有效的文本输入客户端 → 能打字(键盘事件经 responder chain
/// 转发到 WKWebView)但看不到候选词。必须遍历子视图树找到真正的 WKWebView,把它设为
/// first responder(参考 tauri-nspanel 的 make_webview_first_responder、StackOverflow
/// #62095143 WKWebView responder chain 问题)。
#[cfg(target_os = "macos")]
fn find_wkwebview(
    view: &objc2_app_kit::NSView,
) -> Option<objc2::rc::Retained<objc2_app_kit::NSView>> {
    use objc2::rc::Retained;
    // WKWebView 是 WebKit 框架的类,类名 "WKWebView";用 contains 兼容可能的子类。
    if view
        .class()
        .name()
        .to_str()
        .is_ok_and(|n| n.contains("WKWebView"))
    {
        return Some(unsafe {
            Retained::retain(view as *const objc2_app_kit::NSView as *mut objc2_app_kit::NSView)
                .expect("retain WKWebView failed")
        });
    }
    for sub in view.subviews().to_vec() {
        if let Some(found) = find_wkwebview(&sub) {
            return Some(found);
        }
    }
    None
}

/// 把窗口内的 WKWebView 设为 first responder(键盘事件/IME 的实际接收者)。
///
/// overlay 截图浮层场景:窗口经 object_setClass → NSPanel + setStyleMask 后
/// first responder 被重置,若不恢复,前端 keydown(如 Esc 取消)收不到任何键盘事件。
/// 与 make_floating_panel 第 2 步的同款处理,抽出复用。
#[cfg(target_os = "macos")]
pub fn make_webview_first_responder(win: &tauri::WebviewWindow) {
    use objc2::rc::Retained;
    use objc2_app_kit::NSResponder;

    if let Some(ns_window) = float_ns_window(win) {
        unsafe {
            if let Some(content_view) = ns_window.contentView() {
                let responder: Retained<NSResponder> = find_wkwebview(&content_view)
                    .map(|v| v.into_super())
                    .unwrap_or_else(|| content_view.into_super());
                ns_window.makeFirstResponder(Some(&responder));
            }
        }
    }
}

#[cfg(not(target_os = "macos"))]
pub fn make_webview_first_responder(_win: &tauri::WebviewWindow) {}

/// 缓存动态注册的 `ReadBriefPanel` 类引用(进程内一次注册)。
#[cfg(target_os = "macos")]
static PANEL_CLASS: OnceLock<&'static objc2::runtime::AnyClass> = OnceLock::new();

/// `canBecomeKeyWindow` 实现:恒返回 YES。
///
/// 为什么必须重写:Tauri/tao 创建的窗口是 borderless(`decorations: false`, 无 `Titled`
/// style mask),`object_setClass` 到 NSPanel 后丢失了 tao 对 `canBecomeKeyWindow` 的重写
/// (原本返回 YES)。而 NSWindow/NSPanel 的默认实现 —— **无 `Titled` mask 时返回 NO** ——
/// 导致 `makeKeyWindow()` 被静默忽略,面板永远不成为 key window:
///   - WKWebView 收不到键盘事件 → Esc / ⌘C / ⌘R / ⌘P 全部失效
///   - 点击外部不触发 `windowDidResignKey` → 无 `Focused(false)` → 点击外部关闭失效
/// 子类重写为 YES 后,`makeKeyWindow()` 生效,面板显示即成为 key(由 NonactivatingPanel
/// 保证不激活应用),键盘事件与失焦事件链路恢复。
#[cfg(target_os = "macos")]
unsafe extern "C-unwind" fn panel_can_become_key(
    _this: *const objc2::runtime::AnyObject,
    _sel: objc2::runtime::Sel,
) -> objc2::runtime::Bool {
    objc2::runtime::Bool::YES
}

/// `canBecomeMainWindow` 实现:恒返回 YES。
///
/// 为什么是 YES(而非 NSPanel 默认的 NO):输入法候选框的显示依赖窗口的 main/key 状态。
/// 参照 Bob —— 其 TranslateWindow 显式重写 `canBecomeMainWindow` 返回 YES。NSPanel 默认
/// 不能成为 main window,会导致 WKWebView 在浮窗中输入时输入法候选框不显示(能打字、
/// 按空格能上屏,但看不到候选词)。改为 YES 后浮窗可成为 main window,输入法输入上下文
/// 正确建立,候选框正常显示。副作用可忽略(NonactivatingPanel 下应用非 active 时,窗口
/// 不会真正抢占 main window 地位)。
#[cfg(target_os = "macos")]
unsafe extern "C-unwind" fn panel_can_become_main(
    _this: *const objc2::runtime::AnyObject,
    _sel: objc2::runtime::Sel,
) -> objc2::runtime::Bool {
    objc2::runtime::Bool::YES
}

/// 动态注册 `ReadBriefPanel`(NSPanel 子类,重写 canBecomeKeyWindow=YES /
/// canBecomeMainWindow=NO),返回其类引用。注册仅执行一次,后续直接返回缓存。
/// 供浮窗 make_floating_panel 与截图 overlay show_overlay_fullscreen 共用。
#[cfg(target_os = "macos")]
pub(crate) fn ensure_panel_class() -> &'static objc2::runtime::AnyClass {
    use objc2::ffi::{class_addMethod, objc_allocateClassPair, objc_registerClassPair};
    use objc2::runtime::{AnyClass, Imp, Sel};

    *PANEL_CLASS.get_or_init(|| unsafe {
        let ns_panel = AnyClass::get(c"NSPanel").expect("NSPanel class not found");
        // extra_bytes=0:不加 ivar,instance_size = NSPanel size。
        let cls = objc_allocateClassPair(ns_panel, c"ReadBriefPanel".as_ptr(), 0);
        if cls.is_null() {
            // 极端情况(同名类已存在):回退到纯 NSPanel
            return AnyClass::get(c"NSPanel").expect("NSPanel");
        }
        // 重写 canBecomeKeyWindow / canBecomeMainWindow
        let sel_key = Sel::register(c"canBecomeKeyWindow");
        let sel_main = Sel::register(c"canBecomeMainWindow");
        let imp_key: Imp = std::mem::transmute(panel_can_become_key as *const ());
        let imp_main: Imp = std::mem::transmute(panel_can_become_main as *const ());
        // type encoding "c@:" = 返回 char(BOOL), 参数 self(@) 与 _cmd(:)
        let _ = class_addMethod(cls, sel_key, imp_key, c"c@:".as_ptr());
        let _ = class_addMethod(cls, sel_main, imp_main, c"c@:".as_ptr());
        objc_registerClassPair(cls);
        // 注册后类存活整个进程生命周期,可安全转 'static 引用
        &*(cls as *const AnyClass)
    })
}

/// 把 Tauri 浮窗转换为系统级 NSPanel 浮层(幂等, 首次调用生效)。必须在主线程调用。
///
/// 转换内容:
/// - `object_setClass`: NSWindow(TaoWindow) → 自定义 `ReadBriefPanel`(NSPanel 子类)
/// - `styleMask |= NonactivatingPanel`: 面板可获键盘焦点但不激活应用
/// - `collectionBehavior = CanJoinAllSpaces | FullScreenAuxiliary | Transient`: 跨 Space + 全屏辅助
/// - `level = NSModalPanelWindowLevel`(8): 与输入法候选框(面板级)同层,候选字可显示在浮窗之上
/// - `hidesOnDeactivate = false`: 失焦不自动隐藏(本应用从不激活)
/// - `becomesKeyOnlyIfNeeded = false`: 允许显示后即成为 key(配合 makeKeyWindow, 恢复键盘/失焦事件)
/// - `worksWhenModal = true`: 模态窗口前仍可响应
/// - 子类重写 `canBecomeKeyWindow=YES`: borderless 面板默认返回 NO 会让 makeKeyWindow 失效
#[cfg(target_os = "macos")]
pub fn make_floating_panel(win: &tauri::WebviewWindow) {
    use objc2::ffi::object_setClass;
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2_app_kit::{
        NSPanel, NSResponder, NSModalPanelWindowLevel, NSWindowCollectionBehavior,
        NSWindowStyleMask,
    };

    if PANEL_CONVERTED.load(Ordering::SeqCst) {
        return;
    }
    let Some(ns_window) = float_ns_window(win) else {
        return;
    };

    // ── 1. NSWindow → ReadBriefPanel(NSPanel 子类) 运行期类转换 ──
    // `object_setClass` 直接替换对象的 isa 指针。ReadBriefPanel 重写了 canBecomeKeyWindow=YES
    // (borderless NSPanel 默认返回 NO,会让 makeKeyWindow 静默失败)。
    //
    // 安全说明:NSPanel 比 NSWindow 多若干 BOOL ivar,object_setClass 后存在 instance_size
    // 不匹配的潜在 UB;但 malloc 按 16 字节对齐,多出的 BOOL 落在填充内,且随即通过 setter
    // 显式初始化。这是 Bob/Pot/Easydict 等成熟浮层应用的通用做法。不能用 objc2 的 set_class
    // 助手(debug_assert 会因 size 不等 panic),走原始 FFI。
    // 注意:tao 的 delegate(独立对象)不受类替换影响,事件转发正常。
    unsafe {
        let panel_cls = ensure_panel_class();
        let raw = Retained::as_ptr(&ns_window) as *mut AnyObject;
        object_setClass(raw, panel_cls);
    }
    // 转换后 downcast 为 NSPanel(ReadBriefPanel 的父类)以调用面板专属方法
    let ns_panel = ns_window
        .downcast::<NSPanel>()
        .expect("NSWindow → ReadBriefPanel class swap failed");

    // ── 2. Style mask: NonactivatingPanel(全屏穿透必需) ──
    // NonactivatingPanel 让面板"不激活应用也能接收键盘 + 不切 Space" → Chrome/IDE 全屏时
    // 浮窗直接悬浮(全屏穿透)。代价:NonactivatingPanel 默认不让面板成为 main window →
    // macOS 输入法判定为"非激活浮层",不创建屏幕候选框(候选词只走 Touch Bar)。
    // 解决:show_overlay 中 makeMainWindow() 显式让面板成为 main window(canBecomeMainWindow
    // 已重写为 YES),输入法据此创建屏幕候选框。这样既保留 NonactivatingPanel 全屏穿透,
    // 又恢复屏幕候选框。
    let mut mask = ns_panel.styleMask();
    mask.insert(NSWindowStyleMask::NonactivatingPanel);
    ns_panel.setStyleMask(mask);
    // setStyleMask 会重置 first responder —— 必须把 WKWebView(非 contentView 容器)重新
    // 设为 first responder,否则 IME input context 绑定到非 NSTextInputClient 的容器,
    // 候选框不显示。见 find_wkwebview 注释。
    if let Some(content_view) = ns_panel.contentView() {
        let responder: Retained<NSResponder> = find_wkwebview(&content_view)
            .map(|v| v.into_super())
            .unwrap_or_else(|| content_view.into_super());
        ns_panel.makeFirstResponder(Some(&responder));
    }

    // ── 3. Collection behavior: 跨 Space + 全屏辅助 + 临时浮层 ──
    let mut behavior = ns_panel.collectionBehavior();
    behavior.insert(NSWindowCollectionBehavior::CanJoinAllSpaces);
    behavior.insert(NSWindowCollectionBehavior::FullScreenAuxiliary);
    behavior.insert(NSWindowCollectionBehavior::Transient);
    ns_panel.setCollectionBehavior(behavior);

    // ── 4. Level: NSModalPanelWindowLevel(8) —— 输入法候选框为「面板级」(≈8)。
    //    浮窗 level 必须不高于候选框,否则候选框被浮窗遮挡,表现为"打字不显示候选字、
    //    按空格能上屏"。此前 101(遮挡) → 25(仍高于 8,继续遮挡) → 现 8(与 Bob 一致)。
    //    全屏穿透由 CanJoinAllSpaces + FullScreenAuxiliary 保证,不依赖高 level。
    ns_panel.setLevel(NSModalPanelWindowLevel);

    // ── 5. 失焦不自动隐藏(本应用从不激活, 否则一显示就消失) ──
    ns_panel.setHidesOnDeactivate(false);

    // ── 7. NSPanel 专属: 必须显式允许随时成为 key window ——
    //    becomesKeyOnlyIfNeeded=true 会把「仅在点击需要键盘的控件时成为 key」的语义强加给面板,
    //    导致 show 后 makeKeyWindow 被拒绝/立即撤销 → WebView 收不到键盘事件(Esc 失效),
    //    点击外部也不触发 windowDidResignKey(点击外部关闭失效)。
    //    置 false: 显示后即可成为 key(不激活应用, 由 NonactivatingPanel 保证)。
    ns_panel.setBecomesKeyOnlyIfNeeded(false);
    ns_panel.setWorksWhenModal(true);

    PANEL_CONVERTED.store(true, Ordering::SeqCst);
}

#[cfg(windows)]
pub fn make_floating_panel(win: &tauri::WebviewWindow) {
    let hwnd = match win.hwnd() {
        Ok(h) => h,
        Err(_) => return,
    };
    unsafe {
        let ex = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
        // 注意:刻意【不】加 WS_EX_NOACTIVATE。
        // WS_EX_NOACTIVATE 会让窗口永不激活 → 永远收不到键盘焦点 → 输入框无法聚焦、打不了字
        // (macOS 的 NonactivatingPanel 能「不抢焦点 + 仍可输入」,但 Windows 该样式做不到)。
        // 去掉后:show_overlay 用 SW_SHOWNA 显示(出现时不抢前台焦点,不破坏全屏源应用);
        // 用户点击输入框时窗口正常激活 → WebView2 拿到焦点 → 文本框可输入。
        // 拖拽(set_position)与「点外部关闭」(LL 鼠标钩子)均不依赖激活态,行为不变。
        let new_ex = ex | WS_EX_TOPMOST.0 | WS_EX_TOOLWINDOW.0;
        SetWindowLongW(hwnd, GWL_EXSTYLE, new_ex as i32);
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn make_floating_panel(_win: &tauri::WebviewWindow) {}

// ═══════════════ 光标附近定位 ═══════════════

/// 把浮窗移动到光标附近(右下方, 越界翻转到左/上方), 参考 pot translate_window 的边界调整。
/// 鼠标坐标为逻辑点, 显示器/窗口尺寸为物理像素, 用 scale_factor 换算。
/// 多显示器:遍历所有显示器, 取光标所在的(避免 current_monitor 停在桌面 Space 的显示器)。
pub fn position_near_cursor(app: &AppHandle, win: &tauri::WebviewWindow, mouse: (f64, f64)) {
    let (mx, my) = mouse;
    // 找光标所在显示器(逻辑坐标比较)
    let monitor = app
        .available_monitors()
        .ok()
        .into_iter()
        .flatten()
        .find(|m| {
            let scale = m.scale_factor() as f64;
            let p = m.position();
            let s = m.size();
            let lx0 = p.x as f64 / scale;
            let ly0 = p.y as f64 / scale;
            let lx1 = (p.x as f64 + s.width as f64) / scale;
            let ly1 = (p.y as f64 + s.height as f64) / scale;
            mx >= lx0 && mx <= lx1 && my >= ly0 && my <= ly1
        })
        .or_else(|| win.current_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        return;
    };
    let scale = monitor.scale_factor() as f64;
    let (mw, mh) = {
        let s = monitor.size();
        (s.width as f64, s.height as f64)
    };
    let (mox, moy) = {
        let p = monitor.position();
        (p.x as f64, p.y as f64)
    };
    // 光标物理位置(逻辑点 × 缩放)
    let px = mx * scale;
    let py = my * scale;
    // 窗口物理尺寸
    let Ok(win_size) = win.outer_size() else {
        return;
    };
    let (ww, wh) = (win_size.width as f64, win_size.height as f64);
    let gap = 16.0 * scale;

    // 默认放光标右下方
    let mut x = px + gap;
    let mut y = py + gap;
    // 右侧放不下 → 翻到左侧
    if x + ww > mox + mw {
        x = px - ww - gap;
    }
    // 下方放不下 → 翻到上方
    if y + wh > moy + mh {
        y = py - wh - gap;
    }
    // 钳制在显示器内
    x = x.max(mox + gap.min(ww * 0.1)).min(mox + mw - ww - 1.0);
    y = y.max(moy + gap.min(wh * 0.1)).min(moy + mh - wh - 1.0);

    let _ = win.set_position(PhysicalPosition::new(x as i32, y as i32));
}

// ═══════════════ 浮层显示流程 ═══════════════

/// 完整浮层显示流程(macOS, 必须在主线程执行):
///   面板化(幂等) → 透明化 → 光标定位 → orderFront → makeKeyWindow → 锁定位置 → 恢复可见
///
/// 关键约束(经 tao 源码确认):
/// - tao 的 `set_visible(true)`(即 Tauri 的 `win.show()`)在 macOS 上调用
///   `makeKeyAndOrderFront:` → **激活应用 → macOS 切回 ReadBrief 所属桌面 Space**,
///   这正是「Chrome 全屏时窗口不显示在当前 Space」的根因。
/// - `set_focus()` 同样激活应用。
/// - 因此全程不调用 `win.show()` / `set_focus()` / `makeKeyAndOrderFront`,
///   仅用 `orderFront(None)` 在非激活 NSPanel 上显示 —— 不激活应用, 不切换 Space,
///   直接覆盖在 Chrome/IDE 全屏窗口之上。
///
/// 透明化技巧(解决「在上次位置闪现」):
/// NSPanel 在 orderOut(隐藏)后, set_position(setFrameOrigin) 可能不立即生效,
/// orderFront/makeKeyWindow 会用上次的 frame 让窗口在旧位置变可见,
/// 随后第二次 set_position 才把窗口移到新位置 —— 用户感知为「闪一下才到鼠标位置」。
/// 修复:orderFront 前把 alpha 设为 0(窗口变可见但用户不可见),定位完成后再恢复 alpha=1.0。
#[cfg(target_os = "macos")]
pub fn show_overlay(app: &AppHandle) {
    let Some(win) = app.get_webview_window("float") else {
        return;
    };
    // 1. 面板化(幂等, 首次完成 NSWindow → NSPanel 类转换 + 属性设置)
    make_floating_panel(&win);
    // 2. 光标附近定位:优先使用快捷键触发瞬间预捕获的位置(take 消费),
    //    避免主线程异步延迟导致 cursor_position() 读到移动后的新坐标(浮窗跟随鼠标)。
    let mouse = PENDING_CURSOR
        .lock()
        .ok()
        .and_then(|mut g| g.take())
        .or_else(cursor_position);

    // 3. 先标记可见(触发失焦 grace period, 避免透明期间焦点抖动误触发自动隐藏)
    crate::windows::mark_float_visible();

    // 4. 透明化(避免在旧位置闪现)
    if let Some(ns_window) = float_ns_window(&win) {
        ns_window.setAlphaValue(0.0);
    }

    // 4.5 预定位:窗口仍处于 ordered-out 状态时就先 set_frame_origin 一次。
    //    Bob 的顺序即「先 setFrameOrigin 再 orderFront」;若等窗口可见后再定位,
    //    窗口服务可能先按旧 frame 合成一帧(旧位置闪现)。后续第 6/8 步会再定位兜底。
    if let Some(mouse) = mouse {
        position_near_cursor(app, &win, mouse);
    }

    // 5. 显示 + 成为 key window:用 orderFront + makeKeyWindow,不用 makeKeyAndOrderFront。
    //    关键区别:makeKeyAndOrderFront 会**强制窗口服务同步合成显示**,与上方
    //    setAlphaValue(0.0) 竞速 —— alpha=0 尚未提交时窗口已按 alpha=1 在旧位置合成一帧
    //    → 用户看到「闪一下再到鼠标位置」(闪现根因)。orderFront 是延迟合成,alpha=0 先
    //    生效,窗口变可见时已透明,不会闪。
    //    makeKeyWindow 让面板成为 key(NonactivatingPanel + canBecomeKeyWindow=YES,不激活应用),
    //    键盘事件 / Esc / ⌘C / 失焦关闭链路由此恢复。无需 activateIgnoringOtherApps 兜底 ——
    //    日志实测 isKeyWindow=true(makeKey 成功),且应用已是 Accessory 形态(IME 由 Accessory
    //    策略保证,见 lib.rs set_activation_policy,与显示调用无关)。
    if let Some(ns_window) = float_ns_window(&win) {
        ns_window.orderFront(None);
        ns_window.makeKeyWindow();
    }

    // 6. 光标附近定位(窗口已显示但透明, set_position 此时一定生效)
    if let Some(mouse) = mouse {
        position_near_cursor(app, &win, mouse);
    }

    // 7. first responder = WKWebView(makeKeyWindow 可能重置 responder chain,
    //    必须重设,否则 input context 绑回 contentView 容器 → 候选框不显示)
    if let Some(ns_window) = float_ns_window(&win) {
        if let Some(content_view) = ns_window.contentView() {
            if let Some(wk) = find_wkwebview(&content_view) {
                let responder: objc2::rc::Retained<objc2_app_kit::NSResponder> = wk.into_super();
                ns_window.makeFirstResponder(Some(&responder));
            }
        }
    }

    // 8. 锁定位置:orderFront/makeKeyWindow 后重新 set_position 一次,
    //    防止 macOS 窗口服务在面板可见化时重定位窗口。
    if let Some(mouse) = mouse {
        position_near_cursor(app, &win, mouse);
    }

    // 9. 恢复可见:此时窗口已在正确位置, 不会出现位置闪现
    if let Some(ns_window) = float_ns_window(&win) {
        ns_window.setAlphaValue(1.0);
    }
}

/// Windows 上让浮窗「呼出即可用快捷键」:等价于 macOS 的 makeKeyWindow + makeFirstResponder。
/// 仅 ShowWindow(SW_SHOWNA) 只能显示、窗口不持键盘焦点 → WebView 收不到 keydown,
/// 必须点一下浮窗快捷键才生效(与 macOS 呼出即用的体验不符)。
/// 这里显式 SetForegroundWindow + SetFocus 把窗口置前并聚焦;因浮窗进程通常非前台进程,
/// 用 AttachThreadInput 附到当前前台线程以绕过 Windows「仅前台进程可 SetForegroundWindow」的前台锁。
#[cfg(windows)]
unsafe fn activate_float_window(hwnd: HWND) {
    let fg = GetForegroundWindow();
    let mut fg_thread = 0u32;
    if !fg.is_invalid() {
        GetWindowThreadProcessId(fg, Some(&mut fg_thread));
    }
    let cur_thread = GetCurrentThreadId();
    let attached = fg_thread != 0 && fg_thread != cur_thread;
    if attached {
        let _ = AttachThreadInput(fg_thread, cur_thread, true);
    }
    let _ = SetForegroundWindow(hwnd);
    let _ = SetFocus(Some(hwnd));
    if attached {
        let _ = AttachThreadInput(fg_thread, cur_thread, false);
    }
}

/// Windows 浮层显示:等价于 macOS 的 orderFront(显示但不激活)。
/// 关键:全程不调用 Tauri 的 show()/set_focus()(二者都会激活应用,挤掉全屏前台应用),
/// 仅用 Win32 的 ShowWindow(SW_SHOWNA) + SetWindowPos(TOPMOST, NOACTIVATE)。
#[cfg(windows)]
pub fn show_overlay(app: &AppHandle) {
    let Some(win) = app.get_webview_window("float") else {
        return;
    };
    // 1. 面板化(幂等):注入 WS_EX_TOPMOST|TOOLWINDOW,等价于 macOS 的 NSPanel
    make_floating_panel(&win);
    // 2. 先定位到光标附近:SW_SHOWNA 对隐藏窗口立即生效,无需 mac 的 alpha 防闪技巧
    if let Some(mouse) = cursor_position() {
        position_near_cursor(app, &win, mouse);
    }
    // 3. 标记可见(驱动失焦 grace period 等状态机)
    crate::windows::mark_float_visible();
    // 4. 显示但不激活(等价于 mac 的 orderFront ≠ makeKeyAndOrderFront)
    if let Ok(hwnd) = win.hwnd() {
        unsafe {
            let _ = ShowWindow(hwnd, SW_SHOWNA);
            let _ = SetWindowPos(
                hwnd,
                Some(HWND_TOPMOST),
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
            );
            // 等价于 macOS makeKeyWindow + makeFirstResponder:显式置前+聚焦,
            // 让 WebView 立即持有键盘焦点 → 呼出后无需点击即可用 ⌘/Ctrl+C/R/P 等快捷键。
            activate_float_window(hwnd);
        }
    }
}

/// 非 macOS/Windows 平台(如 Linux)浮层显示(桌面窗口, 无 Space 概念)
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn show_overlay(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("float") {
        let _ = win.set_always_on_top(true);
        let _ = win.show();
        let _ = win.set_focus();
        crate::windows::mark_float_visible();
    }
}

// ═══════════════ 点击外部关闭（Windows 专用，方案 B） ═══════════════
// WS_EX_NOACTIVATE 下窗口永不持有焦点 → Focused(false) 事件永不触发 →
// macOS 的「点击外部关闭」链路在 Windows 上失效。改用 WH_MOUSE_LL 低级鼠标钩子,
// 在浮窗可见时判断鼠标按下是否落在浮窗矩形外,是则隐藏。
// 钩子在 setup(主线程,有消息泵)安装一次即可,随浮窗可见性自行判断。
#[cfg(windows)]
static CLICK_OUTSIDE_APP: OnceLock<tauri::AppHandle> = OnceLock::new();
#[cfg(windows)]
static CLICK_OUTSIDE_HOOK: AtomicPtr<c_void> = AtomicPtr::new(std::ptr::null_mut());

/// 安装「点击外部关闭」低级鼠标钩子(幂等)。非 Windows 平台为空操作。
#[cfg(windows)]
pub fn install_click_outside_hook(app: &tauri::AppHandle) {
    if !CLICK_OUTSIDE_HOOK.load(Ordering::SeqCst).is_null() {
        return;
    }
    let _ = CLICK_OUTSIDE_APP.set(app.clone());
    unsafe {
        if let Ok(hook) = SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_proc), Some(HINSTANCE::default()), 0)
        {
            CLICK_OUTSIDE_HOOK.store(hook.0, Ordering::SeqCst);
            log::debug!("已安装点击外部关闭鼠标钩子");
        } else {
            log::warn!("安装点击外部关闭鼠标钩子失败");
        }
    }
}

#[cfg(not(target_os = "windows"))]
pub fn install_click_outside_hook(_app: &tauri::AppHandle) {}

#[cfg(windows)]
unsafe extern "system" fn mouse_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        let msg = wparam.0 as u32;
        if msg == WM_LBUTTONDOWN || msg == WM_RBUTTONDOWN || msg == WM_MBUTTONDOWN {
            if let Some(app) = CLICK_OUTSIDE_APP.get() {
                // 浮窗不可见时忽略,避免干扰正常操作
                if crate::windows::is_float_visible() {
                    let hs = lparam.0 as *const MOUSEHOOKSTRUCT;
                    let pt = (*hs).pt;
                    if let Some(win) = app.get_webview_window("float") {
                        if let Ok(hwnd) = win.hwnd() {
                            let mut rect = RECT::default();
                            if GetWindowRect(hwnd, &mut rect).is_ok() {
                                let inside = pt.x >= rect.left
                                    && pt.x <= rect.right
                                    && pt.y >= rect.top
                                    && pt.y <= rect.bottom;
                                if !inside
                                    && !crate::windows::is_float_fixed()
                                    && crate::windows::get_float_state()
                                        != crate::windows::FLOAT_STATE_STREAMING
                                {
                                    // 严禁在 WH_MOUSE_LL 钩子回调内直接 ShowWindow/emit:
                                    // 会打断消息泵导致 WebView2 刷新、隐藏不生效。defer 到主线程执行。
                                    let app2 = app.clone();
                                    let _ = app2.clone().run_on_main_thread(move || {
                                        crate::windows::hide_float(&app2);
                                    });
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    let raw = CLICK_OUTSIDE_HOOK.load(Ordering::SeqCst);
    let hhk = if raw.is_null() {
        None
    } else {
        Some(HHOOK(raw))
    };
    CallNextHookEx(hhk, code, wparam, lparam)
}
