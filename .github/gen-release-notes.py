#!/usr/bin/env python3
"""生成 GitHub Release 说明（changelog）。

读取环境变量 GITHUB_REF_NAME（推送的 tag，如 v0.9.5 或 0.9.5），
将 release-notes.md 写到当前工作目录。供 .github/workflows/release.yml
的 create-release 作业调用，也可本地预览：

    GITHUB_REF_NAME=v0.9.5 python3 .github/gen-release-notes.py
"""
import os
import re
import subprocess
import sys


def main() -> int:
    ref = os.environ.get("GITHUB_REF_NAME", "")
    if not ref:
        print("GITHUB_REF_NAME 未设置", file=sys.stderr)
        return 1
    version = ref.removeprefix("v")

    tags = subprocess.check_output(["git", "tag", "--sort=-creatordate"]).decode().split()
    strip_v = lambda t: t.removeprefix("v")
    prev_tags = [t for t in tags if strip_v(t) != version]
    prev = prev_tags[0] if prev_tags else None
    rng = f"{prev}..{ref}" if prev else ref
    scope = f"相对上一个版本 {prev}" if prev else "首个公开发布版本"
    out = subprocess.check_output(
        ["git", "log", "--pretty=format:%s|%h", rng]
    ).decode().splitlines()

    groups = {
        "feat": ("✨ 新功能", []),
        "fix": ("🐛 问题修复", []),
        "perf": ("⚡ 性能优化", []),
        "refactor": ("♻️ 重构", []),
        "docs": ("📝 文档", []),
        "chore": ("🔧 杂项", []),
        "ci": ("⚙️ 持续集成", []),
        "style": ("🎨 样式", []),
        "test": ("✅ 测试", []),
    }
    other = []
    for line in out:
        if "|" not in line:
            continue
        subject, h = line.split("|", 1)
        m = re.match(r"^(\w+)(\(.+?\))?!?:\s*(.*)$", subject)
        if m and m.group(1) in groups:
            groups[m.group(1)][1].append((m.group(3), h))
        else:
            other.append((subject, h))

    L = []
    L.append(f"## ReadBrief v{version}")
    L.append("")
    L.append(f"> {scope} · 共 {len(out)} 条提交")
    L.append("")
    for _, (label, items) in groups.items():
        if items:
            L.append(f"### {label}")
            for msg, h in items:
                L.append(f"- {msg} (`{h[:7]}`)")
            L.append("")
    if other:
        L.append("### 📦 其他变更")
        for msg, h in other:
            L.append(f"- {msg} (`{h[:7]}`)")
        L.append("")
    L.append("## 📥 下载")
    L.append("")
    L.append(f"- **Intel (x86_64)**：`ReadBrief_{version}_x64.dmg`")
    L.append(f"- **Apple Silicon (M1 / M2 / M3)**：`ReadBrief_{version}_aarch64.dmg`")
    L.append("")
    L.append("## 📋 安装说明")
    L.append("")
    L.append("1. 下载与你的芯片对应的 `.dmg`，双击挂载。")
    L.append("   或在设置-隐私与安全性-拉到底-仍要打开-弹窗点击'仍要打开'; ")
    L.append("   或在终端执行以下命令解除隔离标记后重试：")
    L.append("")
    L.append("   ```bash")
    L.append("   xattr -cr <PATH_TO_DMG(直接将dmg文件拖入终端)>")
    L.append("   ```")
    L.append("2. 将 **ReadBrief** 拖入 `Applications` 文件夹。")
    L.append("3. 首次打开若提示“无法验证开发者”，右键点击 App → **打开**；")
    L.append("   或在设置-隐私与安全性-拉到底-仍要打开-弹窗点击'仍要打开'; ")
    L.append("   或在终端执行以下命令解除隔离标记后重试：")
    L.append("")
    L.append("   ```bash")
    L.append("   xattr -cr /Applications/ReadBrief.app")
    L.append("   ```")
    L.append("")
    L.append("> 当前为开发 / 免费阶段构建，未进行 Apple 公证（Notarization），属正常现象；")
    L.append("> 后续在仓库 Secrets 中配置 Apple 开发者证书后，即可自动签名 + 公证，消除该提示。")
    L.append("")
    L.append("---")
    L.append("")
    L.append("ReadBrief · 基于划词检索的桌面端 AI 总结应用")

    body = "\n".join(L) + "\n"
    with open("release-notes.md", "w") as f:
        f.write(body)
    print(body)
    return 0


if __name__ == "__main__":
    sys.exit(main())
