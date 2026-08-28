use serde::Serialize;

/// OCR 请求
pub struct OcrRequest {
    /// 图片字节数据（PNG/JPEG/WebP 等格式）
    pub image: Vec<u8>,
    /// 指定识别语言（ISO 代码，如 "zh-Hans"、"en"、"ja" 等）
    /// None 或空字符串表示自动检测
    pub languages: Option<Vec<String>>,
}

/// OCR 结果
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrResult {
    /// 识别出的文本
    pub text: String,
}

/// OCR 错误
#[derive(Debug)]
pub enum OcrError {
    /// 图片无效
    InvalidImage(String),
    /// Vision 初始化失败
    InitFailed(String),
    /// OCR 执行失败
    RecognitionFailed(String),
    /// Vision API 不可用
    NotAvailable(String),
}

impl std::fmt::Display for OcrError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OcrError::InvalidImage(msg) => write!(f, "图片无效: {msg}"),
            OcrError::InitFailed(msg) => write!(f, "Vision 初始化失败: {msg}"),
            OcrError::RecognitionFailed(msg) => write!(f, "OCR 执行失败: {msg}"),
            OcrError::NotAvailable(msg) => write!(f, "Vision API 不可用: {msg}"),
        }
    }
}

impl std::error::Error for OcrError {}

impl From<OcrError> for crate::error::AppError {
    fn from(e: OcrError) -> Self {
        crate::error::AppError::Internal(e.to_string())
    }
}
