import { useEffect, useRef, useState } from "react";
import { checkUpdate, type UpdateInfo } from "./checkUpdate";

/** 被动更新检查的轮询间隔：每 24 小时一次(macOS 用户常挂后台,启动检查已覆盖刚打开的窗口期;远低于 GitHub 匿名 60 次/小时限流) */
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * 本地预览开关：测试「发现新版本」右下角弹窗。
 * 设为 true 后启动会强制弹出更新提示（无需真实 GitHub Release 高于本地版本）。
 * 预览完请改回 false 再提交。
 */
const DEV_TEST_UPDATE_POPUP = false;

/** 本地预览用的假更新数据(与真实 UpdateInfo 结构一致) */
const DEV_FAKE_INFO: UpdateInfo = {
  hasUpdate: true,
  currentVersion: "0.9.5",
  latestVersion: "1.2.0",
  releaseUrl: "https://github.com/CJSen/ReadBrief/releases/download/v1.2.0/ReadBrief_aarch64.dmg",
  releaseName: "v1.2.0",
  releaseNotes:
    "## 更新内容\n\n- 新增轻量版更新检查（自动匹配本机架构）\n- 关于页可「查看更新」查看更新说明\n- 修复若干已知问题\n\n详情见 [Release 页面](https://github.com/CJSen/ReadBrief/releases/tag/v1.2.0)",
  platformAssets: [
    { name: "ReadBrief_aarch64.dmg", url: "https://github.com/CJSen/ReadBrief/releases/download/v1.2.0/ReadBrief_aarch64.dmg" },
    { name: "ReadBrief_x86_64.dmg", url: "https://github.com/CJSen/ReadBrief/releases/download/v1.2.0/ReadBrief_x86_64.dmg" },
  ],
  error: null,
  hint: null,
};

/**
 * 右下角「发现新版本」弹窗的共用逻辑(主窗口与 AI 总结浮窗同款):
 * - 挂载即查一次(GitHub Releases 轻量检查,不下载/不安装) + 每 24h 静默轮询
 * - 有更新且同版本只提示一次(notifiedVersionRef),避免轮询反复打扰
 * - 失败/已是最新无感(仅控制台警告)
 */
export function useUpdatePopup() {
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [showUpdatePopup, setShowUpdatePopup] = useState(false);
  /** 已弹出过提示的版本号:同版本只提示一次 */
  const notifiedVersionRef = useRef<string | null>(null);

  useEffect(() => {
    let alive = true;

    const runCheck = () => {
      checkUpdate()
        .then((info) => {
          if (!alive) return;
          setUpdateInfo(info);
          if (
            info.hasUpdate &&
            info.latestVersion &&
            info.latestVersion !== notifiedVersionRef.current
          ) {
            notifiedVersionRef.current = info.latestVersion;
            setShowUpdatePopup(true);
          } else if (info.error) {
            console.warn("[update] 检查失败：", info.error, info.hint ?? "");
          }
        })
        .catch((e) => console.warn("[update] 检查异常：", e));
    };

    // 本地预览：强制弹出更新提示，无需真实 Release
    if (DEV_TEST_UPDATE_POPUP) {
      if (alive) {
        setUpdateInfo(DEV_FAKE_INFO);
        notifiedVersionRef.current = DEV_FAKE_INFO.latestVersion;
        setShowUpdatePopup(true);
      }
      return () => {
        alive = false;
      };
    }

    runCheck();
    const timer = setInterval(runCheck, UPDATE_CHECK_INTERVAL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  return {
    updateInfo,
    showUpdatePopup,
    /** 关闭弹窗(不阻止下次新版本再弹) */
    hideUpdatePopup: () => setShowUpdatePopup(false),
  };
}
