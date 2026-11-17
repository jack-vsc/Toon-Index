//! As APIs: formato OpenAI (OpenAI, OpenRouter, Ollama, LM Studio, llama.cpp), a API do Ollama para
//! rodar no processador e a API de mensagens da Anthropic.

use std::sync::LazyLock;
use std::time::Duration;

use rand::Rng;
use serde_json::{Value, json};
use crate::cancel::Cancel;
use toon_core::settings::{ApiProfile, LOCAL_AI_BASE_URL, Thinking};

use crate::error::AiError;
use crate::types::{PageImage, TranslateRequest};

const MAX_ATTEMPTS: u32 = 3;
const RATE_LIMIT_ATTEMPTS: u32 = 7;
const MAX_OUTPUT_TOKENS: u32 = 8192;
const LOCAL_MAX_OUTPUT_TOKENS: u32 = 3072;
const ANTHROPIC_MAX_OUTPUT_TOKENS: u32 = 16_000;

/// Gramática do llama.cpp para JSON compacto: sem ela os modelos pequenos gastam tokens em espaços.
const COMPACT_JSON: &str = r#"root ::= object
value ::= object | array | string | number | "true" | "false" | "null"
object ::= "{" sp ( string sp ":" sp value ( sp "," sp string sp ":" sp value )* )? sp "}"
array ::= "[" sp ( value ( sp "," sp value )* )? sp "]"
string ::= "\"" ( [^"\\\x7F\x00-\x1F] | "\\" ( ["\\/bfnrt] | "u" [0-9a-fA-F]{4} ) )* "\""
number ::= "-"? [0-9]+ ( "." [0-9]+ )? ( [eE] [-+]? [0-9]+ )?
sp ::= " "?"#;

pub(crate) static HTTP: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(600))
        .user_agent("ToonIndex/0.1")
        .build()
        .expect("cliente HTTP")
});

async fn guarded<T>(cancel: &Cancel, fut: impl Future<Output = Result<T, AiError>>) -> Result<T, AiError> {
    tokio::select! {
        r = fut => r,
        _ = cancel.cancelled() => Err(AiError::Cancelled),
    }
}

fn trim_url(url: &str) -> &str {
    url.trim().trim_end_matches('/')
}

fn data_url(img: &PageImage) -> String {
    format!("data:{};base64,{}", img.mime_type, img.base64)
}

pub struct Call<'a> {
    pub profile: &'a ApiProfile,
    pub api_key: &'a str,
    pub prompt: &'a str,
    pub images: &'a [PageImage],
    pub temperature: f32,
    /// Modelo local rodando no processador: vai pela API do próprio Ollama, que deixa tirar da GPU.
    pub cpu: bool,
    pub cancel: &'a Cancel,
}

pub async fn call_model(call: Call<'_>) -> Result<String, AiError> {
    if call.profile.is_anthropic() {
        return guarded(call.cancel, anthropic(&call)).await;
    }
    let local = call.profile.is_local();
    if local && call.cpu && is_ollama(&call.profile.base_url) {
        return guarded(call.cancel, ollama(&call)).await;
    }
    with_retries(&call, local).await
}

async fn with_retries(call: &Call<'_>, local: bool) -> Result<String, AiError> {
    let mut json_mode = true;
    let mut temperature = Some(call.temperature);
    let mut attempt = 1;
    loop {
        match guarded(call.cancel, openai(call, json_mode, temperature, local)).await {
            Ok(text) => return Ok(text),
            Err(AiError::Http { status, body, retry_after }) => {
                if json_mode && status == 400 && body_mentions(&body, &["response_format", "json_object", "json mode"]) {
                    json_mode = false;
                    continue;
                }
                if temperature.is_some() && status == 400 && body_mentions(&body, &["temperature"]) {
                    temperature = None;
                    continue;
                }
                let lower = body.to_lowercase();
                let transient = (status == 429 || status >= 500) && !["quota", "per-day", "credits"].iter().any(|w| lower.contains(w));
                let limited = status == 429;
                if !transient || attempt >= if limited { RATE_LIMIT_ATTEMPTS } else { MAX_ATTEMPTS } {
                    return Err(AiError::Http { status, body, retry_after });
                }
                let backoff = if limited { (5.0 * 2f64.powi(attempt as i32 - 1)).min(60.0) } else { (2.0 * 2f64.powi(attempt as i32 - 1)).min(20.0) };
                let seconds = retry_after.map(|s| (s as f64).min(60.0)).unwrap_or(backoff * rand::rng().random_range(0.8..1.2));
                tracing::warn!("HTTP {status}, nova tentativa em {}s ({})", seconds.round(), attempt + 1);
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_secs_f64(seconds)) => {}
                    _ = call.cancel.cancelled() => return Err(AiError::Cancelled),
                }
                attempt += 1;
            }
            Err(other) => return Err(other),
        }
    }
}

fn body_mentions(body: &str, words: &[&str]) -> bool {
    let lower = body.to_lowercase();
    words.iter().any(|w| lower.contains(w))
}

async fn send(builder: reqwest::RequestBuilder) -> Result<(u16, Option<u64>, String), AiError> {
    let response = builder.send().await.map_err(|e| AiError::Network(e.to_string()))?;
    let status = response.status().as_u16();
    let retry_after = response.headers().get("retry-after").and_then(|v| v.to_str().ok()).and_then(|v| v.parse().ok());
    let body = response.text().await.map_err(|e| AiError::Network(e.to_string()))?;
    Ok((status, retry_after, body))
}

async fn openai(call: &Call<'_>, json_mode: bool, temperature: Option<f32>, local: bool) -> Result<String, AiError> {
    let base = trim_url(&call.profile.base_url);
    let max_tokens = if local { LOCAL_MAX_OUTPUT_TOKENS } else { MAX_OUTPUT_TOKENS };
    let mut content = vec![json!({ "type": "text", "text": call.prompt })];
    content.extend(call.images.iter().map(|img| json!({ "type": "image_url", "image_url": { "url": data_url(img), "detail": "high" } })));
    let mut body = json!({
        "model": call.profile.model,
        "max_tokens": max_tokens,
        "messages": [{ "role": "user", "content": content }],
    });
    if let Some(t) = temperature {
        body["temperature"] = json!(t);
    }
    if json_mode {
        if base == LOCAL_AI_BASE_URL {
            body["grammar"] = json!(COMPACT_JSON);
        } else {
            body["response_format"] = json!({ "type": "json_object" });
        }
    }
    if local {
        body["reasoning_effort"] = json!("none");
    }
    let request = HTTP
        .post(format!("{base}/chat/completions"))
        .bearer_auth(call.api_key)
        .header("X-Title", "Toon Index")
        .json(&body);
    let (status, retry_after, text) = send(request).await?;
    if !(200..300).contains(&status) {
        return Err(AiError::Http { status, body: text, retry_after });
    }
    let data: Value = serde_json::from_str(&text).map_err(|e| AiError::Format(format!("Resposta da API ilegível: {e}")))?;
    if let Some(err) = data.get("error") {
        let code = err.get("code").and_then(Value::as_u64).unwrap_or(500) as u16;
        return Err(AiError::Http { status: code, body: text, retry_after: None });
    }
    let choice = &data["choices"][0];
    let content = choice["message"]["content"].as_str().unwrap_or("");
    let finish = choice["finish_reason"].as_str().unwrap_or("desconhecido");
    if content.is_empty() {
        let preview: String = text.chars().take(300).collect();
        return Err(AiError::Format(format!("Resposta vazia da API (finish_reason: {finish}): {preview}")));
    }
    if finish == "length" {
        return Err(truncated(content, max_tokens));
    }
    Ok(content.to_string())
}

fn truncated(content: &str, limit: u32) -> AiError {
    let tail: String = content.chars().rev().take(200).collect::<Vec<_>>().into_iter().rev().collect();
    AiError::Truncated {
        message: format!(
            "A resposta da IA foi cortada no limite de {limit} tokens (o modelo provavelmente entrou em repetição). Fim da resposta: {tail}"
        ),
        partial: content.to_string(),
    }
}

fn is_ollama(base: &str) -> bool {
    url::Url::parse(base).is_ok_and(|u| u.port() == Some(11434))
}

async fn ollama(call: &Call<'_>) -> Result<String, AiError> {
    let origin = url::Url::parse(&call.profile.base_url).map(|u| u.origin().ascii_serialization()).unwrap_or_default();
    let body = json!({
        "model": call.profile.model,
        "stream": false,
        "think": false,
        "format": "json",
        "options": { "temperature": call.temperature, "num_predict": LOCAL_MAX_OUTPUT_TOKENS, "num_gpu": 0 },
        "messages": [{ "role": "user", "content": call.prompt, "images": call.images.iter().map(|i| i.base64.clone()).collect::<Vec<_>>() }],
    });
    let (status, _, text) = send(HTTP.post(format!("{origin}/api/chat")).json(&body)).await?;
    if !(200..300).contains(&status) {
        return Err(AiError::Http { status, body: text, retry_after: None });
    }
    let data: Value = serde_json::from_str(&text).map_err(|e| AiError::Format(e.to_string()))?;
    if data.get("error").is_some() {
        return Err(AiError::Http { status: 500, body: text, retry_after: None });
    }
    let content = data["message"]["content"].as_str().unwrap_or("");
    if content.is_empty() {
        return Err(AiError::Format(format!("Resposta vazia do Ollama: {}", text.chars().take(300).collect::<String>())));
    }
    if data["done_reason"] == "length" {
        return Err(truncated(content, LOCAL_MAX_OUTPUT_TOKENS));
    }
    Ok(content.to_string())
}

/// A API de mensagens da Anthropic, chamada direto: não existe SDK oficial em Rust.
async fn anthropic(call: &Call<'_>) -> Result<String, AiError> {
    let mut content: Vec<Value> = call
        .images
        .iter()
        .map(|img| json!({ "type": "image", "source": { "type": "base64", "media_type": img.mime_type, "data": img.base64 } }))
        .collect();
    content.push(json!({ "type": "text", "text": call.prompt }));
    let thinking = call.profile.thinking.unwrap_or_default();
    let ask = |level: Thinking| {
        let mut body = json!({
            "model": call.profile.model,
            "max_tokens": ANTHROPIC_MAX_OUTPUT_TOKENS,
            "messages": [{ "role": "user", "content": content }],
        });
        // Os modelos novos pensam por padrão (e isso é cobrado como saída); desligado, a não ser que o perfil peça.
        match level {
            Thinking::Off => body["thinking"] = json!({ "type": "disabled" }),
            Thinking::Low => body["output_config"] = json!({ "effort": "low" }),
            Thinking::Medium => body["output_config"] = json!({ "effort": "medium" }),
            Thinking::High => body["output_config"] = json!({ "effort": "high" }),
        }
        HTTP.post("https://api.anthropic.com/v1/messages")
            .header("x-api-key", call.api_key)
            .header("anthropic-version", "2023-06-01")
            .json(&body)
    };
    let mut attempt = 1;
    let mut level = thinking;
    loop {
        let (status, retry_after, text) = send(ask(level)).await?;
        if status == 400 && level == Thinking::Off && body_mentions(&text, &["thinking"]) {
            // Modelo que não deixa desligar o raciocínio: o mínimo.
            level = Thinking::Low;
            continue;
        }
        if (status == 429 || status >= 500) && attempt < 5 {
            let wait = retry_after.unwrap_or(2u64.pow(attempt)).min(60);
            tokio::time::sleep(Duration::from_secs(wait)).await;
            attempt += 1;
            continue;
        }
        if !(200..300).contains(&status) {
            return Err(AiError::Http { status, body: text, retry_after });
        }
        let data: Value = serde_json::from_str(&text).map_err(|e| AiError::Format(e.to_string()))?;
        let answer: String = data["content"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|b| b["type"] == "text")
            .filter_map(|b| b["text"].as_str())
            .collect();
        match data["stop_reason"].as_str() {
            Some("refusal") => {
                return Err(AiError::Http {
                    status: 400,
                    body: r#"{"error":{"message":"content_policy: o modelo recusou esta página."}}"#.into(),
                    retry_after: None,
                });
            }
            Some("max_tokens") => return Err(truncated(&answer, ANTHROPIC_MAX_OUTPUT_TOKENS)),
            _ => {}
        }
        if answer.is_empty() {
            return Err(AiError::Format(format!("Resposta vazia da API (stop_reason: {}).", data["stop_reason"])));
        }
        return Ok(answer);
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ModelOption {
    pub id: String,
    pub label: String,
    pub price: Option<String>,
}

/// Os modelos que a API lista; no OpenRouter, só os que aceitam imagem, com o preço.
pub async fn list_models(profile: &ApiProfile, api_key: Option<&str>) -> Result<Vec<ModelOption>, AiError> {
    if profile.is_anthropic() {
        let mut req = HTTP.get("https://api.anthropic.com/v1/models?limit=100").header("anthropic-version", "2023-06-01");
        if let Some(k) = api_key {
            req = req.header("x-api-key", k);
        }
        let (status, _, text) = send(req).await?;
        if !(200..300).contains(&status) {
            return Err(AiError::Http { status, body: text, retry_after: None });
        }
        let data: Value = serde_json::from_str(&text).map_err(|e| AiError::Format(e.to_string()))?;
        return Ok(data["data"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|m| {
                let id = m["id"].as_str()?.to_string();
                Some(ModelOption { label: m["display_name"].as_str().unwrap_or(&id).to_string(), id, price: None })
            })
            .collect());
    }
    let mut req = HTTP.get(format!("{}/models", trim_url(&profile.base_url)));
    if let Some(k) = api_key {
        req = req.bearer_auth(k);
    }
    let (status, _, text) = send(req).await?;
    if !(200..300).contains(&status) {
        return Err(AiError::Http { status, body: text, retry_after: None });
    }
    let data: Value = serde_json::from_str(&text).map_err(|e| AiError::Format(e.to_string()))?;
    let mut models: Vec<ModelOption> = data["data"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|m| {
            m["architecture"]["input_modalities"].as_array().is_none_or(|list| list.iter().any(|x| x == "image"))
        })
        .filter_map(|m| {
            let id = m["id"].as_str()?.to_string();
            let per_million = |v: &Value| v.as_str().and_then(|s| s.parse::<f64>().ok()).map(|p| p * 1e6);
            let price = match (per_million(&m["pricing"]["prompt"]), per_million(&m["pricing"]["completion"])) {
                (Some(i), Some(o)) => Some(format!("${i:.2} / ${o:.2} por 1M tokens")),
                _ => None,
            };
            Some(ModelOption { label: m["name"].as_str().unwrap_or(&id).to_string(), id, price })
        })
        .collect();
    models.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(models)
}

/// Uma imagem branca de 32x32: mostra que o modelo aceita imagem sem gastar quase nada.
pub fn test_image() -> PageImage {
    PageImage {
        base64: "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAAAAABWESUoAAAAFklEQVR4nGP4TwAwjCoYVTCqYKQqAAA/aPwuq5iY/wAAAABJRU5ErkJggg==".into(),
        mime_type: "image/png".into(),
        width: 32,
        height: 32,
    }
}

pub fn empty_request() -> TranslateRequest {
    TranslateRequest::default()
}
