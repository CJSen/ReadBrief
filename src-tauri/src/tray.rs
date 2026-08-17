use crate::error::AppResult;
use std::sync::Mutex;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager,
};

static TRAY: Mutex<Option<tauri::tray::TrayIcon>> = Mutex::new(None);

/// 托盘可变菜单项句柄缓存(Tauri 2 的 TrayIcon 无 menu() getter,需保存句柄做局部 set_text 更新)
static STATUS_ITEM: Mutex<Option<MenuItem<tauri::Wry>>> = Mutex::new(None);
static TODAY_ITEM: Mutex<Option<MenuItem<tauri::Wry>>> = Mutex::new(None);

/// 托盘菜单项 id 常量
const ID_TOGGLE: &str = "toggle_selection";
const ID_TODAY: &str = "today";

/// 菜单文案右侧占位：原生 macOS 菜单无法设固定宽度，用全角空格把各菜单项撑宽到约 1.5 倍，
/// 让弹层整体更舒展（不再显得小气）。
const PADDING: &str = "\u{3000}\u{3000}\u{3000}\u{3000}";

/// 给菜单文案追加右侧占位宽度
fn pad(label: &str) -> String {
    format!("{}{}", label, PADDING)
}

/// 读配置里「打开主窗口」已绑定的快捷键，返回可显示在菜单右侧的加速键串（未设置则返回 None）
fn open_main_accelerator() -> Option<String> {
    let accel = crate::config::load_config()
        .shortcuts
        .iter()
        .find(|s| s.id == "open-main")
        .map(|s| s.accelerator.clone())
        .filter(|a| !a.is_empty())?;
    // 仅当能被快捷键解析器识别时才显示，避免非法串导致菜单构建失败
    // （菜单加速键与全局快捷键同源，均使用 accelerator crate 的串格式）
    if accel.parse::<tauri_plugin_global_shortcut::Shortcut>().is_ok() {
        Some(accel)
    } else {
        None
    }
}

pub fn setup_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let enabled = crate::config::load_config().selection_on;
    let toggle_item =
        MenuItem::with_id(app, ID_TOGGLE, pad(&toggle_label(enabled)), true, None::<&str>)?;
    let today_item = MenuItem::with_id(app, ID_TODAY, pad("今日已总结 0 次"), true, None::<&str>)?;
    let open_main_item = MenuItem::with_id(
        app,
        "open_main",
        pad("打开主窗口"),
        true,
        open_main_accelerator().as_deref(),
    )?;
    let settings_item = MenuItem::with_id(app, "settings", pad("设置"), true, None::<&str>)?;
    let about_item = MenuItem::with_id(app, "about", pad("关于ReadBrief"), true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit_item = MenuItem::with_id(app, "quit", pad("退出"), true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[
            &toggle_item,
            &today_item,
            &open_main_item,
            &settings_item,
            &about_item,
            &separator,
            &quit_item,
        ],
    )?;

    // 缓存可变菜单项句柄(供 refresh_tray 局部 set_text)
    if let Ok(mut g) = STATUS_ITEM.lock() {
        *g = Some(toggle_item.clone());
    }
    if let Ok(mut g) = TODAY_ITEM.lock() {
        *g = Some(today_item.clone());
    }

    let mut builder = TrayIconBuilder::with_id("main-tray")
        .menu(&menu)
        .show_menu_on_left_click(false)
        // 左键点击状态栏图标 → 打开主窗口(关闭后重新打开的入口)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let _ = crate::windows::show_main(tray.app_handle().clone());
            }
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            ID_TOGGLE => {
                // 划词监听开关:与设置-通用「启用划词监听」联动,点击即切换
                let mut cfg = crate::config::load_config();
                cfg.selection_on = !cfg.selection_on;
                let _ = crate::config::save_config(&cfg);
                crate::shortcuts::set_capture_paused(!cfg.selection_on);
                let _ = app.emit("selection-state-changed", cfg.selection_on);
                refresh_tray(app);
            }
            "open_main" => {
                let _ = crate::windows::show_main(app.clone());
            }
            "settings" => {
                let _ = crate::windows::open_settings(app.clone());
            }
            "about" => {
                // 直接打开设置页的「关于」分区
                let _ = crate::windows::open_settings_section(app.clone(), "about".to_string());
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        });

    // 状态栏图标:使用新设计的圆形白线 tray 图标(模板模式,系统按菜单栏明暗自动反色)
    // 编译期嵌入 PNG 并解码为 RGBA,避免 dev/build 资源路径差异
    let tray_icon = (|| -> Option<tauri::image::Image<'static>> {
        let bytes = include_bytes!("../icons/tray-iconTemplate@2x.png");
        let decoder = png::Decoder::new(std::io::Cursor::new(bytes.as_ref()));
        let mut reader = decoder.read_info().ok()?;
        let mut buf = vec![0u8; reader.output_buffer_size()];
        let info = reader.next_frame(&mut buf).ok()?;
        buf.truncate(info.buffer_size());
        tauri::image::Image::new_owned(buf, info.width, info.height).into()
    })();
    if let Some(icon) = tray_icon {
        builder = builder.icon(icon).icon_as_template(true);
    } else {
        log::warn!("加载托盘图标失败,回退到默认窗口图标");
        if let Some(icon) = app.default_window_icon() {
            builder = builder.icon(icon.clone());
        } else {
            log::warn!("未找到默认窗口图标,托盘将显示空白图标");
        }
    }

    let tray = builder.build(app)?;

    if let Ok(mut guard) = TRAY.lock() {
        *guard = Some(tray);
    }

    // 初始化文案(今日次数 / 划词监听状态)
    refresh_tray(app);
    Ok(())
}

/// 划词监听开关的菜单文案
fn toggle_label(enabled: bool) -> String {
    if enabled {
        "划词监听已开启".to_string()
    } else {
        "划词监听已关闭".to_string()
    }
}

/// 刷新托盘菜单文案(监听状态 / 今日次数)
pub fn refresh_tray(app: &tauri::AppHandle) {
    // 先查 DB 再拿 TRAY 锁:避免"持 TRAY 锁跨 DB 查询"的反模式(未来若出现相反加锁顺序会死锁)
    let today_count = app
        .state::<crate::history::AppState>()
        .db
        .lock()
        .map(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM history
                 WHERE DATE(created_at, 'localtime') = DATE('now', 'localtime')",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap_or(0)
        })
        .unwrap_or(0);

    // 划词监听开关以 config.selection_on 为唯一真相源
    let enabled = crate::config::load_config().selection_on;
    let status_text = toggle_label(enabled);

    // 局部更新菜单文案:仅对缓存的句柄 set_text,不重建完整菜单
    if let Ok(guard) = STATUS_ITEM.lock() {
        if let Some(item) = guard.as_ref() {
            let _ = item.set_text(pad(&status_text));
        }
    }
    if let Ok(guard) = TODAY_ITEM.lock() {
        if let Some(item) = guard.as_ref() {
            let _ = item.set_text(pad(&format!("今日已总结 {today_count} 次")));
        }
    }
}

/// 前端保存历史后调用,刷新今日次数
#[tauri::command]
pub fn tray_refresh(app: tauri::AppHandle) -> AppResult<()> {
    refresh_tray(&app);
    Ok(())
}
