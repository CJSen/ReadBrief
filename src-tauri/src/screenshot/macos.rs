use super::types::ScreenshotSession;
use std::ffi::c_void;

// CoreGraphics FFI
unsafe extern "C" {
    fn CGMainDisplayID() -> u32;
    fn CGDisplayCreateImage(displayID: u32) -> *mut c_void;
    fn CGDisplayBounds(displayID: u32) -> CGRect;
    fn CGEventCreate(source: *const c_void) -> *const c_void;
    fn CGEventGetLocation(event: *const c_void) -> CGPoint;
    fn CFRelease(cf: *const c_void);
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
struct CGRect {
    origin: CGPoint,
    size: CGSize,
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
struct CGPoint {
    x: f64,
    y: f64,
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
struct CGSize {
    width: f64,
    height: f64,
}

// CGImage FFI
unsafe extern "C" {
    fn CGImageGetWidth(image: *const c_void) -> usize;
    fn CGImageGetHeight(image: *const c_void) -> usize;
    fn CGImageGetBitsPerPixel(image: *const c_void) -> usize;
    fn CGImageGetBytesPerRow(image: *const c_void) -> usize;
    fn CGImageGetDataProvider(image: *const c_void) -> *mut c_void;
    fn CGDataProviderCopyData(provider: *const c_void) -> *mut c_void;
    fn CGImageRelease(image: *mut c_void);
}

// CoreFoundation 数据访问
unsafe extern "C" {
    fn CFDataGetBytePtr(data: *const c_void) -> *const u8;
    fn CFDataGetLength(data: *const c_void) -> i64;
}

/// 获取当前光标位置（逻辑点，左上角原点）
fn get_cursor_position() -> (f64, f64) {
    unsafe {
        let event = CGEventCreate(std::ptr::null());
        if event.is_null() {
            return (0.0, 0.0);
        }
        let loc = CGEventGetLocation(event);
        CFRelease(event);
        (loc.x, loc.y)
    }
}

/// 获取当前鼠标所在屏幕的 displayID 和信息
pub fn current_mouse_screen() -> Option<(u32, f64, f64, f64, f64, f64)> {
    // 使用 CGDisplayBounds 获取主屏幕信息
    // 多显示器：遍历所有屏幕找到鼠标所在的
    let (cursor_x, cursor_y) = get_cursor_position();

    // 尝试获取所有显示器
    // macOS 上可以通过 CGGetActiveDisplayList 获取所有显示器
    // 但为了简化，先用主显示器
    unsafe extern "C" {
        fn CGGetActiveDisplayList(
            max_displays: u32,
            active_displays: *mut u32,
            display_count: *mut u32,
        ) -> i32;
    }

    let mut displays = [0u32; 16];
    let mut count = 0u32;
    unsafe {
        let err = CGGetActiveDisplayList(16, displays.as_mut_ptr(), &mut count);
        if err != 0 {
            // 回退到主显示器
            let main_id = CGMainDisplayID();
            let bounds = CGDisplayBounds(main_id);
            return Some((
                main_id,
                bounds.origin.x,
                bounds.origin.y,
                bounds.size.width,
                bounds.size.height,
                2.0, // 默认缩放因子
            ));
        }
    }

    // 遍历所有显示器，找到鼠标所在的
    for i in 0..count as usize {
        let display_id = displays[i];
        unsafe {
            let bounds = CGDisplayBounds(display_id);
            // CGDisplayBounds 坐标系：左上角原点，Y 向下
            if cursor_x >= bounds.origin.x
                && cursor_x < bounds.origin.x + bounds.size.width
                && cursor_y >= bounds.origin.y
                && cursor_y < bounds.origin.y + bounds.size.height
            {
                // 获取缩放因子（通过 objc2）
                let scale = get_display_scale(display_id).unwrap_or(2.0);
                return Some((
                    display_id,
                    bounds.origin.x,
                    bounds.origin.y,
                    bounds.size.width,
                    bounds.size.height,
                    scale,
                ));
            }
        }
    }

    // 回退到主显示器
    unsafe {
        let main_id = CGMainDisplayID();
        let bounds = CGDisplayBounds(main_id);
        let scale = get_display_scale(main_id).unwrap_or(2.0);
        Some((
            main_id,
            bounds.origin.x,
            bounds.origin.y,
            bounds.size.width,
            bounds.size.height,
            scale,
        ))
    }
}

/// 获取显示器的缩放因子
fn get_display_scale(display_id: u32) -> Option<f64> {
    // 简化实现：返回默认缩放因子
    // TODO: 后续可以通过 NSScreen 精确获取
    let _ = display_id;
    Some(2.0)
}

/// 截取指定显示器的全屏图像
pub fn capture_display(display_id: u32) -> Option<ScreenshotSession> {
    unsafe {
        // 获取屏幕逻辑尺寸
        let bounds = CGDisplayBounds(display_id);
        let scale = get_display_scale(display_id).unwrap_or(2.0);
        let screen_x = bounds.origin.x;
        let screen_y = bounds.origin.y;
        let screen_width = bounds.size.width;
        let screen_height = bounds.size.height;

        // 截取整个显示器
        let cg_image = CGDisplayCreateImage(display_id);
        if cg_image.is_null() {
            log::warn!("CGDisplayCreateImage 失败: displayID={display_id}");
            return None;
        }

        let width = CGImageGetWidth(cg_image);
        let height = CGImageGetHeight(cg_image);
        let bytes_per_row = CGImageGetBytesPerRow(cg_image);
        let bits_per_pixel = CGImageGetBitsPerPixel(cg_image);

        // 获取像素数据
        let data_provider = CGImageGetDataProvider(cg_image);
        if data_provider.is_null() {
            CGImageRelease(cg_image);
            return None;
        }

        let cf_data = CGDataProviderCopyData(data_provider);
        if cf_data.is_null() {
            CGImageRelease(cg_image);
            return None;
        }

        // 复制像素数据到 Vec
        let data_ptr = CFDataGetBytePtr(cf_data as *const c_void);
        let data_len = CFDataGetLength(cf_data as *const c_void);
        let pixel_data = std::slice::from_raw_parts(data_ptr, data_len as usize).to_vec();

        // 编码为 PNG
        let png_bytes = encode_rgba_to_png(
            &pixel_data,
            width as u32,
            height as u32,
            bytes_per_row as u32,
            bits_per_pixel as usize,
        )?;

        CFRelease(cf_data);
        CGImageRelease(cg_image);

        Some(ScreenshotSession {
            png_bytes,
            pixel_data,
            width: width as u32,
            height: height as u32,
            bytes_per_row: bytes_per_row as u32,
            scale_factor: scale,
            screen_x,
            screen_y,
            screen_width,
            screen_height,
            display_id,
        })
    }
}

/// 从 ScreenshotSession 裁剪指定区域（像素坐标）
pub fn crop_session(
    session: &ScreenshotSession,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
) -> Option<Vec<u8>> {
    // 从原始像素数据裁剪
    let bpp = 4; // BGRA
    let mut cropped = Vec::with_capacity((width * height * bpp) as usize);

    for row in y..y + height {
        let row_start = (row * session.bytes_per_row + x * bpp) as usize;
        let row_end = row_start + (width * bpp) as usize;
        if row_end <= session.pixel_data.len() {
            cropped.extend_from_slice(&session.pixel_data[row_start..row_end]);
        }
    }

    // 编码为 PNG
    encode_rgba_to_png(&cropped, width, height, width * bpp, 32)
}

/// 将 BGRA 像素数据编码为 PNG
fn encode_rgba_to_png(
    data: &[u8],
    width: u32,
    height: u32,
    bytes_per_row: u32,
    bits_per_pixel: usize,
) -> Option<Vec<u8>> {
    let bpp = bits_per_pixel / 8;
    let channels = bpp;

    let mut output = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut output, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);

        let mut writer = encoder.write_header().ok()?;
        let mut image_data = Vec::with_capacity((width * height * 4) as usize);

        for y in 0..height {
            let row_start = (y * bytes_per_row) as usize;
            for x in 0..width {
                let px = row_start + (x as usize) * channels;
                if px + channels <= data.len() {
                    // CGImage 的 BGRA → PNG 的 RGBA
                    if channels >= 4 {
                        image_data.push(data[px + 2]); // R
                        image_data.push(data[px + 1]); // G
                        image_data.push(data[px]); // B
                        image_data.push(data[px + 3]); // A
                    } else if channels >= 3 {
                        image_data.push(data[px + 2]); // R
                        image_data.push(data[px + 1]); // G
                        image_data.push(data[px]); // B
                        image_data.push(255); // A
                    } else {
                        // 灰度
                        image_data.push(data[px]);
                        image_data.push(data[px]);
                        image_data.push(data[px]);
                        image_data.push(255);
                    }
                }
            }
        }

        writer.write_image_data(&image_data).ok()?;
    }

    Some(output)
}

/// 截取当前鼠标所在屏幕
pub fn capture_current_screen() -> Option<ScreenshotSession> {
    let (display_id, ..) = current_mouse_screen()?;
    capture_display(display_id)
}
