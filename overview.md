# i18n 补全：浮窗 / 主窗口 / 设置页（含三子页）

## 背景
用户指出浮窗、主窗口、设置页（含 AI 服务 / 提示词 / 快捷键三个子页）大量文案硬编码中文、未做 i18n 适配或适配不全，英文界面下混显中文。

## 改动范围
- **字典扩展** `src/lib/i18n/index.ts`：zh / en 双份，新增约 130 个 key（`float` / `prompts` / `shortcuts` / `settings` / `ai` / `update` 命名空间）。en 受 `typeof zh` 约束，字段不齐编译即报错。
- **6 个组件**全部改为 `t()` 取值，并加 `useLanguage()` 订阅，切界面语言即时重渲染：
  - `AppFloat.tsx`（浮窗标题/未授权/发送/停止/重新生成/错误图例等）
  - `AppMain.tsx`（侧栏/时间筛选/字数/更新弹窗等）
  - `AppSettings.tsx`（通用/外观/隐私/关于 全部文案）
  - `AiServicesPage.tsx`（服务列表/表单/测速/删除确认）
  - `PromptManager.tsx`（标题/新建编辑器/标签/按钮）
  - `ShortcutsPage.tsx`（内置项 name/desc + 系统快捷键名改为 i18n key；录制区/对话框/冲突提示）

## 判定原则（哪些故意不动）
- `SUMMARY_LANGUAGES` 的 `label`（简体中文 / English / 日本語…）是各语言**母语名**，下拉应显示母语名，符合主流软件做法，保持原样。
- `BUILTIN_PROMPTS` 的 name、`TAG_LABELS` 分类名属**用户数据**，非 UI 文案，保持原样。
- 代码注释与 `console.warn` 日志面向开发者，不翻译。

## 验证
- `tsc --noEmit`：无错误
- `eslint`：干净
- 纯前端改动，`npm run tauri dev` 即可验证中英文切换效果。

## 未提交
改动未提交（用户未要求）。涉及文件：`src/lib/i18n/index.ts` + 上述 6 个组件。

## AI 服务「参数覆盖」功能（2026-09-04）
- 目的：让用户可通过 JSON 自定义请求参数（如关闭思考模型）解决 thinking 拖慢划词总结的问题。
- 数据：`ApiConfig.extra_params: Option<String>`（config.json 深合并进请求体；留空不附加）。
- Rust：`ai.rs` 新增 `merge_json`（深合并）+ `parse_extra_params`（保留字段过滤 / 非法 JSON 降级跳过，绝不阻断总结请求）。
- UI：服务编辑表单模型行与流式输出行之间新增「参数覆盖」textarea；`?` hover 显示各协议关闭思考参数速查表；下方单一提示位（常显说明 / 校验错误 / 保留字段警告）。
- 预填：仅 deepseek 协议预填 `{"thinking":{"type":"disabled"}}`，其余留空。
- i18n 中英各 8 词条；新增 `.rb-tip-wide`、`.rb-svc-params*` 样式。
- 验证：tsc 0 错误、cargo check --lib 通过。未提交。
