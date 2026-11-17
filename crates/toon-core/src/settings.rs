//! `settings.json`: as configurações e, à parte, as chaves de API de cada perfil (criptografadas).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::paths::settings_file;
use crate::secrets;
use crate::store::write_json;

pub const AUTO_LANGUAGE: &str = "auto";
pub const LOCAL_AI_PROFILE_ID: &str = "local";
pub const LOCAL_AI_BASE_URL: &str = "http://127.0.0.1:47380/v1";

/// Idiomas: o valor vai para o modelo, então é em inglês.
pub const LANGUAGES: &[(&str, &str)] = &[
    ("Japanese", "Japonês"),
    ("Korean", "Coreano"),
    ("Simplified Chinese", "Chinês (simplificado)"),
    ("Traditional Chinese", "Chinês (tradicional)"),
    ("English", "Inglês"),
    ("Brazilian Portuguese", "Português (Brasil)"),
    ("European Portuguese", "Português (Portugal)"),
    ("Spanish", "Espanhol"),
    ("French", "Francês"),
    ("Italian", "Italiano"),
    ("German", "Alemão"),
    ("Russian", "Russo"),
    ("Indonesian", "Indonésio"),
    ("Thai", "Tailandês"),
    ("Vietnamese", "Vietnamita"),
    ("Arabic", "Árabe"),
];

pub fn language_label(value: &str) -> &str {
    if value == AUTO_LANGUAGE {
        return "Detectar automaticamente";
    }
    LANGUAGES.iter().find(|(v, _)| *v == value).map(|(_, l)| *l).unwrap_or(value)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderKind {
    /// API no formato da OpenAI (OpenAI, OpenRouter, Anthropic, Ollama, LM Studio…).
    #[default]
    Openai,
    /// O agente do Cursor, que só existia como SDK de Node: mantido para os perfis antigos abrirem.
    Cursor,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Thinking {
    #[default]
    Off,
    Low,
    Medium,
    High,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiProfile {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub kind: ProviderKind,
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub models: Vec<String>,
    #[serde(default)]
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking: Option<Thinking>,
}

impl ApiProfile {
    /// Um modelo servido neste PC (Ollama, LM Studio…): não precisa de chave.
    pub fn is_local(&self) -> bool {
        self.kind == ProviderKind::Openai
            && url::Url::parse(&self.base_url).is_ok_and(|u| {
                matches!(u.host_str(), Some("localhost" | "[::1]" | "0.0.0.0"))
                    || u.host_str().is_some_and(|h| h.starts_with("127."))
            })
    }

    pub fn is_anthropic(&self) -> bool {
        self.base_url.contains("anthropic.com")
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Speed {
    #[default]
    Fast,
    Balanced,
    Quality,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ContentType {
    #[default]
    Auto,
    Comic,
    Novel,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReaderMode {
    #[default]
    Scroll,
    Paged,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub active_profile_id: String,
    pub profiles: Vec<ApiProfile>,
    pub source_language: String,
    pub target_language: String,
    pub translate_sfx: bool,
    /// Uma página já traduzida volta da camada guardada em vez de ir de novo para a IA.
    pub reuse_layers: bool,
    pub content_type: ContentType,
    pub concurrency: u32,
    pub speed: Speed,
    /// Páginas deixadas sem traduzir no começo e no fim (créditos do grupo de scan).
    pub skip_start: u32,
    pub skip_end: u32,
    pub reader_mode: ReaderMode,
    pub gpu_sharing: String,
    pub ai_device: String,
    pub vision_device: String,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            active_profile_id: String::new(),
            profiles: Vec::new(),
            source_language: AUTO_LANGUAGE.into(),
            target_language: "Brazilian Portuguese".into(),
            translate_sfx: false,
            reuse_layers: true,
            content_type: ContentType::Auto,
            concurrency: 3,
            speed: Speed::Fast,
            skip_start: 0,
            skip_end: 0,
            reader_mode: ReaderMode::Scroll,
            gpu_sharing: "auto".into(),
            ai_device: "gpu".into(),
            vision_device: "gpu".into(),
            extra: Map::new(),
        }
    }
}

impl Settings {
    pub fn active_profile(&self) -> Option<&ApiProfile> {
        self.profiles.iter().find(|p| p.id == self.active_profile_id).or(self.profiles.first())
    }

    fn normalized(mut self) -> Self {
        self.profiles.retain(|p| !p.id.is_empty());
        for p in &mut self.profiles {
            p.model = p.model.trim().to_string();
            if p.kind == ProviderKind::Openai && !p.model.is_empty() && !p.models.contains(&p.model) {
                p.models.push(p.model.clone());
            }
        }
        if !self.profiles.iter().any(|p| p.id == self.active_profile_id) {
            self.active_profile_id = self.profiles.first().map(|p| p.id.clone()).unwrap_or_default();
        }
        let known = |l: &str| LANGUAGES.iter().any(|(v, _)| *v == l);
        if self.source_language != AUTO_LANGUAGE && !known(&self.source_language) {
            self.source_language = AUTO_LANGUAGE.into();
        }
        if !known(&self.target_language) {
            self.target_language = "Brazilian Portuguese".into();
        }
        self.concurrency = self.concurrency.clamp(1, 8);
        self.skip_start = self.skip_start.min(50);
        self.skip_end = self.skip_end.min(50);
        self
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct StoredKey {
    value: String,
    encrypted: bool,
}

#[derive(Default, Serialize, Deserialize)]
struct StoredFile {
    #[serde(default)]
    settings: Settings,
    #[serde(default)]
    keys: BTreeMap<String, StoredKey>,
}

fn read_store() -> StoredFile {
    let store: StoredFile = crate::store::read_json(&settings_file());
    StoredFile { settings: store.settings.normalized(), keys: store.keys }
}

pub fn load() -> Settings {
    read_store().settings
}

/// A chave do perfil, aberta só na hora de usar.
pub fn api_key(profile_id: &str) -> Option<String> {
    let entry = read_store().keys.remove(profile_id)?;
    if entry.encrypted { secrets::decrypt(&entry.value).ok() } else { Some(entry.value) }
}

/// Os últimos 4 caracteres de cada chave, para a pessoa ver qual está guardada.
pub fn key_hints() -> BTreeMap<String, String> {
    let store = read_store();
    store
        .settings
        .profiles
        .iter()
        .filter_map(|p| {
            let key = api_key(&p.id)?;
            let tail: String = key.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect();
            Some((p.id.clone(), tail))
        })
        .collect()
}

/// Grava as configurações. Só os perfis em `keys` têm a chave trocada; texto vazio apaga a chave.
pub fn save(settings: Settings, keys: &BTreeMap<String, String>) -> anyhow::Result<Settings> {
    let mut store = read_store();
    store.settings = settings.normalized();
    let ids: Vec<&str> = store.settings.profiles.iter().map(|p| p.id.as_str()).collect();
    store.keys.retain(|id, _| ids.contains(&id.as_str()));
    for (id, key) in keys {
        if !ids.contains(&id.as_str()) {
            continue;
        }
        let key = key.trim();
        if key.is_empty() {
            store.keys.remove(id);
        } else {
            store.keys.insert(id.clone(), StoredKey { value: secrets::encrypt(key)?, encrypted: true });
        }
    }
    write_json(&settings_file(), &store)?;
    Ok(store.settings)
}
