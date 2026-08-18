/**
 * 极简、安全的 Markdown → HTML 渲染，仅用于更新说明（Release body）。
 * 先整体转义 HTML，再做有限的块级/行内格式化，避免 XSS。
 */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function inline(s: string): string {
  // 链接 [text](url)
  s = s.replace(
    /\[([^\]]+)\]\(([^)\s]+)\)/g,
    (_m, text: string, href: string) => `<a href="${href}" target="_blank" rel="noreferrer">${text}</a>`,
  );
  // 加粗 **text**
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  // 行内代码 `code`
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  return s;
}

/** 由 dmg 文件名推断架构中文标签 */
export function archLabel(name: string): string {
  const n = name.toLowerCase();
  if (n.includes("aarch64") || n.includes("arm64") || n.includes("apple")) return "Apple 芯片";
  if (n.includes("x86_64") || n.includes("intel") || n.includes("x64")) return "Intel";
  return name;
}

export function renderMarkdown(md: string): string {
  const lines = escapeHtml(md).split(/\r?\n/);
  const html: string[] = [];
  let listTag: "ul" | "ol" | null = null;
  const closeList = () => {
    if (listTag) {
      html.push(`</${listTag}>`);
      listTag = null;
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      closeList();
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      closeList();
      const lvl = h[1].length;
      html.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`);
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      if (listTag !== "ul") {
        closeList();
        html.push("<ul>");
        listTag = "ul";
      }
      html.push(`<li>${inline(line.replace(/^\s*[-*]\s+/, ""))}</li>`);
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      if (listTag !== "ol") {
        closeList();
        html.push("<ol>");
        listTag = "ol";
      }
      html.push(`<li>${inline(line.replace(/^\s*\d+\.\s+/, ""))}</li>`);
      continue;
    }
    closeList();
    html.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  return html.join("");
}
