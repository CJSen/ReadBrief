#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ReadBrief 数据库种子脚本
=======================
用途：
  1. 清空 history(历史) 与 tags(标签) 两张表
  2. 创建 30 个不同的标签(名称 + 颜色)
  3. 插入 N 条随机历史数据：单条数据量大、时间随机(主要分布在半年内)、
     每条记录关联 0-4 个标签

用法：
  python3 scripts/seed_data.py [--db <path>] [--count 100000] [--tags 30]

关键约定：
  - source_text(原文) 与 summary(AI 总结) 使用**完全独立的句子池**，且 summary
    采用结构化格式(一句话概述 + 关键要点列表 + 结语)，与原文风格明显区分，
    保证「每条都有像样的 AI 总结内容」，不会出现只有原文、没有总结的情况。
  - created_at 使用与 App 一致的 RFC3339(UTC) 格式，可直接被
    ORDER BY created_at DESC 与 DATE(created_at,'localtime') 正确解析。
  - 时间分布：约 90% 落在最近 180 天内(并轻微偏向近期)，约 10% 落在上一年
    (180~365 天前)，满足「主要分布在半年内」。
  - 标签关联：tags 字段是标签名称的 JSON 数组(与 App 的 history.tags 约定一致)，最多 4 个。
  - 所有写操作按批次在一个事务内完成，并开启 busy_timeout，避免 App 占用时直接报 locked。
"""

import argparse
import json
import os
import random
import sqlite3
import sys
import time
from datetime import datetime, timedelta, timezone

# App 实际数据库路径(macOS)：~/Library/Application Support/ReadBrief/readbrief.db
DEFAULT_DB = os.path.join(
    os.path.expanduser("~"),
    "Library",
    "Application Support",
    "ReadBrief",
    "readbrief.db",
)

# 30 个标签名称(互不相同)
TAG_NAMES = [
    "技术", "产品", "阅读", "工作", "学习", "灵感", "AI", "新闻", "财经", "健康",
    "生活", "设计", "编程", "会议", "想法", "收藏", "待办", "调研", "翻译", "总结",
    "论文", "教程", "观点", "趣闻", "复盘", "周报", "日报", "笔记", "摘录", "热点",
]

# 标签调色板(hex)，按顺序循环分配给 30 个标签
TAG_COLORS = [
    "#EF4444", "#F97316", "#F59E0B", "#EAB308", "#84CC16", "#22C55E",
    "#10B981", "#14B8A6", "#06B6D4", "#0EA5E9", "#3B82F6", "#6366F1",
    "#8B5CF6", "#A855F7", "#D946EF", "#EC4899", "#F43F5E", "#FB7185",
    "#FACC15", "#4ADE80", "#2DD4BF", "#38BDF8", "#818CF8", "#C084FC",
    "#E879F9", "#F472B6", "#FB923C", "#FBBF24", "#34D399", "#22D3EE",
]

MODELS = ["gpt-4o", "claude-3.5-sonnet", "deepseek-chat", "gemini-1.5-pro", "qwen-max"]
PROMPT_NAMES = ["默认总结", "要点提炼", "通俗解释", "英文翻译", "一句话标题", None]

# 标题池(每个 6-15 个汉字,模拟模型生成的精炼短标题)
CN_TITLE_POOL = [
    "划词总结的产品价值", "本地优先架构取舍", "前端性能优化笔记", "标签体系设计思考",
    "历史记录分页方案", "深色模式适配要点", "产品定位与取舍", "事件广播一致性",
    "SQLite 性能基线", "降低认知负荷法", "知识沉淀的复利", "灰度发布与回滚",
    "隐私设计的信任", "技术选型的权衡", "注意力管理实践", "复盘的决策依据",
    "自动化测试心得", "团队协作的启示", "索引与分页防线", "可检索性决定复用",
    "缓存穿透与击穿", "序列化瓶颈分析", "默认值的艺术", "可读性优先原则",
]

# ---- 原文句子池(article / 观察 / 叙述口吻) ----
# 这一池只用于生成 source_text，刻意与 summary 池区分。
CN_SOURCE = [
    "划词总结功能的价值在于把长文压缩成可快速消费的信息单元，降低用户的认知负荷。",
    "本地优先的架构让数据不上云，既保护隐私又能在离线状态下稳定运行。",
    "Rust 负责系统级能力，React 负责界面，二者通过 Tauri 命令桥接，开发体验顺滑。",
    "标签体系应该尽量扁平，避免层级过深导致用户在分类时产生选择困难。",
    "历史记录列表默认按时间倒序排列，这样用户最近处理的内容总是最先看到。",
    "快捷键全局监听需要申请辅助功能权限，否则在部分应用里读不到选区文本。",
    "把 source_text 和 summary 都落库，方便日后回溯原始语境，而不只是看结论。",
    "深色模式不只是换底色，对比度、可读性和强调色都要重新校准。",
    "一个清晰的产品定位比十个花哨功能更容易被用户记住和推荐。",
    "异步写入历史记录时，通过事件广播通知所有窗口刷新，保证多窗口状态一致。",
    "数据库损坏时自动重命名为 .corrupt 并重建空库，比直接 panic 更友好。",
    "信息密度高不等于可读性差，合理的分段和留白能兼顾两者。",
    "收藏与标签是两种正交的组织方式，一个用于保真、一个用于检索。",
    "搜索应该覆盖原文、摘要和标题，让用户在任意线索下都能找回记录。",
    "本地 SQLite 配合 WAL 模式，既能扛并发读，又能避免整库写锁。",
    "把常用 prompt 做成预设，既降低使用门槛，也保证了输出格式的稳定。",
    "界面上的次要操作应该收进右键菜单或设置页，主路径保持极简。",
    "数据量上来之后，索引和分页比炫技的动画更能决定体感快慢。",
    "很多看似复杂的需求，拆成「输入-处理-输出」三步反而更清晰。",
    "用户在首屏只愿意为一句话停留三秒，摘要必须在三秒内给出价值。",
    "把知识沉淀成可检索的片段，比收藏一整篇长文更利于复用。",
    "端到端的延迟往往卡在序列化与跨进程通信，而不是算法本身。",
    "好的默认值能覆盖八成场景，剩下两成留给高级设置。",
    "可读的代码优先于聪明的代码，因为维护者会感谢你。",
    "把不确定性显式标注出来，比假装精确更值得信任。",
    "今日读到一篇关于注意力管理的文章，核心是把任务拆到足够小。",
    "团队周会上大家讨论了下一阶段的优先级，结论是先做留存再做增长。",
    "下午和同事复盘了上线的事故，根因是灰度发布缺少回滚开关。",
    "周末尝试用新框架重写了个人项目，开发速度确实快了一截。",
    "客户反馈导出功能在大量数据下会超时，需要改成后台异步任务。",
    "调研了几款笔记工具，最终决定自建一套轻量索引来满足检索习惯。",
    "读完《思考快与慢》前几章，对「系统一」的直觉偏差有了更深体会。",
    "把每天的待办压缩到三件以内之后，完成率反而提高了不少。",
    "技术选型会上，大家更倾向于用成熟方案而不是追新，降低维护成本。",
    "凌晨的灵感往往不可靠，但记下来总比第二天忘掉强。",
]

# ---- 总结语态句子池(结论 / 要点 / 建议口吻) ----
# 这一池只用于生成 summary，刻意与 source_text 池区分，读起来像「AI 总结」。
CN_SUMMARY_POINTS = [
    "核心信息可概括为：在可控成本下优先解决高频场景，再逐步覆盖长尾。",
    "作者强调「先跑通再优化」，避免过早陷入架构完美主义。",
    "关键结论：本地优先与云端同步并非互斥，可按数据敏感度分级处理。",
    "文中反复出现的主线是——减少认知负担比增加功能更重要。",
    "值得记住的一点：可检索性决定了沉淀知识的真实复用率。",
    "给出的落地建议是先把最小闭环做出来，用真实反馈替代主观判断。",
    "对工程实践的启发：索引、分页与缓存是性能的三道基础防线。",
    "风险提示很明确：跨进程通信与序列化往往是被忽视的瓶颈。",
    "一句话总结：把复杂问题拆到足够小，复杂度就会自然下降。",
    "作者主张用「默认值+高级选项」兼顾新手与专家两类用户。",
    "文中观点对当前项目有直接借鉴意义，尤其是事件广播的一致性问题。",
    "可复用的方法论：输入—处理—输出三分法能快速厘清模糊需求。",
    "值得关注的是其对隐私设计的取舍，本地落库是信任的前提。",
    "结论部分指出：可读性与可维护性应优先于短期的聪明写法。",
    "建议后续把不确定性显式标注，以提升协作中的信息可信度。",
    "整体来看，这是一篇偏实践导向的总结，行动项清晰可执行。",
    "文中对「首屏三秒」的强调，呼应了产品体验的黄金窗口。",
    "对团队协作的启示：复盘应聚焦决策依据而非责任归属。",
    "提出的分级策略兼顾了性能与成本，具备较强可操作性。",
    "读后最大收获：把知识切成小片段，比囤积长文更有复利效应。",
]

EN_WORDS = (
    "summary local-first privacy tauri rust react sqlite wal tag history bookmark "
    "prompt model async event dark-mode index pagination migration self-heal "
    "clipboard accessibility shortcut render component state schema checkpoint"
).split()

TOPICS = [
    "划词总结", "本地优先架构", "前端性能", "标签体系", "搜索体验", "数据分页",
    "深色模式", "产品定位", "事件广播", "SQLite 优化", "用户认知负荷", "知识沉淀",
    "自动化测试", "团队协作", "注意力管理", "技术选型", "灰度发布", "隐私设计",
]


def make_source(min_chars: int, max_chars: int) -> str:
    """生成「原文」：中文叙述句子为主，少量英文片段，无总结式标记。"""
    target = random.randint(min_chars, max_chars)
    parts: list[str] = []
    cur = 0
    while cur < target:
        if random.random() < 0.85:
            s = random.choice(CN_SOURCE)
        else:
            s = " ".join(random.choice(EN_WORDS) for _ in range(random.randint(3, 6)))
        parts.append(s)
        cur += len(s)
    return "".join(parts)


def make_summary() -> tuple[str, str]:
    """生成分隔符式总结:返回 (标题, 正文)。

    - 标题:6-15 字精炼短标题(CN_TITLE_POOL)
    - 正文:直接编号要点列表(1. 2. 3. ...),无一句话结论、无「关键要点：」分区标签
    与线上模型输出 schema 一致,便于验证解析逻辑。
    """
    title = random.choice(CN_TITLE_POOL)
    n = random.randint(3, 5)
    body = "\n".join(
        f"{i}. {p}" for i, p in enumerate(random.sample(CN_SUMMARY_POINTS, n), 1)
    )
    return title, body


def random_created_at(now: datetime) -> str:
    """返回 RFC3339(UTC) 字符串。约 90% 落在最近 180 天(轻微偏近期)，10% 落在 180~365 天前。"""
    if random.random() < 0.90:
        days_ago = (random.random() ** 1.5) * 180.0
    else:
        days_ago = 180.0 + random.random() * 185.0
    secs = int(days_ago * 86400.0)
    dt = now - timedelta(seconds=secs + random.randint(0, 86399))
    return dt.isoformat()


def random_tags(tag_pool: list[str]) -> list[str]:
    """随机 0~4 个不重复标签名称。"""
    k = random.randint(0, 4)
    return random.sample(tag_pool, k)


def main() -> int:
    ap = argparse.ArgumentParser(description="ReadBrief 数据库种子脚本")
    ap.add_argument("--db", default=DEFAULT_DB, help="数据库文件路径")
    ap.add_argument("--count", type=int, default=100000, help="历史记录条数(默认 100000)")
    ap.add_argument("--tags", type=int, default=30, help="标签数量(默认 30)")
    ap.add_argument("--batch", type=int, default=10000, help="每批插入条数(默认 10000)")
    args = ap.parse_args()

    if not os.path.exists(args.db):
        print(f"[错误] 数据库文件不存在: {args.db}", file=sys.stderr)
        return 2

    db_dir = os.path.dirname(args.db)
    if not os.access(db_dir, os.W_OK):
        print(f"[错误] 对目录无写权限: {db_dir}", file=sys.stderr)
        return 2

    now = datetime.now(timezone.utc)
    tag_pool = TAG_NAMES[: args.tags]
    if len(tag_pool) < args.tags:
        i = 1
        while len(tag_pool) < args.tags:
            tag_pool.append(f"标签{args.tags - len(tag_pool) + i}")
            i += 1

    t0 = time.time()
    conn = sqlite3.connect(args.db)
    try:
        conn.execute("PRAGMA busy_timeout = 60000")
        conn.execute("PRAGMA foreign_keys = ON")
        cur = conn.cursor()

        # ---- 1. 清空 ----
        cur.execute("DELETE FROM history")
        cur.execute("DELETE FROM tags")
        cur.execute("DELETE FROM sqlite_sequence WHERE name IN ('history','tags')")

        # ---- 2. 创建标签 ----
        tag_rows = [
            (name, TAG_COLORS[i % len(TAG_COLORS)]) for i, name in enumerate(tag_pool)
        ]
        cur.executemany("INSERT INTO tags (name, color) VALUES (?, ?)", tag_rows)

        # ---- 3. 分批插入 ----
        inserted = 0
        batch: list[tuple] = []
        for _ in range(args.count):
            tags = random_tags(tag_pool)
            title, summary_body = make_summary()  # (标题, 正文) 与线上 schema 一致
            ai_title = title if random.random() < 0.95 else None
            batch.append(
                (
                    make_source(800, 3000),   # source_text 约 0.8~3KB
                    summary_body,             # summary 仅存正文(编号要点),标题在 ai_title
                    ai_title,
                    random_created_at(now),
                    random.choice(MODELS),
                    random.choice(PROMPT_NAMES),
                    json.dumps(tags, ensure_ascii=False),
                    1 if random.random() < 0.1 else 0,  # is_favorite
                )
            )
            if len(batch) >= args.batch:
                cur.executemany(
                    "INSERT INTO history "
                    "(source_text, summary, ai_title, created_at, model, prompt_name, tags, is_favorite) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    batch,
                )
                inserted += len(batch)
                batch.clear()
        if batch:
            cur.executemany(
                "INSERT INTO history "
                "(source_text, summary, ai_title, created_at, model, prompt_name, tags, is_favorite) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                batch,
            )
            inserted += len(batch)
            batch.clear()

        conn.commit()
    finally:
        conn.close()

    # WAL 合并回主库(失败不影响数据正确性)
    try:
        c2 = sqlite3.connect(args.db)
        c2.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        c2.close()
    except Exception:
        pass

    elapsed = time.time() - t0

    # 校验
    conn = sqlite3.connect(args.db)
    try:
        hn = conn.execute("SELECT COUNT(*) FROM history").fetchone()[0]
        tn = conn.execute("SELECT COUNT(*) FROM tags").fetchone()[0]
        dist = {i: 0 for i in range(5)}
        tagged = 0
        empty_sum = 0
        for (raw, s) in conn.execute("SELECT tags, COALESCE(summary,'') FROM history"):
            try:
                n = len(json.loads(raw))
            except Exception:
                n = 0
            dist[n] = dist.get(n, 0) + 1
            if n > 0:
                tagged += 1
            if len(s.strip()) == 0:
                empty_sum += 1
        half = conn.execute(
            "SELECT COUNT(*) FROM history WHERE created_at >= "
            "strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-180 days')"
        ).fetchone()[0]
        avg_src = conn.execute("SELECT AVG(length(source_text)) FROM history").fetchone()[0]
        avg_sum = conn.execute("SELECT AVG(length(summary)) FROM history").fetchone()[0]
        # 标题长度分布(按 Unicode 码点),验证 6-15 字规则
        title_lens = [
            len(r[0])
            for r in conn.execute("SELECT COALESCE(ai_title,'') FROM history")
        ]
        title_nonempty = [l for l in title_lens if l > 0]
        title_over = sum(1 for l in title_nonempty if l > 15)
        title_under = sum(1 for l in title_nonempty if l < 6)
        title_min = min(title_nonempty) if title_nonempty else 0
        title_max = max(title_nonempty) if title_nonempty else 0
    finally:
        conn.close()

    size = os.path.getsize(args.db)
    print("=" * 48)
    print(f"数据库: {args.db}")
    print(f"耗时: {elapsed:.1f}s")
    print(f"历史记录: {hn} 条 (目标 {args.count})")
    print(f"标签数量: {tn} 个 (目标 {args.tags})")
    print(f"空 summary 记录: {empty_sum} 条 (应为 0)")
    print(f"带标签的记录: {tagged} 条 / {hn}")
    print(f"标签数分布 0/1/2/3/4: " + " / ".join(str(dist.get(i, 0)) for i in range(5)))
    print(f"半年内记录: {half} 条 ({half * 100.0 / hn:.1f}%)")
    print(f"平均原文长度: {avg_src:.0f} 字符; 平均总结长度: {avg_sum:.0f} 字符")
    print(
        f"ai_title 长度: 非空 {len(title_nonempty)} / 超15字 {title_over} / 不足6字 {title_under}"
        f" / 区间 [{title_min},{title_max}] (应为 6-15)"
    )
    print(f"文件大小: {size / 1024 / 1024:.1f} MB")
    print("=" * 48)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
