//! 开机自启动的系统层辅助(macOS)。
//!
//! `tauri-plugin-autostart` 在 macOS 上靠「写 `~/Library/LaunchAgents/<label>.plist`」实现,
//! 其 `is_enabled()` 也**只看该文件是否存在**。但 launchd 另有一张覆盖表
//! (`launchctl print-disabled gui/<uid>`):一旦 `<label>` 被置为 `disabled`
//! —— 在「系统设置 → 通用 → 登录项与扩展 → 允许在后台」里被关掉,或被 App Cleaner
//! 一类清理工具误关 —— 登录时 launchd 会**直接跳过**这个 plist。
//!
//! 这带来两个必须分开处理的方向:
//! - **读取**(`disabled_by_launchd`):供状态判断用,让「注册文件在」不再被误当成「已开启」;
//! - **写入**(`ensure_enabled`):只在**用户在应用内显式打开开关**时调用
//!   (`commands::autostart_set(true)`)。启动对账不调用它 —— 覆盖表里的禁用位代表
//!   「用户在系统设置里关掉了」,是真实意愿,应用不该在启动时偷偷改回去。

#[cfg(target_os = "macos")]
use std::process::Command;

/// launchd 中本应用任务所在的域(当前登录用户的 GUI 域)
#[cfg(target_os = "macos")]
fn domain() -> String {
    format!("gui/{}", unsafe { libc::getuid() })
}

/// 读覆盖表:`Some(true)`=被禁用 / `Some(false)`=明确启用 / `None`=读不到(交由调用方决定)
#[cfg(target_os = "macos")]
fn overrides_disabled(label: &str) -> Option<bool> {
    let out = Command::new("launchctl")
        .args(["print-disabled", &domain()])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let needle = format!("\"{label}\"");
    // 行形如: `\t\t"ReadBrief" => disabled`,按行首匹配标签,避免误命中其它服务
    text.lines()
        .find(|l| l.trim_start().starts_with(&needle))
        .map(|l| l.contains("disabled"))
}

/// 系统层是否明确禁用了本应用的自启动任务(macOS 之外恒为 false)
#[cfg(target_os = "macos")]
pub fn disabled_by_launchd(label: &str) -> bool {
    overrides_disabled(label).unwrap_or(false)
}

#[cfg(not(target_os = "macos"))]
pub fn disabled_by_launchd(_label: &str) -> bool {
    false
}

/// 让系统层的自启动注册对齐到「启用」意图:清掉 launchd 覆盖表中残留的 `disabled` 位。
///
/// **调用约束**:仅在用户在应用内显式打开开关时调用(见 `commands::autostart_set`)。
/// 覆盖表里的禁用位等价于「用户在系统设置里关掉了」,启动对账不得调用本函数去覆盖它。
///
/// 幂等;失败只告警不阻断 —— 自启动属增强能力,不能拖垮调用方。
/// 已在启用态时零干预(常态仅多一次只读查询,不写系统状态)。
#[cfg(target_os = "macos")]
pub fn ensure_enabled(label: &str) {
    if overrides_disabled(label) == Some(false) {
        return;
    }
    let target = format!("{}/{}", domain(), label);
    match Command::new("launchctl").args(["enable", &target]).output() {
        // warn 级:该行在任何日志配置下都会落盘,便于远程支持时确认「自愈发生过」
        Ok(o) if o.status.success() => {
            log::warn!("用户在应用内开启开机启动,已清除系统层的禁用标记: {target}")
        }
        Ok(o) => log::warn!(
            "恢复开机自启动失败: {}",
            String::from_utf8_lossy(&o.stderr).trim()
        ),
        Err(e) => log::warn!("无法执行 launchctl 恢复开机自启动: {e}"),
    }
}

#[cfg(not(target_os = "macos"))]
pub fn ensure_enabled(_label: &str) {}
