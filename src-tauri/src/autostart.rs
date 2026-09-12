//! 开机自启动的系统层辅助(macOS / Windows)。
//!
//! `tauri-plugin-autostart` 只负责写「注册文件」:
//! - macOS:`~/Library/LaunchAgents/<label>.plist`
//! - Windows:`HKCU\...\CurrentVersion\Run` 下的同名值
//!
//! 但两个系统都**另有**一层独立于该文件的开关,由用户在系统设置里控制,可让注册文件形同虚设:
//! - macOS:launchd 覆盖表(`launchctl print-disabled gui/<uid>`),
//!   对应「系统设置 → 通用 → 登录项与扩展 → 允许在后台」;
//! - Windows:`...\Explorer\StartupApproved\Run` 下的二进制值(末 8 字节全 0 = 启用,否则禁用),
//!   对应「任务管理器 → 启动」。
//!
//! 被这层禁用时,插件的 `is_enabled()` 表现并不一致:macOS 仍返回 `true`(它只看 plist 是否
//! 存在),Windows 返回 `false`(auto-launch 已合并任务管理器判定)。于是启动对账若只看
//! `is_enabled()`:macOS 会把「被禁用」误判为「已开启」而永不修复;Windows 会把「用户禁用」
//! 误判为「注册丢失」而**把用户的禁用改回去**。两种都错。故统一提供 `disabled_by_system()`,
//! 让上层看清系统层的真实意愿。
//!
//! 由此分出两个方向:
//! - **读取**(`disabled_by_system`):供状态判断用,让「注册文件在」不再被误当成「已开启」;
//! - **写入**(`ensure_enabled`):只在**用户在应用内显式打开开关**时调用
//!   (`commands::autostart_set(true)`)。启动对账不调用它 —— 系统层里的禁用标记代表
//!   「用户在系统设置里关掉了」,是真实意愿,应用不该在启动时偷偷改回去。
//!
//! 唯一保留的「改系统」场景是**注册彻底缺失且系统层无禁用痕迹**:那是升级/清理导致的丢失
//! (Windows 手动升级时 NSIS 走 uninstall+reinstall 会删掉 `Run` 值),不是意愿,由对账按配置重建。

#[cfg(target_os = "macos")]
use std::process::Command;

/// macOS:launchd 中本应用任务所在的域(当前登录用户的 GUI 域)
#[cfg(target_os = "macos")]
fn domain() -> String {
    format!("gui/{}", unsafe { libc::getuid() })
}

/// 读系统层覆盖设置:`Some(true)`=被禁用 / `Some(false)`=明确启用 / `None`=读不到(交由调用方决定)
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

/// 判定 `StartupApproved\Run` 的原始值是否表示「已被任务管理器禁用」。
///
/// 规则镜像 `auto-launch` 的 `last_eight_bytes_all_zeros`:**末 8 字节全 0 = 启用**,否则禁用。
/// 真实取值是 12 字节:启用为 `02 00 00 00` + 8 字节 0;禁用为 `03 00 00 00` + 8 字节禁用时间戳。
/// 长度不足 8 时返回 `None`,由调用方按「未禁用」处理(与插件的 `unwrap_or(true)` 保持一致)。
#[cfg_attr(not(windows), allow(dead_code))]
fn is_disabled_blob(bytes: &[u8]) -> Option<bool> {
    if bytes.len() < 8 {
        return None;
    }
    Some(!bytes.iter().rev().take(8).all(|b| *b == 0))
}

/// Windows:读「任务管理器 → 启动」写入的覆盖值。
///
/// 这里刻意复用与插件相同的判定规则,避免双方对「是否禁用」的理解产生分歧。
#[cfg(windows)]
fn overrides_disabled(label: &str) -> Option<bool> {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ};
    use winreg::RegKey;
    const OVERRIDE_KEY: &str =
        r"SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";
    let bytes = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey_with_flags(OVERRIDE_KEY, KEY_READ)
        .ok()?
        .get_raw_value(label)
        .ok()?
        .bytes;
    Some(is_disabled_blob(&bytes).unwrap_or(false))
}

/// 系统层是否明确禁用了本应用的自启动(其它平台恒为 false)
#[cfg(any(target_os = "macos", windows))]
pub fn disabled_by_system(label: &str) -> bool {
    overrides_disabled(label).unwrap_or(false)
}

#[cfg(not(any(target_os = "macos", windows)))]
pub fn disabled_by_system(_label: &str) -> bool {
    false
}

/// 让系统层的自启动注册对齐到「启用」意图:清掉系统设置里残留的禁用标记。
///
/// **调用约束**:仅在用户在应用内显式打开开关时调用(见 `commands::autostart_set`)。
/// 系统层的禁用标记等价于「用户在系统设置里关掉了」,启动对账不得调用本函数去覆盖它。
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

/// Windows 无需额外动作:`auto-launch` 的 `enable()` 本就同时写 `Run` 值与 `StartupApproved\Run`
/// (写回全 0 的启用值),禁用标记会被一并清掉。其余平台同理。
#[cfg(not(target_os = "macos"))]
pub fn ensure_enabled(_label: &str) {}

#[cfg(test)]
mod tests {
    use super::is_disabled_blob;

    /// auto-launch 的 `TASK_MANAGER_OVERRIDE_ENABLED_VALUE`:0x02 开头 + 后 11 字节 0
    const ENABLED_BLOB: [u8; 12] = [0x02, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

    #[test]
    fn enabled_blob_is_not_disabled() {
        assert_eq!(is_disabled_blob(&ENABLED_BLOB), Some(false));
    }

    #[test]
    fn disabled_blob_is_detected() {
        // 禁用形态:0x03 开头 + 8 字节禁用时间戳(末 8 字节非全 0)
        let mut blob = ENABLED_BLOB;
        blob[0] = 0x03;
        blob[8] = 0x5a;
        assert_eq!(is_disabled_blob(&blob), Some(true));
    }

    #[test]
    fn only_leading_bytes_are_ignored() {
        // 第 1 字节(版本位)不参与判定:改它不应被误判为禁用
        let mut blob = ENABLED_BLOB;
        blob[0] = 0xff;
        assert_eq!(is_disabled_blob(&blob), Some(false));
    }

    #[test]
    fn short_blob_is_unknown() {
        assert_eq!(is_disabled_blob(&[0u8; 4]), None);
    }
}
