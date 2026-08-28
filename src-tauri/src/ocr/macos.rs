use super::types::{OcrError, OcrRequest, OcrResult};
use objc2::rc::Retained;
use objc2::AnyThread;
use objc2_foundation::{NSData, NSDictionary, NSString};
use objc2_vision::{VNImageOption, VNImageRequestHandler, VNRecognizeTextRequest, VNRequest, VNRequestTextRecognitionLevel};

/// macOS Vision OCR 实现（使用 objc2-vision，支持多语言）
///
/// 语言策略：
/// 1. 如果指定了 languages，优先使用 recognitionLanguages（效率更高）
/// 2. 如果未指定，启用 automaticallyDetectsLanguage 自动检测（兜底）
pub fn recognize(request: OcrRequest) -> Result<OcrResult, OcrError> {
    // 验证图片数据
    if request.image.is_empty() {
        return Err(OcrError::InvalidImage("图片数据为空".into()));
    }

    // 使用 NSData 直接加载图片（无需临时文件）
    let data = NSData::from_vec(request.image);

    unsafe {
        // 创建空的 options 字典
        let options = NSDictionary::<VNImageOption, objc2::runtime::AnyObject>::new();

        // 创建 VNImageRequestHandler
        let handler = VNImageRequestHandler::initWithData_options(
            VNImageRequestHandler::alloc(),
            &data,
            &options,
        );

        // 创建 VNRecognizeTextRequest
        let text_request = VNRecognizeTextRequest::new();

        // 设置识别级别为高准确率
        text_request.setRecognitionLevel(VNRequestTextRecognitionLevel::Accurate);

        // 启用语言修正
        text_request.setUsesLanguageCorrection(true);

        // 语言策略：
        // 1. 默认写死常用语言（中文、英文、繁体中文、日语、韩语）
        // 2. 从"输出语言"选项中补充其他语言（法语、德语、西班牙语、俄语、葡萄牙语等）
        // 3. 自动检测兜底
        let default_langs = vec![
            "zh-Hans",  // 简体中文
            "en",       // 英文
            "zh-Hant",  // 繁体中文
            "ja",       // 日语
            "ko",       // 韩语
            // 从"输出语言"选项中补充
            "fr",       // 法语
            "de",       // 德语
            "es",       // 西班牙语
            "ru",       // 俄语
            "pt",       // 葡萄牙语
        ];
        
        // 设置识别语言
        let lang_strings: Vec<Retained<NSString>> = default_langs.iter()
            .map(|s| NSString::from_str(s))
            .collect();
        let lang_refs: Vec<&NSString> = lang_strings.iter().map(|s| s.as_ref()).collect();
        let lang_array = objc2_foundation::NSArray::from_slice(&lang_refs);
        text_request.setRecognitionLanguages(&lang_array);
        
        // 启用自动检测作为兜底
        text_request.setAutomaticallyDetectsLanguage(true);
        log::debug!("OCR 识别语言: {:?}", default_langs);

        // 执行请求 - 将 VNRecognizeTextRequest 转换为 VNRequest
        let request_ref: &VNRequest = &*text_request;
        let requests = objc2_foundation::NSArray::from_slice(&[request_ref]);
        handler
            .performRequests_error(&requests)
            .map_err(|e| OcrError::RecognitionFailed(format!("执行识别失败: {:?}", e)))?;

        // 获取结果
        let results = text_request
            .results()
            .ok_or_else(|| OcrError::RecognitionFailed("无法获取识别结果".into()))?;

        // 合并所有识别结果
        let mut text_parts = Vec::new();
        for i in 0..results.count() {
            let observation = results.objectAtIndex(i);
            if let Some(candidate) = observation.topCandidates(1).firstObject() {
                let text = candidate.string();
                let text_str = text.to_string();
                if !text_str.is_empty() {
                    text_parts.push(text_str);
                }
            }
        }

        let text = text_parts.join("\n");
        Ok(OcrResult { text })
    }
}
