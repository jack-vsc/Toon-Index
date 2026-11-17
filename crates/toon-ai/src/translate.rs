//! Traduzir uma página: o pedido, o cache, a repescagem das caixas esquecidas e os ajustes finais.

use std::fs;
use std::path::PathBuf;

use sha2::{Digest, Sha256};
use toon_core::paths::translation_cache_dir;
use toon_core::settings::{self, ApiProfile, ProviderKind, Settings, Speed, Thinking};

use crate::cancel::Cancel;
use crate::dataset::{self, Example};
use crate::error::{AiError, describe};
use crate::prompt::{self, Parsed};
use crate::providers::{self, Call};
use crate::types::{BlockKind, PageImage, TextBlock, TranslateRequest};

/// Letras numa caixa pulada a partir das quais ela é perguntada de novo (inclui comentários pequenos).
const SKIPPED_PARAGRAPH: u32 = 3;

/// O perfil ativo e a chave dele, prontos para traduzir.
pub struct Ready {
    pub settings: Settings,
    pub profile: ApiProfile,
    pub api_key: String,
}

pub fn ready(settings: Settings) -> Result<Ready, AiError> {
    let profile = settings.active_profile().cloned().ok_or_else(|| {
        AiError::app(
            "auth",
            "Cadastre uma API nas configurações antes de traduzir.",
        )
    })?;
    let key = settings::api_key(&profile.id);
    let api_key = check_profile(&profile, key)?;
    Ok(Ready {
        settings,
        profile,
        api_key,
    })
}

/// Confere o perfil e devolve a chave a usar (um modelo deste PC aceita qualquer uma).
pub fn check_profile(profile: &ApiProfile, key: Option<String>) -> Result<String, AiError> {
    if profile.kind == ProviderKind::Cursor {
        return Err(AiError::app(
            "model",
            format!(
                "O perfil \"{}\" usa o Cursor, que só funciona pelo SDK de Node. Cadastre a mesma conta pelo OpenRouter ou pela API da Anthropic.",
                profile.name
            ),
        ));
    }
    let key = key
        .filter(|k| !k.is_empty())
        .or_else(|| profile.is_local().then(|| "local".to_string()));
    let Some(key) = key else {
        return Err(AiError::app(
            "auth",
            format!(
                "A API \"{}\" está sem chave. Cadastre a chave nas configurações.",
                profile.name
            ),
        ));
    };
    if profile.base_url.trim().is_empty() {
        return Err(AiError::app(
            "model",
            format!(
                "Informe a URL base da API \"{}\" nas configurações.",
                profile.name
            ),
        ));
    }
    if key.starts_with("sk-or-") && !profile.base_url.contains("openrouter.ai") {
        return Err(AiError::app(
            "auth",
            format!(
                "Essa chave é do OpenRouter, mas a URL base da API \"{}\" é {}. Use https://openrouter.ai/api/v1.",
                profile.name, profile.base_url
            ),
        ));
    }
    if profile.model.is_empty() {
        return Err(AiError::app(
            "model",
            format!(
                "Escolha um modelo para a API \"{}\" nas configurações.",
                profile.name
            ),
        ));
    }
    Ok(key)
}

fn speed_name(speed: Speed) -> &'static str {
    match speed {
        Speed::Fast => "fast",
        Speed::Balanced => "balanced",
        Speed::Quality => "quality",
    }
}

/// Mesmas imagens, mesmo prompt e mesmo modelo dão a mesma resposta: traduzir de novo não custa nada.
fn cache_key(prompt: &str, images: &[PageImage], speed: Speed, profile: &ApiProfile) -> String {
    let mut hash = Sha256::new();
    let model = format!("{}|{}", profile.base_url, profile.model);
    hash.update(format!("openai|{model}|{}|{prompt}", speed_name(speed)));
    if let Some(level) = profile.thinking.filter(|t| *t != Thinking::Off) {
        hash.update(format!(
            "|thinking:{}",
            serde_json::to_value(level).unwrap().as_str().unwrap_or("")
        ));
    }
    for img in images {
        hash.update(img.base64.as_bytes());
    }
    hex::encode(hash.finalize())
}

fn cache_file(key: &str) -> PathBuf {
    let dir = translation_cache_dir();
    let _ = fs::create_dir_all(&dir);
    dir.join(format!("{key}.txt"))
}

impl Ready {
    async fn ask_raw(
        &self,
        prompt: &str,
        images: &[PageImage],
        cancel: &Cancel,
        temperature: f32,
    ) -> Result<String, AiError> {
        providers::call_model(Call {
            profile: &self.profile,
            api_key: &self.api_key,
            prompt,
            images,
            temperature,
            cpu: self.settings.ai_device == "cpu",
            cancel,
        })
        .await
    }

    /// Um pedido com cache e uma segunda tentativa: modelos às vezes param no meio ou entram em laço até
    /// o limite de tokens; a segunda vez, um pouco menos determinística, quase sempre volta inteira.
    async fn ask<T>(
        &self,
        kind: &str,
        req: &TranslateRequest,
        prompt: &str,
        images: &[PageImage],
        cancel: &Cancel,
        parse: impl Fn(&str) -> Result<T, AiError>,
    ) -> Result<T, AiError> {
        let key = cache_key(prompt, images, self.settings.speed, &self.profile);
        let file = cache_file(&key);
        let keep = |answer: &str| {
            dataset::record(Example {
                key: &key,
                req,
                kind,
                prompt,
                images,
                answer,
                model: &self.profile.model,
                speed: speed_name(self.settings.speed),
            })
        };
        if let Ok(raw) = fs::read_to_string(&file)
            && let Ok(parsed) = parse(&raw)
        {
            keep(&raw);
            return Ok(parsed);
        }
        let mut attempt = 1;
        loop {
            let temperature = if attempt > 1 { 0.7 } else { 0.2 };
            match self.ask_raw(prompt, images, cancel, temperature).await {
                Ok(raw) => match parse(&raw) {
                    Ok(parsed) => {
                        let _ = fs::write(&file, &raw);
                        keep(&raw);
                        return Ok(parsed);
                    }
                    Err(err) if attempt < 2 => {
                        tracing::warn!("resposta fora do formato, tentando de novo: {err}");
                    }
                    Err(err) => return Err(err),
                },
                Err(err) if err.is_format() && attempt < 2 => {}
                Err(AiError::Truncated { partial, message }) => {
                    // Em laço duas vezes: ficam os blocos terminados antes do laço (sem ir para o cache).
                    return parse(&partial).map_err(|_| AiError::Truncated {
                        message,
                        partial: String::new(),
                    });
                }
                Err(err) => return Err(err),
            }
            attempt += 1;
        }
    }

    /// Os blocos de texto de cada imagem do pedido, traduzidos.
    pub async fn translate_page(
        &self,
        req: &TranslateRequest,
        cancel: &Cancel,
    ) -> Result<Vec<Vec<TextBlock>>, AiError> {
        let run = async {
            let prompt = prompt::build_prompt(req, &self.settings);
            let images: Vec<PageImage> = req.images.iter().chain(&req.key).cloned().collect();
            let Parsed {
                mut blocks,
                answered,
                skipped,
            } = self
                .ask("page", req, &prompt, &images, cancel, |raw| {
                    prompt::parse_blocks(raw, req, false)
                })
                .await?;
            // Um parágrafo inteiro às vezes é pulado junto com o desenho; perguntado sozinho, é traduzido.
            let missing: Vec<u32> = req
                .regions
                .iter()
                .filter(|r| {
                    !answered.contains(&r.id)
                        || (skipped.contains(&r.id) && r.glyphs >= SKIPPED_PARAGRAPH)
                })
                .map(|r| r.id)
                .collect();
            if !missing.is_empty() && !req.key.is_empty() {
                let follow = prompt::build_follow_up(&missing, req, &self.settings);
                let more = self
                    .ask("followup", req, &follow, &req.key, cancel, |raw| {
                        prompt::parse_blocks(raw, req, true)
                    })
                    .await?;
                for (list, extra) in blocks.iter_mut().zip(more.blocks) {
                    list.extend(extra);
                }
            }
            // Os modelos às vezes devolvem onomatopeias mesmo quando não se pede: ficam no desenho.
            let sfx = self.settings.translate_sfx;
            Ok(blocks
                .into_iter()
                .map(|list| {
                    list.into_iter()
                        .filter(|b| sfx || b.kind != BlockKind::Sfx)
                        .map(match_case)
                        .collect()
                })
                .collect())
        };
        run.await.map_err(|err| {
            if cancel.is_cancelled() {
                AiError::Cancelled
            } else {
                describe(err, &self.profile)
            }
        })
    }

    /// Os parágrafos de uma novel, um por um, com cache como as páginas.
    pub async fn translate_text(
        &self,
        paragraphs: &[String],
        context: &[String],
        cancel: &Cancel,
    ) -> Result<Vec<String>, AiError> {
        let prompt = prompt::build_novel_prompt(paragraphs, context, &self.settings);
        let req = TranslateRequest::default();
        let n = paragraphs.len();
        self.ask("text", &req, &prompt, &[], cancel, |raw| {
            prompt::parse_novel(raw, n)
        })
        .await
        .map_err(|err| {
            if cancel.is_cancelled() {
                AiError::Cancelled
            } else {
                describe(err, &self.profile)
            }
        })
    }

    /// Uma pergunta curta ao modelo de tradução, respondida em texto (sem imagem nem cache).
    pub async fn ask_text(&self, question: &str) -> Result<String, AiError> {
        let cancel = Cancel::default();
        tokio::time::timeout(
            std::time::Duration::from_secs(60),
            self.ask_raw(question, &[], &cancel, 0.0),
        )
        .await
        .map_err(|_| AiError::app("server", "A API não respondeu em 60s."))?
        .map_err(|e| describe(e, &self.profile))
    }
}

/// Letreiro em maiúsculas continua em maiúsculas: modelos pequenos respondem em caixa normal mesmo
/// quando o original está todo em maiúsculas.
fn match_case(mut block: TextBlock) -> TextBlock {
    let share = |text: &str, upper: bool| {
        let letters: Vec<char> = text
            .chars()
            .filter(|c| c.is_lowercase() || c.is_uppercase())
            .collect();
        if letters.is_empty() {
            return 0.0;
        }
        letters
            .iter()
            .filter(|c| {
                if upper {
                    c.is_uppercase()
                } else {
                    c.is_lowercase()
                }
            })
            .count() as f32
            / letters.len() as f32
    };
    if share(&block.original, true) >= 0.9 && share(&block.translation, false) > 0.0 {
        block.translation = block.translation.to_uppercase();
    }
    block
}

/// Manda um pedido mínimo com imagem, com um perfil que talvez ainda nem esteja salvo.
pub async fn test_api(profile: &ApiProfile, typed_key: Option<String>) -> Result<u128, AiError> {
    let key = typed_key
        .filter(|k| !k.trim().is_empty())
        .or_else(|| settings::api_key(&profile.id));
    let api_key = check_profile(profile, key)?;
    let cancel = Cancel::default();
    let started = std::time::Instant::now();
    let images = [providers::test_image()];
    let call = providers::call_model(Call {
        profile,
        api_key: &api_key,
        prompt: "Respond with the JSON object {\"ok\":true} and nothing else.",
        images: &images,
        temperature: 0.2,
        cpu: false,
        cancel: &cancel,
    });
    match tokio::time::timeout(std::time::Duration::from_secs(90), call).await {
        Ok(Ok(_)) => Ok(started.elapsed().as_millis()),
        Ok(Err(err)) => Err(describe(err, profile)),
        Err(_) => Err(AiError::app("server", "A API não respondeu em 90s.")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capitals_stay_capitals() {
        let b = TextBlock {
            original: "YOU ARE LOST".into(),
            translation: "Você está perdido".into(),
            ..Default::default()
        };
        assert_eq!(match_case(b).translation, "VOCÊ ESTÁ PERDIDO");
    }
}
