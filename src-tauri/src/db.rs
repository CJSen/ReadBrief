use crate::error::{AppError, AppResult};
use rusqlite::Connection;
use std::path::{Path, PathBuf};

/// 当前数据库 schema 版本（递增，用于迁移检测）
const DB_VERSION: u32 = 2;

pub fn app_data_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("ReadBrief")
}

/// 打开数据库连接（含自愈）：
/// - 目录创建失败 → 返回可读错误（调用方弹窗提示用户）
/// - 库损坏/无法打开 → 自动重命名 `.corrupt` 并重建空库（自愈，不 panic）
pub fn open_connection() -> AppResult<Connection> {
    let dir = app_data_dir();
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("无法创建应用数据目录 {}: {e}", dir.display()))?;
    let path = dir.join("readbrief.db");
    open_with_self_heal(&path)
}

/// 尝试打开 + 迁移；失败时先把损坏库重命名为 .corrupt 再重建空库（自愈）。
fn open_with_self_heal(path: &Path) -> AppResult<Connection> {
    match try_open(path) {
        Ok(conn) => Ok(conn),
        Err(first_err) => {
            // 自愈：把疑似损坏的库移走，重建空库
            let corrupt_path = path.with_extension("db.corrupt");
            let _ = std::fs::rename(path, &corrupt_path);
            match try_open(path) {
                Ok(conn) => {
                    log::warn!(
                        "检测到损坏的数据库，已重建。损坏文件保留于 {}",
                        corrupt_path.display()
                    );
                    Ok(conn)
                }
                Err(_) => {
                    // 重建也失败（如目录不可写），回抛第一个错误（更可能是根因）
                    Err(first_err)
                }
            }
        }
    }
}

fn try_open(path: &Path) -> AppResult<Connection> {
    let conn = Connection::open(path).map_err(|e| format!("无法打开数据库 {}: {e}", path.display()))?;
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| AppError::from(e.to_string()))?;
    conn.pragma_update(None, "foreign_keys", "ON")
        .map_err(|e| AppError::from(e.to_string()))?;
    migrate(&conn)?;
    Ok(conn)
}

/// 按版本号增量迁移 schema（幂等、可重复执行）
fn migrate(conn: &Connection) -> AppResult<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_version (
            version INTEGER NOT NULL
        );",
    )
    .map_err(|e| AppError::from(e.to_string()))?;

    let version: u32 = conn
        .query_row(
            "SELECT COALESCE(MAX(version), 0) FROM schema_version",
            [],
            |row| row.get(0),
        )
        .map_err(|e| AppError::from(e.to_string()))?;

    if version < DB_VERSION {
        run_migrations(conn, version)?;
    }
    Ok(())
}

fn run_migrations(conn: &Connection, from_version: u32) -> AppResult<()> {
    if from_version < 1 {
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS history (
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

            CREATE INDEX IF NOT EXISTS idx_history_created_at ON history(created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_history_favorite ON history(is_favorite);

            INSERT INTO schema_version (version) VALUES (1);
            "#,
        )
        .map_err(|e| AppError::from(e.to_string()))?;
    }

    // v2: 标签定义表(名称 → 颜色),支持左侧创建标签/调色,与 history.tags 名称数组配套
    if from_version < 2 {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS tags (
                name TEXT PRIMARY KEY,
                color TEXT NOT NULL DEFAULT ''
            );

            INSERT INTO schema_version (version) VALUES (2);
            ",
        )
        .map_err(|e| AppError::from(e.to_string()))?;
    }

    // 未来版本在此追加: if from_version < 3 { ... INSERT INTO schema_version (version) VALUES (3); }

    Ok(())
}

pub fn db_path() -> PathBuf {
    app_data_dir().join("readbrief.db")
}

pub fn ensure_path(p: &Path) {
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).expect("无法创建目录");
    }
}
