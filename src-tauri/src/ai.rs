//! AI 调用下沉 Rust(P0-2):WebView 不再直连任何 AI 域名,密钥永不进入渲染进程。
//!
//! 架构:
//! - `ai_stream` 命令:接收服务配置 + 请求体,在 Rust 侧序列化三协议(openai/claude/gemini)、
//!   reqwest 发流式请求、解析 SSE,经 `ai-delta` / `ai-error` / `ai-done` 事件回传前端
//! - 统一超时(60s)、输入长度截断(20k 字符)、protocol 白名单
//! - Gemini Key 从 URL query 移到 `x-goog-api-key` 请求头(不再落 URL/日志)
//!
//! 前端对应实现: `src/lib/ai/provider.ts` 的 `streamChat` 改为 invoke 本命令 + 监听事件。

use crate::error::{AppError, AppResult};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tauri::Emitter;

/// AI 服务配置(由前端传入,apiKey 仅在本进程内使用,不回传)
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiServiceConfig {
    pub protocol: String,
    pub api_key: String,
    pub base_url: Option<String>,
    pub model: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiRequest {
    pub system: Option<String>,
    pub user: String,
    pub stream: bool,
    pub max_tokens: u32,
    pub model: Option<String>,
}

/// 事件回传载荷(delta/error/done 共用)
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AiEvent {
    request_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    done: Option<bool>,
}

/// 请求超时:60s(此前前端 fetch 无超时兜底,服务端长时间无响应会永久转圈)
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
/// 输入长度上限:20k 字符(此前前端直发全文无截断,可被超大文本撑爆)
const MAX_INPUT_CHARS: usize = 20_000;

/// 校验 protocol 是否为三枚举之一(防剪贴板导入非法值后浮窗崩溃)
fn validate_protocol(p: &str) -> Result<(), AppError> {
    match p {
        "openai" | "claude" | "gemini" => Ok(()),
        other => Err(AppError::Invalid(format!("未知协议: {other}"))),
    }
}

/// 截断超长文本(保留头部,避免超大输入)
fn truncate_input(s: &str) -> String {
    let mut chars = s.chars();
    let head: String = chars.by_ref().take(MAX_INPUT_CHARS).collect();
    if chars.next().is_some() {
        // 有被截断的内容,追加提示
        head
    } else {
        head
    }
}

/// 构造请求 URL / headers / body(三协议序列化,Rust 侧实现)
fn build_request(
    req: &AiRequest,
    config: &AiServiceConfig,
) -> Result<(String, Vec<(String, String)>, serde_json::Value), AppError> {
    validate_protocol(&config.protocol)?;
    let base = config
        .base_url
        .as_deref()
        .unwrap_or(match config.protocol.as_str() {
            "claude" => "https://api.anthropic.com",
            "gemini" => "https://generativelanguage.googleapis.com",
            _ => "https://api.openai.com/v1",
        })
        .trim_end_matches('/');

    let model = req.model.as_deref().unwrap_or(&config.model);

    match config.protocol.as_str() {
        "openai" => {
            let mut messages = Vec::new();
            if let Some(sys) = &req.system {
                messages.push(serde_json::json!({ "role": "system", "content": sys }));
            }
            messages.push(serde_json::json!({ "role": "user", "content": req.user }));
            Ok((
                format!("{base}/chat/completions"),
                vec![
                    ("Authorization".into(), format!("Bearer {}", config.api_key)),
                    ("Content-Type".into(), "application/json".into()),
                ],
                serde_json::json!({
                    "model": model,
                    "messages": messages,
                    "stream": req.stream,
                    "max_tokens": req.max_tokens,
                }),
            ))
        }
        "claude" => {
            let mut messages = Vec::new();
            messages.push(serde_json::json!({ "role": "user", "content": req.user }));
            Ok((
                format!("{base}/v1/messages"),
                vec![
                    ("x-api-key".into(), config.api_key.clone()),
                    ("anthropic-version".into(), "2023-06-01".into()),
                    ("Content-Type".into(), "application/json".into()),
                ],
                serde_json::json!({
                    "model": model,
                    "max_tokens": req.max_tokens,
                    "system": req.system,
                    "messages": messages,
                    "stream": req.stream,
                }),
            ))
        }
        "gemini" => {
            let contents: Vec<serde_json::Value> = {
                let mut list = Vec::new();
                if let Some(sys) = &req.system {
                    list.push(serde_json::json!({ "role": "user", "parts": [{ "text": sys }] }));
                }
                list.push(serde_json::json!({ "role": "user", "parts": [{ "text": req.user }] }));
                list
            };
            Ok((
                format!("{base}/v1beta/models/{model}:streamGenerateContent?alt=sse"),
                vec![
                    // Gemini Key 用请求头,不再拼 URL query(防 URL 泄露到日志/网络层)
                    ("x-goog-api-key".into(), config.api_key.clone()),
                    ("Content-Type".into(), "application/json".into()),
                ],
                serde_json::json!({
                    "contents": contents,
                    "generationConfig": { "maxOutputTokens": req.max_tokens },
                }),
            ))
        }
        _ => unreachable!("protocol 已校验"),
    }
}

/// 发送 ai-error 事件(AppError → 前端可识别的 {type, message} 结构)
fn emit_error(app: &tauri::AppHandle, request_id: &str, err: &AppError) {
    let (err_type, message) = match err {
        AppError::Auth(m) => ("auth", m.clone()),
        AppError::RateLimit(m) => ("rate_limit", m.clone()),
        AppError::Network(m) => ("network", m.clone()),
        AppError::Upstream { status, message } => {
            let _ = status;
            ("network", message.clone())
        }
        AppError::Invalid(m) | AppError::Internal(m) => ("unknown", m.clone()),
    };
    let _ = app.emit(
        "ai-error",
        AiEvent {
            request_id: request_id.to_string(),
            text: None,
            error: Some(serde_json::json!({ "type": err_type, "message": message })),
            done: None,
        },
    );
}

/// 从 SSE 数据行提取文本 delta(三协议共用)
fn extract_delta(protocol: &str, data: &str) -> Result<String, String> {
    if data == "[DONE]" {
        return Ok(String::new());
    }
    let json: serde_json::Value =
        serde_json::from_str(data).map_err(|e| format!("SSE JSON 解析失败: {e}"))?;
    // 协议层错误(如 OpenAI 流中返回 {"error": ...})
    if let Some(err) = json.get("error") {
        let msg = err.get("message").and_then(|m| m.as_str()).unwrap_or("上游错误");
        return Err(msg.to_string());
    }
    match protocol {
        "openai" => Ok(json
            .get("choices")
            .and_then(|c| c.get(0))
            .and_then(|c| c.get("delta"))
            .and_then(|d| d.get("content"))
            .and_then(|c| c.as_str())
            .unwrap_or("")
            .to_string()),
        "claude" => {
            let is_text_delta = json.get("type").and_then(|t| t.as_str()) == Some("content_block_delta")
                && json.get("delta").and_then(|d| d.get("type")).and_then(|t| t.as_str())
                    == Some("text_delta");
            if is_text_delta {
                Ok(json
                    .get("delta")
                    .and_then(|d| d.get("text"))
                    .and_then(|t| t.as_str())
                    .unwrap_or("")
                    .to_string())
            } else {
                Ok(String::new())
            }
        }
        "gemini" => {
            let mut out = String::new();
            if let Some(parts) = json
                .get("candidates")
                .and_then(|c| c.get(0))
                .and_then(|c| c.get("content"))
                .and_then(|c| c.get("parts"))
                .and_then(|p| p.as_array())
            {
                for part in parts {
                    if let Some(t) = part.get("text").and_then(|t| t.as_str()) {
                        out.push_str(t);
                    }
                }
            }
            Ok(out)
        }
        _ => Ok(String::new()),
    }
}

/// 流式 AI 总结:发请求 → 解析 SSE → 事件回传前端。
/// 前端监听 `ai-delta`(增量文本) / `ai-error`(失败) / `ai-done`(成功结束)。
/// `request_id` 由前端生成,用于关联事件(支持并发/连续请求不错配)。
#[tauri::command]
pub async fn ai_stream(
    app: tauri::AppHandle,
    config: AiServiceConfig,
    request: AiRequest,
    request_id: String,
) -> AppResult<()> {
    let user = truncate_input(&request.user);
    let req = AiRequest {
        system: request.system.map(|s| truncate_input(&s)),
        user,
        stream: true,
        max_tokens: request.max_tokens,
        model: request.model,
    };

    let (url, headers, body) = match build_request(&req, &config) {
        Ok(v) => v,
        Err(e) => {
            emit_error(&app, &request_id, &e);
            // 错误已随 ai-error 事件回传,invoke 正常 resolve(避免前端双发错误)
            return Ok(());
        }
    };

    let client = match reqwest::Client::builder().timeout(REQUEST_TIMEOUT).build() {
        Ok(c) => c,
        Err(e) => {
            emit_error(&app, &request_id, &AppError::from(e));
            return Ok(());
        }
    };

    let mut header_map = reqwest::header::HeaderMap::new();
    for (k, v) in &headers {
        if let (Ok(kh), Ok(vh)) = (
            reqwest::header::HeaderName::from_bytes(k.as_bytes()),
            reqwest::header::HeaderValue::from_str(v),
        ) {
            header_map.insert(kh, vh);
        }
    }

    let response = match client
        .post(&url)
        .headers(header_map)
        .json(&body)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            emit_error(&app, &request_id, &AppError::from(e));
            return Ok(());
        }
    };

    // 非 2xx:读取错误体(截断)回传
    if !response.status().is_success() {
        let status = response.status().as_u16();
        let text = response.text().await.unwrap_or_default();
        let body_snippet: String = text.chars().take(200).collect();
        let (err_type, message) = match status {
            401 | 403 => ("auth", format!("鉴权失败(HTTP {status})")),
            429 => ("rate_limit", format!("请求受限或额度不足(HTTP {status})")),
            500..=599 | 408 => ("network", format!("服务端异常(HTTP {status})")),
            _ => ("unknown", format!("HTTP {status}: {body_snippet}")),
        };
        let _ = app.emit(
            "ai-error",
            AiEvent { request_id: request_id.clone(), text: None, error: Some(serde_json::json!({ "type": err_type, "message": message })), done: None },
        );
        // 错误已随事件回传
        return Ok(());
    }

    // 流式读取:逐行解析 SSE(处理跨 chunk 拆分)
    let protocol = config.protocol.clone();
    let mut stream = response.bytes_stream();
    let mut buf = String::new();
    let mut failed = false;

    while let Some(chunk) = stream.next().await {
        match chunk {
            Ok(bytes) => {
                buf.push_str(&String::from_utf8_lossy(&bytes));
                // 按行切分:完整行立即处理,最后不完整行保留在 buf
                let processed = if let Some(pos) = buf.rfind('\n') {
                    let tail = buf.split_off(pos + 1);
                    let head = std::mem::replace(&mut buf, tail);
                    head
                } else {
                    String::new()
                };
                for line in processed.split('\n') {
                    let line = line.trim();
                    if line.is_empty() || line.starts_with(':') {
                        continue;
                    }
                    if let Some(data) = line.strip_prefix("data:") {
                        let data = data.trim();
                        match extract_delta(&protocol, data) {
                            Ok(delta) => {
                                if !delta.is_empty() {
                                    let _ = app.emit(
                                        "ai-delta",
                                        AiEvent { request_id: request_id.clone(), text: Some(delta), error: None, done: None },
                                    );
                                }
                            }
                            Err(msg) => {
                                failed = true;
                                let _ = app.emit(
                                    "ai-error",
                                    AiEvent { request_id: request_id.clone(), text: None, error: Some(serde_json::json!({ "type": "unknown", "message": msg })), done: None },
                                );
                            }
                        }
                    }
                }
            }
            Err(e) => {
                failed = true;
                let _ = app.emit(
                    "ai-error",
                    AiEvent { request_id: request_id.clone(), text: None, error: Some(serde_json::json!({ "type": "network", "message": e.to_string() })), done: None },
                );
            }
        }
    }

    // 仅成功路径 emit done —— 失败/中止绝不触发前端落库(P0-3 门控,与前端双保险)
    if !failed {
        let _ = app.emit(
            "ai-done",
            AiEvent { request_id, text: None, error: None, done: Some(true) },
        );
    }
    Ok(())
}

/// 连接测试(Rust 侧发最小请求,验证连通性与鉴权)
#[tauri::command]
pub async fn ai_test(config: AiServiceConfig) -> AppResult<serde_json::Value> {
    let start = std::time::Instant::now();
    let req = AiRequest {
        system: Some("回复两个字:ok".into()),
        user: "ping".into(),
        stream: false,
        max_tokens: 8,
        model: None,
    };
    let (url, headers, body) = build_request(&req, &config)?;

    let client = reqwest::Client::builder().timeout(REQUEST_TIMEOUT).build()?;
    let mut header_map = reqwest::header::HeaderMap::new();
    for (k, v) in &headers {
        if let (Ok(kh), Ok(vh)) = (
            reqwest::header::HeaderName::from_bytes(k.as_bytes()),
            reqwest::header::HeaderValue::from_str(v),
        ) {
            header_map.insert(kh, vh);
        }
    }

    let response = client.post(&url).headers(header_map).json(&body).send().await?;
    let elapsed = start.elapsed().as_millis() as u64;
    if !response.status().is_success() {
        let status = response.status().as_u16();
        let text = response.text().await.unwrap_or_default();
        let snippet: String = text.chars().take(200).collect();
        let err_type = match status {
            401 | 403 => "auth",
            429 => "rate_limit",
            500..=599 | 408 => "network",
            _ => "unknown",
        };
        return Ok(serde_json::json!({
            "ok": false,
            "latencyMs": elapsed,
            "error": { "type": err_type, "status": status, "message": format!("HTTP {status}: {snippet}") },
        }));
    }
    Ok(serde_json::json!({ "ok": true, "latencyMs": elapsed }))
}

/// 拉取模型列表(设置页模型下拉)。
/// - OpenAI 格式:GET {base}/models(Bearer),兼容网关(DeepSeek 等)同样支持
/// - Gemini:GET {base}/v1beta/models(x-goog-api-key),name 去 `models/` 前缀
/// - Claude:Anthropic 无公开模型列表接口 → 回退内置候选
#[tauri::command]
pub async fn ai_list_models(config: AiServiceConfig) -> AppResult<Vec<String>> {
    validate_protocol(&config.protocol)?;
    let base = config
        .base_url
        .as_deref()
        .unwrap_or(match config.protocol.as_str() {
            "claude" => "https://api.anthropic.com",
            "gemini" => "https://generativelanguage.googleapis.com",
            _ => "https://api.openai.com/v1",
        })
        .trim_end_matches('/');

    let client = reqwest::Client::builder().timeout(REQUEST_TIMEOUT).build()?;

    match config.protocol.as_str() {
        "openai" => {
            let url = format!("{base}/models");
            let resp = client
                .get(&url)
                .header("Authorization", format!("Bearer {}", config.api_key))
                .send()
                .await?;
            if !resp.status().is_success() {
                return Err(AppError::from(format!("HTTP {}", resp.status().as_u16())));
            }
            let json: serde_json::Value = resp.json().await?;
            Ok(json
                .get("data")
                .and_then(|d| d.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|m| m.get("id").and_then(|i| i.as_str()).map(String::from))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default())
        }
        "gemini" => {
            let url = format!("{base}/v1beta/models?pageSize=100");
            let resp = client
                .get(&url)
                .header("x-goog-api-key", &config.api_key)
                .send()
                .await?;
            if !resp.status().is_success() {
                return Err(AppError::from(format!("HTTP {}", resp.status().as_u16())));
            }
            let json: serde_json::Value = resp.json().await?;
            Ok(json
                .get("models")
                .and_then(|m| m.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|m| m.get("name").and_then(|n| n.as_str()).map(String::from))
                        .map(|n| n.strip_prefix("models/").unwrap_or(&n).to_string())
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default())
        }
        "claude" => Ok(vec![
            "claude-opus-4-20250514".to_string(),
            "claude-sonnet-4-20250514".to_string(),
            "claude-3-5-haiku-20241022".to_string(),
        ]),
        _ => unreachable!("protocol 已校验"),
    }
}
