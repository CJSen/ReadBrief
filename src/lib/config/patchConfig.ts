import { invoke } from "@tauri-apps/api/core";
import type { AppConfig } from "./types";

/**
 * 配置的**字段级**保存入口(取代「整份 AppConfig 覆盖写」)。
 *
 * 为什么用 patch 而不是整份:
 * 组件手里持有的 `cfg` 是渲染那一刻的快照,整份写回时,快照里那些**用户没动过**
 * 的字段会用旧值覆盖磁盘 —— 典型场景是设置窗口与托盘同时改不同字段:托盘写了
 * selectionOn,设置窗口随后保存主题时把它一并覆盖回旧值。
 * patch 只发送本次真正改动的字段,Rust 侧读盘再合并,从根上消除这种互相覆盖。
 *
 * 为什么需要串行队列:
 * patch 本身解决了「覆盖其它字段」,但**同一字段(数组)**连续两次写入仍要看谁先
 * 到达 Rust。前端不做串行化时,两次 invoke 的完成顺序不保证 → 后发的可能先落盘。
 * 这里用一个模块级 promise 链把同窗口内的保存串成一条线,保证先调用先落盘。
 */
let queue: Promise<unknown> = Promise.resolve();

/**
 * 变更字段集合。允许 `null` 用于**清空可选字段**(如 onboardingStep):
 * JSON 序列化会丢掉 `undefined` 的键,发不出「删除该字段」这个意图,而 null 能。
 */
export type ConfigPatch = Partial<{
  [K in keyof AppConfig]: AppConfig[K] | null;
}>;

/**
 * 保存配置的变更字段,返回**合并后的权威配置**(应以它更新本地 state)。
 *
 * @param patch 只包含本次改动的字段。值为 `undefined` 的键会被 JSON 序列化丢弃,
 *              等价于「不改该字段」,调用方无需手动剔除。
 */
export function patchConfig(patch: ConfigPatch): Promise<AppConfig> {
  const task = () => invoke<AppConfig>("config_patch", { patch });
  // 前一个任务无论是成功还是失败,都不应阻塞后续保存
  const run = queue.then(task, task);
  // 队列自身吞掉 rejection(否则会冒泡成 unhandledrejection);
  // 错误仍然通过返回的 promise 抛给调用方处理
  queue = run.catch(() => undefined);
  return run;
}
