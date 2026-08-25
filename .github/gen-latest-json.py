#!/usr/bin/env python3
"""生成 latest.json —— 官网与后续 App 端共用的发版清单。

以固定文件名上传为 GitHub Release 资产后，下面这个地址即永久有效：

    https://github.com/CJSen/ReadBrief/releases/latest/download/latest.json

三点好处：
  1. 资产下载走 CDN，不受 api.github.com 未认证 60 次/小时的限流；
  2. GitHub 的 latest 语义天然跳过 prerelease，故 beta / test 版不会污染官网下载入口；
  3. 一次请求即拿到版本号、变更分组与两个 dmg 的真实直链与体积。

输入（环境变量）：
    GITHUB_REF_NAME  推送的 tag，如 v0.9.6 或 0.9.6
    RB_ASSETS_JSON   release 已上传资产的 JSON 数组，元素含 name / size / browser_download_url
    RB_PUB_DATE      可选，发布时间（ISO 8601）；缺省取当前 UTC 时间
输出：
    当前工作目录下的 latest.json

本地预览（不依赖 CI）：
    GITHUB_REF_NAME=v0.9.6 RB_ASSETS_JSON='[]' python3 .github/gen-latest-json.py
"""
import datetime as dt
import json
import os
import sys

from changelog_lib import OTHER_KEY, OTHER_LABEL, collect

SCHEMA_VERSION = 1

# 按文件名里的架构标识归类；顺序即匹配优先级。
# macOS 只认 .dmg，Windows 认 .exe / .msi（nsis / msi 产物）。
MACOS_ARCH_PATTERNS = [
    ("aarch64", ("aarch64", "arm64")),
    ("x64", ("x64", "x86_64")),
]
WINDOWS_ARCH_PATTERNS = [
    # 当前仅发布 x64 版本；后续若出 arm64 再加 ("windows-arm64", ("arm64", "aarch64"))。
    ("windows", ("x64", "x86_64")),
]


def _match(assets: dict, item: dict, patterns: list) -> None:
    name = item.get("name", "")
    lowered = name.lower()
    for arch, keywords in patterns:
        if arch in assets:
            continue
        if any(k in lowered for k in keywords):
            assets[arch] = {
                "name": name,
                "size": item.get("size", 0),
                "url": item.get("browser_download_url", ""),
            }
            break


def pick_assets(raw: str) -> dict:
    """从 release 资产列表里挑出各平台的安装包。

    只认安装包：release 里同时存在 .app.tar.gz / .sig 等产物，不应出现在官网下载入口。
    macOS → .dmg（按 aarch64 / x64 两个架构）；Windows → .exe / .msi（当前 x64）。
    """
    try:
        items = json.loads(raw) if raw else []
    except json.JSONDecodeError as e:
        print(f"RB_ASSETS_JSON 解析失败：{e}", file=sys.stderr)
        return {}

    macos: dict = {}
    windows: dict = {}
    for item in items:
        name = item.get("name", "")
        if name.endswith(".dmg"):
            _match(macos, item, MACOS_ARCH_PATTERNS)
        elif name.endswith(".exe") or name.endswith(".msi"):
            _match(windows, item, WINDOWS_ARCH_PATTERNS)

    result = {}
    result.update(macos)
    result.update(windows)
    return result


def main() -> int:
    ref = os.environ.get("GITHUB_REF_NAME", "")
    if not ref:
        print("GITHUB_REF_NAME 未设置", file=sys.stderr)
        return 1
    version = ref.removeprefix("v")

    prev, groups, other, total = collect(ref, version)
    changelog = [
        {
            "type": key,
            "label": label,
            "items": [{"text": msg, "hash": h} for msg, h in items],
        }
        for key, label, items in groups
    ]
    if other:
        changelog.append(
            {
                "type": OTHER_KEY,
                "label": OTHER_LABEL,
                "items": [{"text": msg, "hash": h} for msg, h in other],
            }
        )

    assets = pick_assets(os.environ.get("RB_ASSETS_JSON", ""))
    if not assets:
        # 一个可识别的安装包都没有说明构建产物没进 release，此时宁可让 CI 失败，
        # 也不要把空清单发出去——官网会照着它渲染出无法下载的按钮。
        print(
            "::error::未在 release 资产中找到任何可识别的安装包（.dmg / .exe / .msi），"
            "latest.json 不予生成。",
            file=sys.stderr,
        )
        return 1
    # 防御：资产 URL 若落在「无 tag 的孤儿 release」（slug 形如 untagged-xxxxxxxx），
    # 说明本次抓取到了被 GitHub 孤儿化的资产，这种链接随时会 404。
    # 宁可让发版失败，也不能把坏链写进 latest.json。
    for arch, info in assets.items():
        if "untagged" in info.get("url", ""):
            print(
                f"::error::资产 {info['name']} 的下载地址落在孤儿 release（untagged），"
                "latest.json 不予生成。请检查 tauri-action 是否把安装包传到了正确的 tag release。",
                file=sys.stderr,
            )
            return 1
    macos = {k: v for k, v in assets.items() if k in ("aarch64", "x64")}
    windows = {k: v for k, v in assets.items() if k == "windows"}
    if not macos:
        print("::warning::未找到任何 macOS dmg，官网将不展示 macOS 下载入口。")
    else:
        for arch, _ in MACOS_ARCH_PATTERNS:
            if arch not in macos:
                print(f"::warning::缺少 macOS {arch} 架构的 dmg，官网将只展示已有架构。")
    if not windows:
        print("::warning::未找到 Windows 安装包（.exe/.msi），官网将不展示 Windows 下载入口。")

    pub_date = os.environ.get("RB_PUB_DATE") or (
        dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()
    )

    payload = {
        "schema": SCHEMA_VERSION,
        "version": version,
        "tag": ref,
        "prev_version": prev.removeprefix("v") if prev else None,
        "pub_date": pub_date,
        "commit_count": total,
        "changelog": changelog,
        "assets": assets,
    }

    with open("latest.json", "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
        f.write("\n")

    print(f"latest.json 已生成：v{version} · {total} 条提交 · {len(assets)} 个安装包")
    for arch, info in assets.items():
        print(f"  {arch}: {info['name']} ({info['size']} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
