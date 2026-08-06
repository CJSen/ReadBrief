import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { AppConfig } from "./types";

/**
 * 配置读写 hook(P2-7):收敛 AppMain / AppSettings / AppFloat 三处重复的
 * config_get 加载 + config-changed 订阅逻辑,并提供统一的保存入口。
 *
 * - cfg: 当前配置(null = 尚未加载)
 * - save: 持久化并同步到本组件状态(其余窗口经 config-changed 事件同步)
 * - ref: 始终最新的配置引用(供事件回调等非渲染上下文读取,避免闭包过期)
 */
export function useConfig() {
  const [cfg, setCfg] = useState<AppConfig | null>(null);
  const ref = useRef<AppConfig | null>(null);

  useEffect(() => {
    invoke<AppConfig>("config_get")
      .then((c) => {
        setCfg(c);
        ref.current = c;
      })
      .catch(() => setCfg(null));

    const unlisten = listen<AppConfig>("config-changed", (event) => {
      setCfg(event.payload);
      ref.current = event.payload;
    });

    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  const save = useCallback(async (next: AppConfig) => {
    await invoke("config_save", { cfg: next });
    setCfg(next);
    ref.current = next;
  }, []);

  return { cfg, ref, save };
}
