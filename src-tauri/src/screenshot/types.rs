use serde::Serialize;

/// 截图会话：保存一次截图的全部数据，供 overlay 显示 + 裁剪 OCR 使用
pub struct ScreenshotSession {
    /// 全屏 PNG 编码字节（供 overlay 显示）
    pub png_bytes: Vec<u8>,
    /// 原始像素 BGRA 数据（供 CGImage 裁剪 + OCR）
    pub pixel_data: Vec<u8>,
    /// 图像像素宽
    pub width: u32,
    /// 图像像素高
    pub height: u32,
    /// 每行字节数（bytes per row）
    pub bytes_per_row: u32,
    /// Retina 缩放因子
    pub scale_factor: f64,
    /// 屏幕逻辑坐标 X（左上角原点）
    pub screen_x: f64,
    /// 屏幕逻辑坐标 Y
    pub screen_y: f64,
    /// 屏幕逻辑宽度
    pub screen_width: f64,
    /// 屏幕逻辑高度
    pub screen_height: f64,
    /// 屏幕 displayID
    pub display_id: u32,
}

/// 选区矩形（CSS 坐标，overlay 窗口内，左上角原点）
#[derive(Debug, Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectionRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// 截图结果（返回给前端）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotInfo {
    /// PNG base64 编码（供 overlay 显示）
    pub image_base64: String,
    /// 屏幕逻辑宽度
    pub screen_width: f64,
    /// 屏幕逻辑高度
    pub screen_height: f64,
    /// 缩放因子
    pub scale_factor: f64,
}
