// 主窗口 / 设置页左上角的 logo mark:统一为 Solid 风格(渐变实底 + 白横条 + 荧光黄选中段 + 双白圆点)
// 与官网 favicon / 应用图标保持一致;通过 inline style 控制尺寸以覆盖 .rb-logo-icon 的固定尺寸
import { useId } from "react";

interface LogoMarkProps {
  size?: number;
  className?: string;
}

export function LogoMark({ size = 20, className }: LogoMarkProps) {
  const gid = "lg" + useId().replace(/:/g, "");
  return (
    <svg
      className={className}
      style={{ width: size, height: size }}
      viewBox="0 0 256 256"
      fill="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#5454D6" />
          <stop offset="1" stopColor="#4B4BC8" />
        </linearGradient>
      </defs>
      {/* 渐变实底圆角卡片 */}
      <rect width="256" height="256" rx="56" fill={`url(#${gid})`} />
      {/* 四根文字线(白) */}
      <rect x="71" y="73" width="114" height="17" rx="8.5" fill="#FFFFFF" opacity="0.96" />
      <rect x="71" y="102" width="100" height="17" rx="8.5" fill="#FFFFFF" opacity="0.96" />
      <rect x="71" y="131" width="114" height="17" rx="8.5" fill="#FFFFFF" opacity="0.96" />
      <rect x="71" y="160" width="75" height="17" rx="8.5" fill="#FFFFFF" opacity="0.72" />
      {/* 第二根中间荧光黄高亮段(划词标记语义) */}
      <rect x="85" y="102" width="52.5" height="17" rx="8.5" fill="#E5A733" />
      {/* 双白圆点卡在黄段两端 */}
      <circle cx="85" cy="110.5" r="6.5" fill="#FFFFFF" />
      <circle cx="137.5" cy="110.5" r="6.5" fill="#FFFFFF" />
    </svg>
  );
}
