import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

interface ScreenshotInfo {
  imageBase64: string;
  screenWidth: number;
  screenHeight: number;
  scaleFactor: number;
}

export function OcrOverlay() {
  // 初始无图片，不渲染任何内容（避免闪旧图）
  const [image, setImage] = useState<string>("");
  const [tip, setTip] = useState("");
  // 冻结图是否已解码完成（img onLoad）。提示文字等图片同帧出现,
  // 避免超时兜底路径下提示先于冻结图渲染。
  const [ready, setReady] = useState(false);

  // 用 ref 存储拖拽状态，避免 React 重渲染
  const dragRef = useRef<{
    active: boolean;
    startX: number;
    startY: number;
    endX: number;
    endY: number;
  }>({ active: false, startX: 0, startY: 0, endX: 0, endY: 0 });

  // DOM ref：直接操作选区矩形（每帧 rAF 更新，绕过 React 重渲染）
  const selectionRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef(0);

  // 更新选区 DOM（在 rAF 中批量更新，避免每帧多次重绘）
  const updateSelectionDOM = useCallback(() => {
    const sel = selectionRef.current;
    if (!sel) return;

    const d = dragRef.current;
    if (!d.active) {
      sel.style.display = "none";
      return;
    }

    const x = Math.min(d.startX, d.endX);
    const y = Math.min(d.startY, d.endY);
    const w = Math.abs(d.endX - d.startX);
    const h = Math.abs(d.endY - d.startY);

    if (w < 3 || h < 3) {
      sel.style.display = "none";
      return;
    }

    sel.style.display = "block";
    sel.style.left = `${x}px`;
    sel.style.top = `${y}px`;
    sel.style.width = `${w}px`;
    sel.style.height = `${h}px`;
  }, []);

  // rAF 循环：每帧只更新一次 DOM
  const scheduleUpdate = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(updateSelectionDOM);
  }, [updateSelectionDOM]);

  // 通知 Rust「首帧已真正上屏」——双 rAF 保证冻结图已完成合成。
  // Rust 侧在此之前把窗口保持 alpha=0，收到信号后才恢复 alpha=1，
  // 从而杜绝 orderFront 与首帧提交之间的白底/空白一闪。
  const reportPainted = useCallback(() => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        void invoke("notify_overlay_painted");
      });
    });
  }, []);

  // 图片加载完成：提示可显示 + 通知 Rust 显示 overlay 窗口
  const handleImageLoad = useCallback(() => {
    setReady(true);
    void invoke("notify_overlay_ready");
    reportPainted();
  }, [reportPainted]);

  // 图片加载失败：同样放行（显示提示，用户可 Esc 退出），避免透明窗口卡死无反馈
  const handleImageError = useCallback(() => {
    setReady(true);
    void invoke("notify_overlay_ready");
    reportPainted();
  }, [reportPainted]);

  // 监听 overlay 显示事件
  useEffect(() => {
    const unlisten = listen<ScreenshotInfo>("ocr-overlay-show", (event) => {
      const info = event.payload;
      // 设置图片（窗口还不会显示，等图片加载完成后 Rust 会显示）
      setReady(false);
      setImage(`data:image/png;base64,${info.imageBase64}`);
      setTip("拖拽框选要识别的区域 · Esc 取消");
      dragRef.current = { active: false, startX: 0, startY: 0, endX: 0, endY: 0 };
    });

    // 监听 overlay 隐藏事件（清空图片，避免下次闪旧图）
    const unlistenHide = listen("ocr-overlay-hide", () => {
      setImage("");
      setTip("");
      setReady(false);
      dragRef.current = { active: false, startX: 0, startY: 0, endX: 0, endY: 0 };
    });

    return () => {
      void unlisten.then((fn) => fn());
      void unlistenHide.then((fn) => fn());
    };
  }, []);

  // 键盘事件：ESC 取消
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        void invoke("cancel_screenshot_capture");
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // 清理 rAF
  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  // 鼠标按下：开始选区
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      active: true,
      startX: e.clientX,
      startY: e.clientY,
      endX: e.clientX,
      endY: e.clientY,
    };
    setTip("");
    scheduleUpdate();
  }, [scheduleUpdate]);

  // 鼠标移动：更新选区（只更新 ref，不触发重渲染）
  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current.active) return;
    dragRef.current.endX = e.clientX;
    dragRef.current.endY = e.clientY;
    scheduleUpdate();
  }, [scheduleUpdate]);

  // 鼠标松开：完成选区
  const handlePointerUp = useCallback(async (_e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d.active) return;
    d.active = false;

    const x = Math.min(d.startX, d.endX);
    const y = Math.min(d.startY, d.endY);
    const w = Math.abs(d.endX - d.startX);
    const h = Math.abs(d.endY - d.startY);

    if (w < 10 || h < 10) {
      scheduleUpdate();
      setTip("拖拽框选要识别的区域 · Esc 取消");
      return;
    }

    setTip("识别中...");
    // 选区保持可见(半透黑+边框)直到 Rust 隐藏窗口,给用户「正在识别这块」的持续反馈;
    // 屏幕整体保持原亮度,无任何亮度跳变。

    try {
      const result = await invoke<{ text: string }>("finish_screenshot_selection", {
        rect: { x, y, width: w, height: h },
      });

      const text = result.text;
      if (text.trim()) {
        await invoke("dispatch_ocr_result", { text });
      }
    } catch (err) {
      console.error("截图 OCR 失败:", err);
    }
  }, [scheduleUpdate]);

  // 无图片时不渲染（关键：避免闪旧图）
  if (!image) return null;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        cursor: "crosshair",
        userSelect: "none",
        zIndex: 99999,
        overflow: "hidden",
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={(e) => void handlePointerUp(e)}
    >
      {/* 冻结截图背景（底层） */}
      <img
        src={image}
        alt=""
        onLoad={handleImageLoad}
        onError={handleImageError}
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          objectFit: "fill",
          display: "block",
          pointerEvents: "none",
        }}
        draggable={false}
      />

      {/* 选区高亮层：半透黑填充 + 白边黑描边。
          视觉方案(反向于 macOS 系统截图):冻结屏保持原色(进入/退出无全屏亮度跳变,
          彻底消除「闪一下」),改用选区自身半透黑(30%,文字仍可读)+ 明显边框做反馈。
          白色边框外圈加 1px 黑描边,保证在纯白/纯黑底色上都清晰。 */}
      <div
        ref={selectionRef}
        style={{
          position: "absolute",
          display: "none",
          // 填充对齐 Easydict(ScreenshotOverlayView: stroke white 2 + black 0.1)：
          // 选区本身轻度过暗(0.12,文字仍可读)+ 白色 2px 描边;
          // 外圈再补 1px 深描边,保证在纯白/浅色截图内容上也清晰。
          backgroundColor: "rgba(0, 0, 0, 0.12)",
          border: "2px solid #fff",
          boxShadow: "0 0 0 1px rgba(0,0,0,0.55)",
          pointerEvents: "none",
          willChange: "left, top, width, height",
        }}
      />

      {/* 提示文字（与冻结图同帧出现） */}
      {tip && ready && (
        <div
          style={{
            position: "absolute",
            bottom: 40,
            left: "50%",
            transform: "translateX(-50%)",
            background: "rgba(0,0,0,0.75)",
            color: "#fff",
            padding: "10px 28px",
            borderRadius: 10,
            fontSize: 14,
            pointerEvents: "none",
            whiteSpace: "nowrap",
            backdropFilter: "blur(8px)",
          }}
        >
          {tip}
        </div>
      )}
    </div>
  );
}
