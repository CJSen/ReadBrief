use crate::error::AppResult;
use std::sync::Mutex;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager,
};

static TRAY: Mutex<Option<tauri::tray::TrayIcon>> = Mutex::new(None);

/// 托盘可变菜单项句柄缓存(Tauri 2 的 TrayIcon 无 menu() getter,需保存句柄做局部 set_text 更新)
static STATUS_ITEM: Mutex<Option<MenuItem<tauri::Wry>>> = Mutex::new(None);
static TODAY_ITEM: Mutex<Option<MenuItem<tauri::Wry>>> = Mutex::new(None);
static PAUSE_ITEM: Mutex<Option<MenuItem<tauri::Wry>>> = Mutex::new(None);

/// 托盘菜单项 id 常量
const ID_STATUS: &str = "status";
const ID_TODAY: &str = "today";
const ID_PAUSE: &str = "toggle_pause";

pub fn setup_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let status_item = MenuItem::with_id(app, ID_STATUS, "划词监听已开启", true, None::<&str>)?;
    let today_item = MenuItem::with_id(app, ID_TODAY, "今日已总结 0 次", true, None::<&str>)?;
    let open_main_item = MenuItem::with_id(app, "open_main", "打开主窗口", true, Some("CmdOrCtrl+Shift+H"))?;
    let paste_item = MenuItem::with_id(app, "paste", "粘贴并总结", true, Some("CmdOrCtrl+Shift+V"))?;
    let separator = tauri::menu::PredefinedMenuItem::separator(app)?;
    let pause_item = MenuItem::with_id(app, ID_PAUSE, "暂停划词监听", true, None::<&str>)?;
    let settings_item = MenuItem::with_id(app, "settings", "设置", true, Some("CmdOrCtrl+,"))?;
    let quit_item = MenuItem::with_id(app, "quit", "退出", true, Some("CmdOrCtrl+Q"))?;

    let menu = Menu::with_items(
        app,
        &[
            &status_item,
            &today_item,
            &open_main_item,
            &separator,
            &paste_item,
            &separator,
            &pause_item,
            &settings_item,
            &quit_item,
        ],
    )?;

    // 缓存可变菜单项句柄(供 refresh_tray 局部 set_text)
    if let Ok(mut g) = STATUS_ITEM.lock() {
        *g = Some(status_item.clone());
    }
    if let Ok(mut g) = TODAY_ITEM.lock() {
        *g = Some(today_item.clone());
    }
    if let Ok(mut g) = PAUSE_ITEM.lock() {
        *g = Some(pause_item.clone());
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
            "open_main" => {
                let _ = crate::windows::show_main(app.clone());
            }
            "paste" => {
                let _ = app.emit("tray-paste", ());
                crate::windows::show_float(app);
            }
            "toggle_pause" => {
                let paused = !crate::shortcuts::is_capture_paused();
                crate::shortcuts::set_capture_paused(paused);
                let _ = app.emit(
                    if paused { "capture-paused" } else { "capture-resumed" },
                    (),
                );
                refresh_tray(app);
            }
            "settings" => {
                let _ = crate::windows::open_settings(app.clone());
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        });

    // 图标缺失不 panic:有图标用图标,否则用空白托盘(仅记录警告)
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    } else {
        log::warn!("未找到默认窗口图标,托盘将显示空白图标");
    }

    let tray = builder.build(app)?;

    if let Ok(mut guard) = TRAY.lock() {
        *guard = Some(tray);
    }
    Ok(())
}

/// 刷新托盘菜单文案(监听状态 / 今日次数 / 暂停项)
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

    let paused = crate::shortcuts::is_capture_paused();

    // 局部更新菜单文案:仅对缓存的句柄 set_text,不重建完整菜单
    let status_text = if paused {
        "划词监听已暂停"
    } else {
        "划词监听已开启"
    };
    let pause_text = if paused { "恢复划词监听" } else { "暂停划词监听" };

    if let Ok(guard) = STATUS_ITEM.lock() {
        if let Some(item) = guard.as_ref() {
            let _ = item.set_text(status_text);
        }
    }
    if let Ok(guard) = TODAY_ITEM.lock() {
        if let Some(item) = guard.as_ref() {
            let _ = item.set_text(format!("今日已总结 {today_count} 次"));
        }
    }
    if let Ok(guard) = PAUSE_ITEM.lock() {
        if let Some(item) = guard.as_ref() {
            let _ = item.set_text(pause_text);
        }
    }
}

/// 前端保存历史后调用,刷新今日次数
#[tauri::command]
pub fn tray_refresh(app: tauri::AppHandle) -> AppResult<()> {
    refresh_tray(&app);
    Ok(())
}
