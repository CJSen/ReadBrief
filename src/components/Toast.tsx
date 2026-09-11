import { useEffect, useState } from "react";
import { Icon } from "./Icon";

export interface ToastState {
  text: string;
  ok: boolean;
}

/**
 * 设置页轻量提示条(设计规范 §2.4 浮窗级容器:12px 圆角 + 景深阴影)。
 * 4s 后自动消失;每个 tab 各自持有实例(与 PrivacyPage 内联实现同款)。
 */
export function useToast() {
  const [toast, setToast] = useState<ToastState | null>(null);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(timer);
  }, [toast]);

  const toastNode = toast ? (
    <div className="rb-toast rb-toast-static">
      <Icon
        className={`rb-toast-icon rb-toast-icon--${toast.ok ? "ok" : "err"}`}
        name={toast.ok ? "check" : "alert"}
        size={15}
      />
      {toast.text}
    </div>
  ) : null;

  return { toast, showToast: setToast, toastNode };
}

/** 提取 invoke 失败原因(Error 或字符串两种形态) */
export function errText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}
