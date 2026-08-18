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

# 按 dmg 文件名里的架构标识归类；顺序即匹配优先级。
ARCH_PATTERNS = [
    ("aarch64", ("aarch64", "arm64")),
    ("x64", ("x64", "x86_64")),
]


def pick_assets(raw: str) -> dict:
    """从 release 资产列表里挑出两个架构的 dmg。

    只认 .dmg：release 里同时存在 .app.tar.gz 等产物，不应出现在官网下载入口。
    """
    try:
        items = json.loads(raw) if raw else []
    except json.JSONDecodeError as e:
        print(f"RB_ASSETS_JSON 解析失败：{e}", file=sys.stderr)
        return {}

    result = {}
    for item in items:
        name = item.get("name", "")
        if not name.endswith(".dmg"):
            continue
        lowered = name.lower()
        for arch, keywords in ARCH_PATTERNS:
            if arch in result:
                continue
            if any(k in lowered for k in keywords):
                result[arch] = {
                    "name": name,
                    "size": item.get("size", 0),
                    "url": item.get("browser_download_url", ""),
                }
                break
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
        # 两个架构都缺说明构建产物没进 release，此时宁可让 CI 失败，
        # 也不要把空清单发出去——官网会照着它渲染出无法下载的按钮。
        print("::error::未在 release 资产中找到任何 .dmg，latest.json 不予生成。", file=sys.stderr)
        return 1
    for arch, _ in ARCH_PATTERNS:
        if arch not in assets:
            print(f"::warning::缺少 {arch} 架构的 dmg，官网将只展示已有架构。")

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

    print(f"latest.json 已生成：v{version} · {total} 条提交 · {len(assets)} 个 dmg")
    for arch, info in assets.items():
        print(f"  {arch}: {info['name']} ({info['size']} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
