//! Toda página traduzida por um modelo Claude vira exemplo de treino para um modelo menor (o projeto
//! Manga Detector Pipeline), no layout do Manga109:
//!
//! - `training-dataset/images/<hash>.jpg`: cada imagem mandada ao modelo, uma vez só (reduzida);
//! - `training-dataset/annotations/<capítulo>.jsonl`: uma linha por pedido, com as imagens, as caixas
//!   marcadas, o prompt e a resposta crua;
//! - `training-dataset/recorded.txt`: as chaves já guardadas, para não repetir.
//!
//! `MI_DATASET=0` desliga.

use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::sync::Mutex;

use base64::Engine;
use sha1::{Digest, Sha1};
use toon_core::paths::dataset_dir;

use crate::types::{PageImage, TranslateRequest};

const STORED_SIDE: u32 = 768;
const STORED_QUALITY: u8 = 75;

/// As chaves já guardadas, lidas do disco na primeira vez.
static RECORDED: Mutex<Option<HashSet<String>>> = Mutex::new(None);

pub struct Example<'a> {
    pub key: &'a str,
    pub req: &'a TranslateRequest,
    pub kind: &'a str,
    pub prompt: &'a str,
    pub images: &'a [PageImage],
    pub answer: &'a str,
    pub model: &'a str,
    pub speed: &'a str,
}

fn keep_image(img: &PageImage) -> anyhow::Result<(String, [u32; 2])> {
    let mut hash = Sha1::new();
    hash.update(img.base64.as_bytes());
    let file = format!("{}.jpg", &hex::encode(hash.finalize())[..24]);
    let scale = (STORED_SIDE as f32 / img.width.max(img.height) as f32).min(1.0);
    let stored = [
        (img.width as f32 * scale).round() as u32,
        (img.height as f32 * scale).round() as u32,
    ];
    let path = dataset_dir().join("images").join(&file);
    if !path.exists() {
        let bytes = base64::engine::general_purpose::STANDARD.decode(&img.base64)?;
        let mut image = image::load_from_memory(&bytes)?;
        if scale < 1.0 {
            image = image.resize_exact(stored[0], stored[1], image::imageops::FilterType::Triangle);
        }
        let mut out = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, STORED_QUALITY)
            .encode_image(&image.to_rgb8())?;
        fs::write(path, out)?;
    }
    Ok((file, stored))
}

/// Nome de capítulo vira nome de arquivo: sai o que o Windows recusa.
fn file_name(chapter: &str) -> String {
    let clean: String = chapter
        .chars()
        .map(|c| {
            if "<>:\"/\\|?*".contains(c) || c < ' ' {
                ' '
            } else {
                c
            }
        })
        .collect();
    let clean = clean.split_whitespace().collect::<Vec<_>>().join(" ");
    let clean: String = clean.chars().take(150).collect();
    if clean.is_empty() {
        "sem-nome".into()
    } else {
        clean
    }
}

pub fn record(ex: Example) {
    if std::env::var("MI_DATASET").as_deref() == Ok("0")
        || !ex.model.to_lowercase().contains("claude")
    {
        return;
    }
    // O conjunto de treino é um subproduto: disco cheio ou arquivo travado não param a tradução.
    if let Err(err) = try_record(&ex) {
        tracing::error!("exemplo de treino não guardado: {err}");
    }
}

fn try_record(ex: &Example) -> anyhow::Result<()> {
    let root = dataset_dir();
    let mut guard = RECORDED.lock().unwrap();
    let keys = guard.get_or_insert_with(|| {
        fs::read_to_string(root.join("recorded.txt"))
            .map(|t| t.lines().map(str::to_string).collect())
            .unwrap_or_else(|_| HashSet::new())
    });
    if keys.contains(ex.key) {
        return Ok(());
    }
    fs::create_dir_all(root.join("images"))?;
    fs::create_dir_all(root.join("annotations"))?;
    let images: Vec<serde_json::Value> = ex
        .images
        .iter()
        .map(|img| {
            keep_image(img).map(|(file, stored)| serde_json::json!({ "file": file, "stored": stored, "width": img.width, "height": img.height }))
        })
        .collect::<anyhow::Result<_>>()?;
    let chapter = ex.req.chapter.clone().unwrap_or_default();
    let line = serde_json::json!({
        "key": ex.key,
        "chapter": chapter,
        "page": ex.req.page_number,
        "kind": ex.kind,
        "model": ex.model,
        "speed": ex.speed,
        "images": images,
        "slices": if ex.kind == "page" { ex.req.images.len() } else { 0 },
        "regions": ex.req.regions,
        "prompt": ex.prompt,
        "answer": ex.answer,
        "at": now_iso(),
    });
    let mut out = OpenOptions::new().create(true).append(true).open(
        root.join("annotations")
            .join(format!("{}.jsonl", file_name(&chapter))),
    )?;
    writeln!(out, "{line}")?;
    let mut done = OpenOptions::new()
        .create(true)
        .append(true)
        .open(root.join("recorded.txt"))?;
    writeln!(done, "{}", ex.key)?;
    keys.insert(ex.key.to_string());
    Ok(())
}

/// Data e hora em UTC no formato do `toISOString()`.
fn now_iso() -> String {
    let ms = toon_core::now_ms();
    let secs = ms.div_euclid(1000);
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    let (h, m, s) = (rem / 3600, rem % 3600 / 60, rem % 60);
    // Dias desde 1970 para data civil (algoritmo de Howard Hinnant).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if mo <= 2 { y + 1 } else { y };
    format!(
        "{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{s:02}.{:03}Z",
        ms.rem_euclid(1000)
    )
}
