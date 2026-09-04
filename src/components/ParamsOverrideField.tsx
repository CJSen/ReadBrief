import { useState, useRef } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icon";
import { t, useLanguage } from "../lib/i18n";
import { checkParams } from "../lib/ai/paramsOverride";

interface ParamsOverrideFieldProps {
  value: string;
  onChange: (v: string) => void;
  /** row = 设置页 set-row(标签左 / 控件右);stack = 引导页(标签上 / 控件下) */
  layout?: "row" | "stack";
  textareaRows?: number;
}

/**
 * 「参数覆盖」输入控件(JSON 文本,深合并进 AI 请求体)。
 * 设置页与引导页共用同一实现,避免两处逻辑漂移。
 * 纯受控输入:预填/动态默认已迁至快捷键级(ShortcutsPage + Rust shortcuts.rs),此处不做注入。
 */
export function ParamsOverrideField({
  value,
  onChange,
  layout = "row",
  textareaRows = 3,
}: ParamsOverrideFieldProps) {
  useLanguage();
  const [zoomOpen, setZoomOpen] = useState(false);
  /** ? 说明:portal 到 body 居中显示(面板 overflow:auto 会裁剪 absolute tooltip) */
  const [tipOpen, setTipOpen] = useState(false);
  const zoomGutterRef = useRef<HTMLDivElement>(null);

  const issue = checkParams(value);
  const issueText = issue ? issue.text : t("ai.paramsNote");
  const issueClass = issue
    ? issue.level === "error"
      ? "rb-svc-params-err"
      : "rb-svc-params-warn"
    : "rb-svc-params-note";

  const label = (
    <>
      <div className="flex ac g6" style={{ whiteSpace: "nowrap" }}>
        {t("ai.params")}
        {/* 注意:不能复用 .rb-seg 类名 —— App.css:715 历史页同名规则(width:100% + span flex:1)会把 ? 拉成椭圆 */}
        <span onMouseEnter={() => setTipOpen(true)} onMouseLeave={() => setTipOpen(false)}>
          <span className="rb-q">?</span>
        </span>
      </div>
      <div className={layout === "row" ? "muted rb-setting-hint" : "muted rb-ob-field-hint"}>
        {t("ai.paramsHint")}
      </div>
    </>
  );

  const control = (
    <div className="rb-svc-params-wrap">
      <textarea
        className="inp mono rb-svc-params"
        rows={textareaRows}
        spellCheck={false}
        value={value}
        placeholder={t("ai.paramsPlaceholder")}
        onChange={(e) => onChange(e.currentTarget.value)}
      />
      <button className="rb-svc-params-expand" title={t("ai.paramsZoomTitle")} onClick={() => setZoomOpen(true)}>
        <Icon name="maximize" size={13} />
      </button>
      {/* 单一提示位:校验问题优先,无问题时显示常显风险说明 */}
      <div className={issueClass}>{issueText}</div>
      {/* 放大编辑器:portal 到 body,行号 + 大面积输入,编辑实时同步到表单 */}
      {zoomOpen
        ? createPortal(
            <div
              className="rb-params-zoom-overlay"
              onMouseDown={(e) => {
                if (e.target === e.currentTarget) setZoomOpen(false);
              }}
            >
              <div className="rb-params-zoom">
                <div className="rb-params-zoom-hd">
                  <span>{t("ai.paramsZoomTitle")}</span>
                  <button className="iconbtn" onClick={() => setZoomOpen(false)}>
                    <Icon name="close" size={14} />
                  </button>
                </div>
                <div className="rb-params-zoom-body">
                  <div className="rb-params-zoom-gutter" ref={zoomGutterRef}>
                    {value.split("\n").map((_, i) => (
                      <div key={i}>{i + 1}</div>
                    ))}
                  </div>
                  <textarea
                    className="rb-params-zoom-input"
                    spellCheck={false}
                    value={value}
                    onChange={(e) => onChange(e.currentTarget.value)}
                    onScroll={(e) => {
                      if (zoomGutterRef.current) {
                        zoomGutterRef.current.scrollTop = e.currentTarget.scrollTop;
                      }
                    }}
                  />
                </div>
                <div className="rb-params-zoom-ft">
                  <span className={issueClass}>{issueText}</span>
                  <button className="btn btn-primary btn-sm" onClick={() => setZoomOpen(false)}>
                    {t("ai.paramsZoomDone")}
                  </button>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
      {/* ? 说明 tooltip:portal 到 body,画面居中显示 */}
      {tipOpen
        ? createPortal(<div className="rb-params-tip-fixed">{t("ai.paramsTip")}</div>, document.body)
        : null}
    </div>
  );

  if (layout === "stack") {
    return (
      <div className="rb-ob-field">
        <div className="rb-ob-field-label">{label}</div>
        {control}
      </div>
    );
  }
  return (
    <div className="set-row">
      {/* 限宽 140:hint 折 2-3 行,让 JSON 输入框拿到与其他选项一致的 300px 宽度 */}
      <div className="set-row-label" style={{ maxWidth: 140 }}>
        {label}
      </div>
      {control}
    </div>
  );
}
