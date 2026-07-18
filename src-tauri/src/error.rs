use serde::Serialize;

/// 结构化后端错误:经 IPC 序列化后,前端可按 kind 分类处理(与前端 errors.ts 对齐),
/// 替代此前 `Result<_, String>` 裸字符串 + 前端文本匹配的脆弱模式。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind", content = "message")]
pub enum AppError {
    /// 基础设施错误(数据库 / 文件系统 / 未知内部错误)
    Internal(String),
    /// 参数非法(前端传入的配置/文本不合法)
    Invalid(String),
    /// 鉴权失败(401/403 等价物)
    Auth(String),
    /// 限流 / 额度不足(429 等价物)
    RateLimit(String),
    /// 网络错误(连接失败 / 超时)
    Network(String),
    /// 上游服务错误(带 HTTP 状态码)
    Upstream { status: u16, message: String },
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AppError::Internal(m) => write!(f, "内部错误: {m}"),
            AppError::Invalid(m) => write!(f, "参数非法: {m}"),
            AppError::Auth(m) => write!(f, "鉴权失败: {m}"),
            AppError::RateLimit(m) => write!(f, "请求受限: {m}"),
            AppError::Network(m) => write!(f, "网络错误: {m}"),
            AppError::Upstream { status, message } => write!(f, "上游错误 HTTP {status}: {message}"),
        }
    }
}

impl std::error::Error for AppError {}

impl From<String> for AppError {
    fn from(s: String) -> Self {
        AppError::Internal(s)
    }
}

impl From<&str> for AppError {
    fn from(s: &str) -> Self {
        AppError::Internal(s.to_string())
    }
}

impl From<rusqlite::Error> for AppError {
    fn from(e: rusqlite::Error) -> Self {
        AppError::Internal(e.to_string())
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::Internal(e.to_string())
    }
}

impl From<reqwest::Error> for AppError {
    fn from(e: reqwest::Error) -> Self {
        if e.is_timeout() {
            AppError::Network("请求超时".into())
        } else if e.is_connect() {
            AppError::Network(format!("网络连接失败: {e}"))
        } else {
            AppError::Network(e.to_string())
        }
    }
}

/// Tauri 命令统一返回类型
pub type AppResult<T> = Result<T, AppError>;
