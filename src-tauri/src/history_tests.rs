#[cfg(test)]
mod tests {
    use crate::history;
    use rusqlite::Connection;

    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().expect("内存数据库");
        conn.execute_batch(
            r#"
            CREATE TABLE history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                source_text TEXT NOT NULL,
                summary TEXT NOT NULL,
                ai_title TEXT,
                created_at TEXT NOT NULL,
                model TEXT NOT NULL,
                prompt_name TEXT,
                tags TEXT DEFAULT '[]',
                is_favorite INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE tags (
                name TEXT PRIMARY KEY,
                color TEXT NOT NULL DEFAULT ''
            );
            "#,
        )
        .expect("建表失败");
        conn
    }

    #[test]
    fn tag_definitions_with_color() {
        let conn = test_conn();
        // 未定义色时,历史中出现的标签补默认色
        history::create(
            &conn,
            "原文",
            "总结",
            None,
            "gpt",
            None,
            &["旧标签".to_string()],
        )
        .expect("创建失败");
        let tags = history::all_tags(&conn).expect("标签查询失败");
        assert_eq!(tags.len(), 1);
        assert_eq!(tags[0].name, "旧标签");
        assert_eq!(tags[0].color, "");

        // 创建带色标签定义,覆盖默认色
        history::create_tag(&conn, "技术选型", "#8B5CF6").expect("创建标签失败");
        history::create_tag(&conn, "技术选型", "#3B82F6").expect("更新标签颜色失败");
        let tags = history::all_tags(&conn).expect("标签查询失败");
        let tech = tags.iter().find(|t| t.name == "技术选型").expect("缺少技术选型");
        assert_eq!(tech.color, "#3B82F6");

        // 删除标签:定义移除 + 历史记录中同步剔除
        history::create_tag(&conn, "待删", "#EF4444").expect("创建待删标签失败");
        let id2 = history::create(
            &conn,
            "另一段原文",
            "另一段总结",
            None,
            "gpt",
            None,
            &["待删".to_string(), "技术选型".to_string()],
        )
        .expect("创建失败");
        history::delete_tag(&conn, "待删").expect("删除标签失败");
        let tags = history::all_tags(&conn).expect("标签查询失败");
        assert!(!tags.iter().any(|t| t.name == "待删"));
        let rec = history::get(&conn, id2).expect("查询失败").expect("记录不存在");
        assert_eq!(rec.tags, vec!["技术选型".to_string()]);

        // 重命名 + 改色:定义与历史记录同步更新
        history::update_tag(&conn, "技术选型", "架构设计", "#06B6D4").expect("更新标签失败");
        let tags = history::all_tags(&conn).expect("标签查询失败");
        assert!(!tags.iter().any(|t| t.name == "技术选型"));
        let arch = tags.iter().find(|t| t.name == "架构设计").expect("缺少新名");
        assert_eq!(arch.color, "#06B6D4");
        let rec = history::get(&conn, id2).expect("查询失败").expect("记录不存在");
        assert_eq!(rec.tags, vec!["架构设计".to_string()]);
    }

    #[test]
    fn history_crud_and_search() {
        let conn = test_conn();
        let id = history::create(
            &conn,
            "这是一段原文",
            "这是一段总结",
            Some("标题"),
            "gpt",
            Some("默认提示词"),
            &["标签1".to_string()],
        )
        .expect("创建失败");

        let list = history::list(&conn, Some("原文")).expect("搜索失败");
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].prompt_name.as_deref(), Some("默认提示词"));
        assert!(!list[0].is_favorite);

        let fav = history::toggle_favorite(&conn, id).expect("收藏翻转失败");
        assert!(fav);
        let fav2 = history::toggle_favorite(&conn, id).expect("取消收藏失败");
        assert!(!fav2);

        let all = history::list(&conn, None).expect("列表失败");
        assert_eq!(all.len(), 1);

        history::delete(&conn, id).expect("删除失败");
        assert!(history::list(&conn, None).expect("列表失败").is_empty());
    }

    /// 构造一条指定时间/收藏/标签的历史记录,返回 id
    fn mk_record(
        conn: &Connection,
        now: chrono::DateTime<chrono::Utc>,
        days_ago: i64,
        src: &str,
        summary: &str,
        fav: bool,
        tags: &[&str],
    ) -> i64 {
        let id = history::create(
            conn,
            src,
            summary,
            None,
            "gpt",
            None,
            &tags.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
        )
        .expect("创建失败");
        let created = (now - chrono::Duration::days(days_ago)).to_rfc3339();
        conn.execute(
            "UPDATE history SET created_at = ?1, is_favorite = ?2 WHERE id = ?3",
            rusqlite::params![created, fav as i64, id],
        )
        .expect("更新失败");
        id
    }

    #[test]
    fn list_page_pagination_and_filters() {
        let conn = test_conn();
        let now = chrono::Utc::now();

        // r0 今天/收藏/双标签, r1 1天前(长摘要), r2 3天前(无标签), r3 30天前/收藏, r4 200天前
        let id0 = mk_record(&conn, now, 0, "苹果香蕉", "关于苹果的总结", true, &["技术", "产品"]);
        let id1 = mk_record(&conn, now, 1, "苹果", &"很长的摘要".repeat(100), false, &["技术"]);
        let id2 = mk_record(&conn, now, 3, "香蕉", "无标签记录", false, &[]);
        let id3 = mk_record(&conn, now, 30, "其它", "收藏的旧记录", true, &["产品"]);
        let id4 = mk_record(&conn, now, 200, "老数据", "更早的记录", false, &["产品"]);

        // 全部 + 分页:时间倒序,总数 5
        let p1 = history::list_page(&conn, None, false, Some("all"), &[], 2, 0).expect("第1页失败");
        assert_eq!(p1.total, 5);
        assert_eq!(p1.items.len(), 2);
        assert_eq!(p1.items[0].id, id0);
        assert_eq!(p1.items[1].id, id1);
        let last = history::list_page(&conn, None, false, Some("all"), &[], 2, 4).expect("末页失败");
        assert_eq!(last.total, 5);
        assert_eq!(last.items.len(), 1);
        assert_eq!(last.items[0].id, id4);

        // 列表投影:无 source_text,带字符数;长摘要截断为 300
        assert_eq!(p1.items[0].source_char_count, 4); // "苹果香蕉" 4 个字符
        let item1 = p1.items.iter().find(|i| i.id == id1).expect("缺少 id1");
        assert_eq!(item1.summary.chars().count(), 300); // substr 按字符截断为 300

        // 收藏过滤
        let fav = history::list_page(&conn, None, true, Some("all"), &[], 10, 0).expect("收藏失败");
        assert_eq!(fav.total, 2);
        assert!(fav.items.iter().all(|i| i.is_favorite));

        // 今日过滤(本地时区):仅 r0
        let today = history::list_page(&conn, None, false, Some("today"), &[], 10, 0).expect("今日失败");
        assert_eq!(today.total, 1);
        assert_eq!(today.items[0].id, id0);

        // 单标签过滤(JSON 包含)
        let tag = history::list_page(&conn, None, false, Some("all"), &["技术".to_string()], 10, 0)
            .expect("标签失败");
        assert_eq!(tag.total, 2);

        // 关键词过滤
        let kw = history::list_page(&conn, Some("苹果"), false, Some("all"), &[], 10, 0)
            .expect("搜索失败");
        assert_eq!(kw.total, 2);

        // 关键词 + 单标签组合
        let combo = history::list_page(&conn, Some("苹果"), false, Some("all"), &["技术".to_string()], 10, 0)
            .expect("组合失败");
        assert_eq!(combo.total, 2);

        // 多标签交集 AND:同时含 "技术" 与 "产品" 仅 r0(1 条)
        let and = history::list_page(
            &conn,
            None,
            false,
            Some("all"),
            &["技术".to_string(), "产品".to_string()],
            10,
            0,
        )
        .expect("交集失败");
        assert_eq!(and.total, 1);
        assert_eq!(and.items[0].id, id0);

        // 无交集(同时含 "技术" 与 "AI" 不存在)→ 0 条
        let none = history::list_page(
            &conn,
            None,
            false,
            Some("all"),
            &["技术".to_string(), "AI".to_string()],
            10,
            0,
        )
        .expect("空集失败");
        assert_eq!(none.total, 0);

        // 计数
        assert_eq!(history::count(&conn, false).expect("总数失败"), 5);
        assert_eq!(history::count(&conn, true).expect("收藏数失败"), 2);
    }
}
