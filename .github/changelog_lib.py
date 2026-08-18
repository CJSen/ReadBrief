#!/usr/bin/env python3
"""发版 changelog 的共享解析逻辑。

被 gen-release-notes.py（生成 GitHub Release 说明）与 gen-latest-json.py
（生成官网消费的 latest.json）共用，确保分组定义与提交解析规则单一来源：
改 emoji 或新增 Conventional Commits type 时只需动这一处。
"""
import re
import subprocess

# 分组顺序即渲染顺序；key 为 Conventional Commits 的 type。
GROUP_LABELS = [
    ("feat", "✨ 新功能"),
    ("fix", "🐛 问题修复"),
    ("perf", "⚡ 性能优化"),
    ("refactor", "♻️ 重构"),
    ("docs", "📝 文档"),
    ("chore", "🔧 杂项"),
    ("ci", "⚙️ 持续集成"),
    ("style", "🎨 样式"),
    ("test", "✅ 测试"),
]

OTHER_KEY = "other"
OTHER_LABEL = "📦 其他变更"

# 形如 feat(scope)!: 描述 —— scope 与 ! 均可选。
_SUBJECT_RE = re.compile(r"^(\w+)(\(.+?\))?!?:\s*(.*)$")


def resolve_range(ref: str, version: str):
    """定位上一个 tag 与 git log 区间。

    按 creatordate 倒序取最近的、与当前版本不同的 tag 作为比较基准；
    比较时统一剥掉 v 前缀，避免 v0.9.6 与 0.9.6 被当成两个版本。
    """
    tags = subprocess.check_output(["git", "tag", "--sort=-creatordate"]).decode().split()
    prev_tags = [t for t in tags if t.removeprefix("v") != version]
    prev = prev_tags[0] if prev_tags else None
    rng = f"{prev}..{ref}" if prev else ref
    return prev, rng


def collect(ref: str, version: str):
    """收集并分组区间内的提交。

    返回 (prev_tag, groups, other, total)：
      groups —— [(type_key, label, [(msg, short_hash), ...]), ...]，
                已按 GROUP_LABELS 排序并剔除空组；type_key 供下游按语义筛选
                （官网「最新版要点」只取 feat / fix，不靠 emoji 猜）
      other  —— 不符合 Conventional Commits 或 type 未登记的提交
      total  —— 区间内提交总数
    """
    prev, rng = resolve_range(ref, version)
    lines = (
        subprocess.check_output(["git", "log", "--pretty=format:%s|%h", rng])
        .decode()
        .splitlines()
    )

    buckets = {key: [] for key, _ in GROUP_LABELS}
    other = []
    for line in lines:
        if "|" not in line:
            continue
        subject, h = line.split("|", 1)
        m = _SUBJECT_RE.match(subject)
        if m and m.group(1) in buckets:
            buckets[m.group(1)].append((m.group(3), h[:7]))
        else:
            other.append((subject, h[:7]))

    groups = [(key, label, buckets[key]) for key, label in GROUP_LABELS if buckets[key]]
    return prev, groups, other, len(lines)
