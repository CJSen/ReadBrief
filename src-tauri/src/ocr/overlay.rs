//! macOS 原生 OCR 冻结图浮层 —— 使用 NSPanel + CGImage/CALayer 渲染。
//!
//! 架构:
//!   用户触发 OCR → ScreenCaptureKit 截图 → CGImage → 原生 NSPanel 显示冻结图
//!                                              ↓
//!                                        WindowServer → 覆盖全屏 App
//!
//! 核心特性:
//! 1. NSPanel + .nonactivatingPanel: 显示时不激活 ReadBrief
//! 2. .canJoinAllSpaces + .fullScreenAuxiliary: 覆盖全屏 App
//! 3. .screenSaver level: 确保在最上层
//! 4. 复用同一个 Panel 实例: 避免每次 OCR 都创建/销毁窗口
//! 5. 使用 AppKit/Core Animation 渲染: 避免 WebView 参与

#[cfg(target_os = "macos")]
use std::sync::Mutex;

#[cfg(target_os = "macos")]
use objc2::rc::Retained;
#[cfg(target_os = "macos")]
use objc2::{MainThreadOnly, AnyThread};
#[cfg(target_os = "macos")]
use objc2_app_kit::{
    NSPanel, NSWindowStyleMask, NSWindowCollectionBehavior,
    NSModalPanelWindowLevel, NSBackingStoreType,
};
#[cfg(target_os = "macos")]
use objc2_foundation::{NSRect, NSPoint, NSSize, MainThreadMarker};

/// 线程安全的指针包装
#[cfg(target_os = "macos")]
struct PanelPtr(*mut std::ffi::c_void);

#[cfg(target_os = "macos")]
unsafe impl Send for PanelPtr {}
#[cfg(target_os = "macos")]
unsafe impl Sync for PanelPtr {}

/// OCR 冻结图浮层单例
#[cfg(target_os = "macos")]
static OCR_PANEL: Mutex<Option<PanelPtr>> = Mutex::new(None);

/// 获取或创建 OCR 浮层单例
#[cfg(target_os = "macos")]
fn get_or_create_panel() -> Option<Retained<NSPanel>> {
    let mut guard = OCR_PANEL.lock().ok()?;

    if let Some(ref ptr) = *guard {
        // 已有面板，返回 Retained
        unsafe {
            let retained = Retained::retain(ptr.0 as *mut objc2::runtime::AnyObject)?;
            return retained.downcast::<NSPanel>().ok();
        }
    }

    // 创建新的 NSPanel
    let panel = create_ocr_panel()?;
    *guard = Some(PanelPtr(Retained::as_ptr(&panel) as *mut std::ffi::c_void));
    Some(panel)
}

/// 创建 OCR 浮层 NSPanel
#[cfg(target_os = "macos")]
fn create_ocr_panel() -> Option<Retained<NSPanel>> {
    unsafe {
        let mtm = MainThreadMarker::new()?;

        // 获取主屏幕尺寸
        let screen = objc2_app_kit::NSScreen::mainScreen(mtm)?;
        let screen_frame = screen.frame();

        // 创建 NSPanel
        let panel = NSPanel::initWithContentRect_styleMask_backing_defer(
            NSPanel::alloc(mtm),
            screen_frame,
            NSWindowStyleMask::Borderless | NSWindowStyleMask::NonactivatingPanel,
            NSBackingStoreType::Buffered,
            false,
        );

        // 设置面板属性
        panel.setOpaque(false);
        panel.setBackgroundColor(None);
        panel.setHasShadow(false);
        panel.setLevel(NSModalPanelWindowLevel);

        // 关键: 跨 Space + 全屏辅助
        let behavior = NSWindowCollectionBehavior::CanJoinAllSpaces
            | NSWindowCollectionBehavior::FullScreenAuxiliary;
        panel.setCollectionBehavior(behavior);

        // 不自动隐藏
        panel.setHidesOnDeactivate(false);

        // 允许成为 key window
        panel.setBecomesKeyOnlyIfNeeded(false);

        // 设置为可移动
        panel.setMovableByWindowBackground(true);

        Some(panel)
    }
}

/// 显示 OCR 冻结图
///
/// # Arguments
/// * `image_data` - PNG 格式的图片数据
/// * `x` - 显示位置 x 坐标（逻辑点）
/// * `y` - 显示位置 y 坐标（逻辑点）
/// * `width` - 显示宽度（逻辑点）
/// * `height` - 显示高度（逻辑点）
#[cfg(target_os = "macos")]
pub fn show_ocr_overlay(
    image_data: &[u8],
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    use objc2_foundation::NSData;
    use objc2_app_kit::NSImage;

    let panel = get_or_create_panel()
        .ok_or("无法创建 OCR 浮层")?;

    unsafe {
        // 设置窗口位置和大小
        let frame = NSRect::new(NSPoint::new(x, y), NSSize::new(width, height));
        panel.setFrame_display(frame, true);

        // 从 PNG 数据创建 NSImage
        let ns_data = NSData::from_vec(image_data.to_vec());
        let image = NSImage::initWithData(NSImage::alloc(), &ns_data);

        if let Some(image) = image {
            // 创建 NSImageView
            let mtm = MainThreadMarker::new().ok_or("无法获取主线程标记")?;
            let image_view = objc2_app_kit::NSImageView::initWithFrame(
                objc2_app_kit::NSImageView::alloc(mtm),
                panel.contentView().unwrap().bounds(),
            );
            image_view.setImage(Some(&image));

            // 设置为内容视图
            panel.setContentView(Some(&image_view));
        }

        // 显示面板（不激活应用）
        panel.orderFront(None);
    }

    Ok(())
}

/// 隐藏 OCR 冻结图浮层
#[cfg(target_os = "macos")]
pub fn hide_ocr_overlay() {
    if let Ok(guard) = OCR_PANEL.lock() {
        if let Some(ref ptr) = *guard {
            unsafe {
                let retained = Retained::retain(ptr.0 as *mut objc2::runtime::AnyObject);
                if let Some(panel) = retained.and_then(|r| r.downcast::<NSPanel>().ok()) {
                    panel.orderOut(None);
                }
            }
        }
    }
}

/// 检查 OCR 浮层是否可见
#[cfg(target_os = "macos")]
pub fn is_ocr_overlay_visible() -> bool {
    if let Ok(guard) = OCR_PANEL.lock() {
        if let Some(ref ptr) = *guard {
            unsafe {
                let retained = Retained::retain(ptr.0 as *mut objc2::runtime::AnyObject);
                if let Some(panel) = retained.and_then(|r| r.downcast::<NSPanel>().ok()) {
                    return panel.isVisible();
                }
            }
        }
    }
    false
}

// 非 macOS 平台的空实现
#[cfg(not(target_os = "macos"))]
pub fn show_ocr_overlay(
    _image_data: &[u8],
    _x: f64,
    _y: f64,
    _width: f64,
    _height: f64,
) -> Result<(), String> {
    Err("当前平台不支持 OCR 浮层".into())
}

#[cfg(not(target_os = "macos"))]
pub fn hide_ocr_overlay() {}

#[cfg(not(target_os = "macos"))]
pub fn is_ocr_overlay_visible() -> bool {
    false
}
