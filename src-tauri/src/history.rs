use crate::error::{AppError, AppResult};
use chrono::Utc;
use rusqlite::{params, params_from_iter, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use tauri::Emitter;

pub struct AppState {
    pub db: Arc<Mutex<Connection>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryRecord {
    pub id: i64,
    pub source_text: String,
    pub summary: String,
    pub ai_title: Option<String>,
    pub created_at: String,
    pub model: String,
    pub prompt_name: Option<String>,
    pub tags: Vec<String>,
    pub is_favorite: bool,
}

/// 标签定义(名称 → 颜色);history.tags 只存名称,颜色在 tags 表查询
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagDef {
    pub name: String,
    pub color: String,
}

/// 列表项投影:不含 source_text(原文按需走 history_get,避免 IPC 传输整段原文)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryListItem {
    pub id: i64,
    pub ai_title: Option<String>,
    /// 预览版 summary(截断),详情用 history_get 取全文
    pub summary: String,
    pub created_at: String,
    pub model: String,
    pub prompt_name: Option<String>,
    pub tags: Vec<String>,
    pub is_favorite: bool,
    pub source_char_count: i64,
}

/// 分页响应:当前页 + 命中总数(前端据此判断是否还有更多)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPage {
    pub items: Vec<HistoryListItem>,
    pub total: i64,
}

fn row_to_record(row: &rusqlite::Row) -> rusqlite::Result<HistoryRecord> {
    let tags_raw: String = row.get("tags")?;
    let tags: Vec<String> = serde_json::from_str(&tags_raw).unwrap_or_default();
    Ok(HistoryRecord {
        id: row.get("id")?,
        source_text: row.get("source_text")?,
        summary: row.get("summary")?,
        ai_title: row.get("ai_title")?,
        created_at: row.get("created_at")?,
        model: row.get("model")?,
        prompt_name: row.get("prompt_name")?,
        tags,
        is_favorite: row.get::<_, i64>("is_favorite")? != 0,
    })
}

/// 把一组标签名同步进 tags 定义表(唯一真相源):已存在的保留原色(OR IGNORE 不覆盖),未定义的补空色。
/// 供 create / history_update_tags 调用,确保 all_tags 只读 tags 表即可覆盖全部标签,
/// 从而无需再扫 history 表(10w 行全表扫描是首屏慢的元凶)。
fn ensure_tags_defined(conn: &Connection, tags: &[String]) -> AppResult<()> {
    for t in tags {
        let name = t.trim();
        if !name.is_empty() {
            conn.execute(
                "INSERT OR IGNORE INTO tags (name, color) VALUES (?1, '')",
                params![name],
            )
            .map_err(|e| AppError::from(e.to_string()))?;
        }
    }
    Ok(())
}

pub fn create(
    conn: &Connection,
    source_text: &str,
    summary: &str,
    ai_title: Option<&str>,
    model: &str,
    prompt_name: Option<&str>,
    tags: &[String],
) -> AppResult<i64> {
    let created_at = Utc::now().to_rfc3339();
    let tags_json = serde_json::to_string(tags).unwrap_or_else(|_| "[]".to_string());
    conn.execute(
        "INSERT INTO history (source_text, summary, ai_title, created_at, model, prompt_name, tags, is_favorite)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0)",
        params![source_text, summary, ai_title, created_at, model, prompt_name, tags_json],
    )
    .map_err(|e| AppError::from(e.to_string()))?;
    // 先取 history 的自增 id:ensure_tags_defined 内部的 INSERT 会改写连接的 last_insert_rowid
    let id = conn.last_insert_rowid();
    ensure_tags_defined(conn, tags)?;
    Ok(id)
}

pub fn list(conn: &Connection, keyword: Option<&str>) -> AppResult<Vec<HistoryRecord>> {
    let mut out = Vec::new();
    match keyword {
        Some(k) if !k.trim().is_empty() => {
            let like = format!("%{}%", k.trim());
            let mut stmt = conn
                .prepare(
                    "SELECT * FROM history
                     WHERE source_text LIKE ?1 OR summary LIKE ?1 OR COALESCE(ai_title,'') LIKE ?1
                     ORDER BY created_at DESC",
                )
                .map_err(|e| AppError::from(e.to_string()))?;
            let mut rows = stmt.query(params![like]).map_err(|e| AppError::from(e.to_string()))?;
            while let Some(row) = rows.next().map_err(|e| AppError::from(e.to_string()))? {
                out.push(row_to_record(&row).map_err(|e| AppError::from(e.to_string()))?);
            }
        }
        _ => {
            let mut stmt = conn
                .prepare("SELECT * FROM history ORDER BY created_at DESC")
                .map_err(|e| AppError::from(e.to_string()))?;
            let mut rows = stmt.query([]).map_err(|e| AppError::from(e.to_string()))?;
            while let Some(row) = rows.next().map_err(|e| AppError::from(e.to_string()))? {
                out.push(row_to_record(&row).map_err(|e| AppError::from(e.to_string()))?);
            }
        }
    }
    Ok(out)
}

fn row_to_list_item(row: &rusqlite::Row) -> rusqlite::Result<HistoryListItem> {
    let tags_raw: String = row.get("tags")?;
    let tags: Vec<String> = serde_json::from_str(&tags_raw).unwrap_or_default();
    Ok(HistoryListItem {
        id: row.get("id")?,
        ai_title: row.get("ai_title")?,
        summary: row.get("summary")?,
        created_at: row.get("created_at")?,
        model: row.get("model")?,
        prompt_name: row.get("prompt_name")?,
        tags,
        is_favorite: row.get::<_, i64>("is_favorite")? != 0,
        source_char_count: row.get("source_char_count")?,
    })
}

/// 分页 + 全条件查询(无限滚动数据源)。
/// - keyword: 全文搜索(原文/摘要/标题)
/// - favorite: 只看收藏
/// - time_filter: "all" | "today" | "week"(本地时区,语义与前端原实现一致)
/// - tags: 标签数组(交集 AND:记录须同时含有全部所选标签,至多 4 个)
/// 排序 created_at DESC, id DESC;列表投影不含 source_text,原文按需 history_get。
pub fn list_page(
    conn: &Connection,
    keyword: Option<&str>,
    favorite: bool,
    time_filter: Option<&str>,
    tags: &[String],
    limit: i64,
    offset: i64,
) -> AppResult<HistoryPage> {
    let mut conds: Vec<String> = Vec::new();
    let mut vals: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

    if let Some(k) = keyword.map(str::trim).filter(|k| !k.is_empty()) {
        let like = format!("%{k}%");
        conds.push(
            "(source_text LIKE ? OR summary LIKE ? OR COALESCE(ai_title,'') LIKE ?)".to_string(),
        );
        vals.push(Box::new(like.clone()));
        vals.push(Box::new(like.clone()));
        vals.push(Box::new(like));
    }
    if favorite {
        conds.push("is_favorite = 1".to_string());
    }
    match time_filter.unwrap_or("all") {
        "today" => {
            conds.push("DATE(created_at,'localtime') = DATE('now','localtime')".to_string())
        }
        // 本周起点:最近一个周日 00:00(与前端 JS 的 getDay() 逻辑一致)
        "week" => conds.push(
            "created_at >= date('now','localtime','-' || strftime('%w','now','localtime') || ' days')"
                .to_string(),
        ),
        _ => {}
    }
    // 多选标签:交集 AND —— 记录须同时含有全部所选标签
    for t in tags.iter().filter(|t| !t.trim().is_empty()) {
        conds.push("EXISTS (SELECT 1 FROM json_each(tags) WHERE value = ?)".to_string());
        vals.push(Box::new(t.clone()));
    }

    let where_sql = if conds.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", conds.join(" AND "))
    };

    // 命中总数(同一组过滤条件)
    let total: i64 = conn
        .query_row(
            &format!("SELECT COUNT(*) FROM history {where_sql}"),
            params_from_iter(vals.iter().map(|v| v.as_ref())),
            |row| row.get(0),
        )
        .map_err(|e| AppError::from(e.to_string()))?;

    // 当前页:列表投影(截断 summary,不带 source_text)
    vals.push(Box::new(limit));
    vals.push(Box::new(offset));
    let sql = format!(
        "SELECT id, ai_title, substr(summary, 1, 300) AS summary, created_at, model, prompt_name, \
         tags, is_favorite, length(source_text) AS source_char_count \
         FROM history {where_sql} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?"
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| AppError::from(e.to_string()))?;
    let mut rows = stmt
        .query(params_from_iter(vals.iter().map(|v| v.as_ref())))
        .map_err(|e| AppError::from(e.to_string()))?;
    let mut items = Vec::new();
    while let Some(row) = rows.next().map_err(|e| AppError::from(e.to_string()))? {
        items.push(row_to_list_item(&row).map_err(|e| AppError::from(e.to_string()))?);
    }
    Ok(HistoryPage { items, total })
}

/// 历史计数(导航栏「历史记录/收藏」总数,独立于当前过滤条件)
pub fn count(conn: &Connection, favorite: bool) -> AppResult<i64> {
    let sql = if favorite {
        "SELECT COUNT(*) FROM history WHERE is_favorite = 1"
    } else {
        "SELECT COUNT(*) FROM history"
    };
    conn.query_row(sql, [], |row| row.get(0))
        .map_err(|e| AppError::from(e.to_string()))
}

pub fn get(conn: &Connection, id: i64) -> AppResult<Option<HistoryRecord>> {
    let row = conn
        .query_row("SELECT * FROM history WHERE id = ?1", params![id], |row| {
            row_to_record(row)
        })
        .optional()
        .map_err(|e| AppError::from(e.to_string()))?;
    Ok(row)
}

pub fn delete(conn: &Connection, id: i64) -> AppResult<()> {
    conn.execute("DELETE FROM history WHERE id = ?1", params![id])
        .map_err(|e| AppError::from(e.to_string()))?;
    Ok(())
}

pub fn toggle_favorite(conn: &Connection, id: i64) -> AppResult<bool> {
    let current: i64 = conn
        .query_row(
            "SELECT is_favorite FROM history WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .map_err(|e| AppError::from(e.to_string()))?;
    let next = if current == 0 { 1 } else { 0 };
    conn.execute(
        "UPDATE history SET is_favorite = ?1 WHERE id = ?2",
        params![next, id],
    )
    .map_err(|e| AppError::from(e.to_string()))?;
    Ok(next == 1)
}

#[tauri::command]
pub async fn history_create(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    source_text: String,
    summary: String,
    ai_title: Option<String>,
    model: String,
    prompt_name: Option<String>,
    tags: Vec<String>,
) -> AppResult<i64> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || -> AppResult<i64> {
        let id = {
            let conn = db.lock().map_err(|e| AppError::from(e.to_string()))?;
            create(
                &conn,
                &source_text,
                &summary,
                ai_title.as_deref(),
                &model,
                prompt_name.as_deref(),
                &tags,
            )?
        };
        // 通知各窗口历史已变更:浮窗新增记录后,主窗口无需手动切换即可刷新(P1-修复)
        let _ = app.emit("history-changed", ());
        Ok(id)
    })
    .await
    .map_err(|e| AppError::from(e.to_string()))?
}

/// 分页查询历史(无限滚动数据源),支持搜索/收藏/时间/多标签(交集)过滤,返回当前页 + 总数
#[tauri::command]
pub async fn history_list(
    state: tauri::State<'_, AppState>,
    keyword: Option<String>,
    favorite: Option<bool>,
    time_filter: Option<String>,
    tags: Option<Vec<String>>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> AppResult<HistoryPage> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || -> AppResult<HistoryPage> {
        let conn = db.lock().map_err(|e| AppError::from(e.to_string()))?;
        list_page(
            &conn,
            keyword.as_deref(),
            favorite.unwrap_or(false),
            time_filter.as_deref(),
            tags.as_deref().unwrap_or(&[]),
            limit.unwrap_or(50).clamp(1, 200),
            offset.unwrap_or(0).max(0),
        )
    })
    .await
    .map_err(|e| AppError::from(e.to_string()))?
}

/// 历史总数(侧边栏计数;favorite=true 时统计收藏数)
#[tauri::command]
pub async fn history_count(
    state: tauri::State<'_, AppState>,
    favorite: Option<bool>,
) -> AppResult<i64> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || -> AppResult<i64> {
        let conn = db.lock().map_err(|e| AppError::from(e.to_string()))?;
        count(&conn, favorite.unwrap_or(false))
    })
    .await
    .map_err(|e| AppError::from(e.to_string()))?
}

#[tauri::command]
pub async fn history_get(
    state: tauri::State<'_, AppState>,
    id: i64,
) -> AppResult<Option<HistoryRecord>> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || -> AppResult<Option<HistoryRecord>> {
        let conn = db.lock().map_err(|e| AppError::from(e.to_string()))?;
        get(&conn, id)
    })
    .await
    .map_err(|e| AppError::from(e.to_string()))?
}

#[tauri::command]
pub async fn history_delete(
    state: tauri::State<'_, AppState>,
    id: i64,
) -> AppResult<()> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || -> AppResult<()> {
        let conn = db.lock().map_err(|e| AppError::from(e.to_string()))?;
        delete(&conn, id)
    })
    .await
    .map_err(|e| AppError::from(e.to_string()))?
}

#[tauri::command]
pub async fn history_toggle_favorite(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: i64,
) -> AppResult<bool> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || -> AppResult<bool> {
        let result = {
            let conn = db.lock().map_err(|e| AppError::from(e.to_string()))?;
            toggle_favorite(&conn, id)
        };
        // 通知各窗口历史已变更(浮窗收藏后主窗口列表/详情即时刷新)
        let _ = app.emit("history-changed", ());
        result
    })
    .await
    .map_err(|e| AppError::from(e.to_string()))?
}

/// 清空全部历史记录(设置页「清空历史」)
#[tauri::command]
pub async fn history_clear(app: tauri::AppHandle, state: tauri::State<'_, AppState>) -> AppResult<()> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || -> AppResult<()> {
        {
            let conn = db.lock().map_err(|e| AppError::from(e.to_string()))?;
            conn.execute("DELETE FROM history", [])
                .map_err(|e| AppError::from(e.to_string()))?;
        }
        // 主窗口/统计数字需即时同步清空结果
        let _ = app.emit("history-changed", ());
        Ok(())
    })
    .await
    .map_err(|e| AppError::from(e.to_string()))?
}

/// 今日已总结次数(托盘菜单展示)
#[tauri::command]
pub async fn history_today_count(state: tauri::State<'_, AppState>) -> AppResult<i64> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || -> AppResult<i64> {
        let conn = db.lock().map_err(|e| AppError::from(e.to_string()))?;
        // created_at 存 UTC RFC3339;以本地时区日期比较,非 UTC 时区下不再恒为 0
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM history
                 WHERE DATE(created_at, 'localtime') = DATE('now', 'localtime')",
                [],
                |row| row.get(0),
            )
            .map_err(|e| AppError::from(e.to_string()))?;
        Ok(count)
    })
    .await
    .map_err(|e| AppError::from(e.to_string()))?
}

/// 更新历史记录标签(单条记录最多 4 个,后端兜底校验)
#[tauri::command]
pub async fn history_update_tags(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: i64,
    tags: Vec<String>,
) -> AppResult<()> {
    if tags.len() > 4 {
        return Err(AppError::from("每条记录最多 4 个标签"));
    }
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || -> AppResult<()> {
        {
            let conn = db.lock().map_err(|e| AppError::from(e.to_string()))?;
            let tags_json = serde_json::to_string(&tags).unwrap_or_else(|_| "[]".to_string());
            conn.execute(
                "UPDATE history SET tags = ?1 WHERE id = ?2",
                params![tags_json, id],
            )
            .map_err(|e| AppError::from(e.to_string()))?;
            // 同步维护 tags 定义表(唯一真相源):打上的标签若尚未定义则补空色,
            // 保证 all_tags 只读 tags 表即可覆盖全部标签,无需再扫 history 表(避免 10w 行全表扫描)。
            ensure_tags_defined(&conn, &tags)?;
        }
        // 通知各窗口历史已变更(浮窗打标后主窗口列表/详情即时刷新)
        let _ = app.emit("history-changed", ());
        Ok(())
    })
    .await
    .map_err(|e| AppError::from(e.to_string()))?
}

/// 更新已有历史记录的总结内容(浮窗「重新生成」场景:同一会话内替换结果,
/// 保持原文/标签/收藏等属性不变,避免重复记录堆积)。
#[tauri::command]
pub async fn history_update_summary(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: i64,
    summary: String,
    ai_title: Option<String>,
    model: String,
    prompt_name: Option<String>,
) -> AppResult<()> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || -> AppResult<()> {
        {
            let conn = db.lock().map_err(|e| AppError::from(e.to_string()))?;
            conn.execute(
                "UPDATE history SET summary = ?1, ai_title = ?2, model = ?3, prompt_name = ?4 WHERE id = ?5",
                params![summary, ai_title, model, prompt_name, id],
            )
            .map_err(|e| AppError::from(e.to_string()))?;
        }
        // 主窗口/统计数字需即时同步更新结果
        let _ = app.emit("history-changed", ());
        Ok(())
    })
    .await
    .map_err(|e| AppError::from(e.to_string()))?
}

/// 创建/更新标签定义(名称 + 颜色)。同名已存在则更新颜色(UPSERT,支持补色)。
pub fn create_tag(conn: &Connection, name: &str, color: &str) -> AppResult<()> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err(AppError::from("标签名称不能为空"));
    }
    conn.execute(
        "INSERT INTO tags (name, color) VALUES (?1, ?2)
         ON CONFLICT(name) DO UPDATE SET color = ?2",
        params![name, color],
    )
    .map_err(|e| AppError::from(e.to_string()))?;
    Ok(())
}

/// 获取所有标签定义(名称 → 颜色)。tags 表为唯一真相源:
/// 打标路径(history_update_tags)会同步 UPSERT 标签名,故无需再扫 history 表补"野生标签"
/// (原第二段 `SELECT tags FROM history WHERE tags != '[]'` 全表扫描在 10w 行数据下耗时 ~1s,
/// 是首屏加载慢的元凶,已删除)。
pub fn all_tags(conn: &Connection) -> AppResult<Vec<TagDef>> {
    let mut defs: std::collections::BTreeMap<String, String> = std::collections::BTreeMap::new();
    let mut stmt = conn
        .prepare("SELECT name, color FROM tags")
        .map_err(|e| AppError::from(e.to_string()))?;
    let mut rows = stmt.query([]).map_err(|e| AppError::from(e.to_string()))?;
    while let Some(row) = rows.next().map_err(|e| AppError::from(e.to_string()))? {
        let name: String = row.get(0).map_err(|e| AppError::from(e.to_string()))?;
        let color: String = row.get(1).map_err(|e| AppError::from(e.to_string()))?;
        defs.insert(name, color);
    }
    Ok(defs
        .into_iter()
        .map(|(name, color)| TagDef { name, color })
        .collect())
}

/// 更新标签(重命名 + 改色):事务内同步 tags 定义与所有历史记录的标签名
pub fn update_tag(conn: &Connection, old_name: &str, new_name: &str, color: &str) -> AppResult<()> {
    let old_name = old_name.trim();
    let new_name = new_name.trim();
    if new_name.is_empty() {
        return Err(AppError::from("标签名称不能为空"));
    }
    let renamed = old_name != new_name;
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| AppError::from(e.to_string()))?;
    if renamed {
        // 历史记录中 old_name → new_name 替换
        let mut stmt = tx
            .prepare("SELECT id, tags FROM history WHERE tags != '[]'")
            .map_err(|e| AppError::from(e.to_string()))?;
        let mut rows = stmt
            .query([])
            .map_err(|e| AppError::from(e.to_string()))?;
        while let Some(row) = rows.next().map_err(|e| AppError::from(e.to_string()))? {
            let id: i64 = row.get(0).map_err(|e| AppError::from(e.to_string()))?;
            let raw: String = row.get(1).map_err(|e| AppError::from(e.to_string()))?;
            if let Ok(tags) = serde_json::from_str::<Vec<String>>(&raw) {
                let next: Vec<String> = tags
                    .iter()
                    .map(|t| if t == old_name { new_name.to_string() } else { t.clone() })
                    .collect();
                if next != tags {
                    let json = serde_json::to_string(&next).unwrap_or_else(|_| "[]".to_string());
                    tx.execute("UPDATE history SET tags = ?1 WHERE id = ?2", params![json, id])
                        .map_err(|e| AppError::from(e.to_string()))?;
                }
            }
        }
        tx.execute("DELETE FROM tags WHERE name = ?1", params![old_name])
            .map_err(|e| AppError::from(e.to_string()))?;
    }
    tx.execute(
        "INSERT INTO tags (name, color) VALUES (?1, ?2)
         ON CONFLICT(name) DO UPDATE SET color = ?2",
        params![new_name, color],
    )
    .map_err(|e| AppError::from(e.to_string()))?;
    tx.commit().map_err(|e| AppError::from(e.to_string()))?;
    Ok(())
}

#[tauri::command]
pub async fn history_update_tag(
    state: tauri::State<'_, AppState>,
    old_name: String,
    new_name: String,
    color: String,
) -> AppResult<()> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || -> AppResult<()> {
        let conn = db.lock().map_err(|e| AppError::from(e.to_string()))?;
        update_tag(&conn, &old_name, &new_name, &color)
    })
    .await
    .map_err(|e| AppError::from(e.to_string()))?
}

/// 删除标签:移除 tags 表定义,并从所有历史记录的 tags 数组中剔除该名称
pub fn delete_tag(conn: &Connection, name: &str) -> AppResult<()> {
    let name = name.trim();
    if name.is_empty() {
        return Ok(());
    }
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| AppError::from(e.to_string()))?;
    // 1. 删除定义
    tx.execute("DELETE FROM tags WHERE name = ?1", params![name])
        .map_err(|e| AppError::from(e.to_string()))?;
    // 2. 从所有历史记录的 tags 数组中移除
    {
        let mut stmt = tx
            .prepare("SELECT id, tags FROM history WHERE tags != '[]'")
            .map_err(|e| AppError::from(e.to_string()))?;
        let mut rows = stmt
            .query([])
            .map_err(|e| AppError::from(e.to_string()))?;
        while let Some(row) = rows.next().map_err(|e| AppError::from(e.to_string()))? {
            let id: i64 = row.get(0).map_err(|e| AppError::from(e.to_string()))?;
            let raw: String = row.get(1).map_err(|e| AppError::from(e.to_string()))?;
            if let Ok(tags) = serde_json::from_str::<Vec<String>>(&raw) {
                let before = tags.len();
                let next: Vec<String> = tags.into_iter().filter(|t| t != name).collect();
                if next.len() < before {
                    let json = serde_json::to_string(&next).unwrap_or_else(|_| "[]".to_string());
                    tx.execute("UPDATE history SET tags = ?1 WHERE id = ?2", params![json, id])
                        .map_err(|e| AppError::from(e.to_string()))?;
                }
            }
        }
    }
    tx.commit().map_err(|e| AppError::from(e.to_string()))?;
    Ok(())
}

#[tauri::command]
pub async fn history_delete_tag(state: tauri::State<'_, AppState>, name: String) -> AppResult<()> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || -> AppResult<()> {
        let conn = db.lock().map_err(|e| AppError::from(e.to_string()))?;
        delete_tag(&conn, &name)
    })
    .await
    .map_err(|e| AppError::from(e.to_string()))?
}

#[tauri::command]
pub async fn history_create_tag(
    state: tauri::State<'_, AppState>,
    name: String,
    color: String,
) -> AppResult<()> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || -> AppResult<()> {
        let conn = db.lock().map_err(|e| AppError::from(e.to_string()))?;
        create_tag(&conn, &name, &color)
    })
    .await
    .map_err(|e| AppError::from(e.to_string()))?
}

/// 获取所有不重复标签及定义颜色
#[tauri::command]
pub async fn history_all_tags(state: tauri::State<'_, AppState>) -> AppResult<Vec<TagDef>> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || -> AppResult<Vec<TagDef>> {
        let conn = db.lock().map_err(|e| AppError::from(e.to_string()))?;
        all_tags(&conn)
    })
    .await
    .map_err(|e| AppError::from(e.to_string()))?
}
