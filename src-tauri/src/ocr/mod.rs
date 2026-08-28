pub mod types;
pub mod overlay;

#[cfg(target_os = "macos")]
mod macos;

#[cfg(target_os = "macos")]
pub use macos::recognize;

/// OCR 模块入口
/// 接收图片字节数据，返回识别出的文本
#[cfg(not(target_os = "macos"))]
pub fn recognize(_request: types::OcrRequest) -> Result<types::OcrResult, types::OcrError> {
    Err(types::OcrError::NotAvailable(
        "当前平台不支持 OCR".into(),
    ))
}
