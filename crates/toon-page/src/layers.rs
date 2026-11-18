//! Páginas traduzidas guardadas só com o que a tradução mudou nelas, um arquivo pequeno por página em
//! `translation-layers`: um capítulo apagado e traduzido de novo volta daqui em segundos, sem ir
//! para a IA.
//!
//! O nome do arquivo vem dos bytes da imagem original como estão no PDF (`pdf::source_hash`), não dos
//! pixels desenhados, e os pedaços se ajustam a outro tamanho de saída: outro leitor de PDF, outra
//! linguagem ou outra largura de página acham e usam as mesmas camadas. O formato está descrito em
//! `docs/CAMADAS.md` para quem for ler estes arquivos de fora.

use std::io::Cursor;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use image::RgbImage;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use toon_core::paths::layers_dir;

/// Lado dos quadrados comparados entre a página original e a traduzida.
const CELL: u32 = 24;
/// Diferença por canal abaixo da qual o pixel conta como igual (ruído do JPEG).
const TOLERANCE: i16 = 6;
/// A versão do formato, gravada em cada arquivo.
pub const FORMAT: u32 = 2;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageLayer {
    #[serde(default)]
    pub format: u32,
    /// O SHA-256 da imagem original (ver `pdf::source_hash`).
    #[serde(default)]
    pub source: String,
    /// Idioma e opções da tradução: "Brazilian Portuguese|sfx:false".
    #[serde(default)]
    pub tag: String,
    /// O tamanho da página em que os pedaços foram tirados.
    pub width: u32,
    pub height: u32,
    pub block_count: usize,
    pub patches: Vec<Patch>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Patch {
    pub x: u32,
    pub y: u32,
    /// O pedaço da página traduzida, em WebP sem perda, em base64.
    pub webp: String,
}

/// O nome do arquivo de uma página: a impressão digital da imagem original e as opções da tradução.
pub fn key(source: &str, tag: &str) -> String {
    hex::encode(Sha256::digest(
        format!("toon-layer/{FORMAT}|{tag}|{source}").as_bytes(),
    ))
}

fn file(key: &str) -> std::path::PathBuf {
    layers_dir().join(format!("{key}.json"))
}

pub fn read(key: &str) -> Option<PageLayer> {
    serde_json::from_slice(&std::fs::read(file(key)).ok()?).ok()
}

pub fn save(key: &str, layer: &PageLayer) -> anyhow::Result<()> {
    toon_core::store::write_json(&file(key), layer)
}

/// Os pedaços de `after` que diferem de `before` (do mesmo tamanho).
pub fn extract(before: &RgbImage, after: &RgbImage, block_count: usize) -> Option<PageLayer> {
    if before.dimensions() != after.dimensions() {
        return None;
    }
    let (width, height) = after.dimensions();
    let cols = width.div_ceil(CELL) as usize;
    let rows = height.div_ceil(CELL) as usize;
    let mut changed = vec![false; cols * rows];
    for y in 0..height {
        let row = (y / CELL) as usize;
        let mut x = 0;
        while x < width {
            let (a, b) = (before.get_pixel(x, y), after.get_pixel(x, y));
            if (0..3).any(|k| (a[k] as i16 - b[k] as i16).abs() > TOLERANCE) {
                changed[row * cols + (x / CELL) as usize] = true;
                // O resto desta célula na linha não acrescenta nada.
                x = (x / CELL + 1) * CELL;
                continue;
            }
            x += 1;
        }
    }
    // Células mudadas que se tocam (cantos também) viram um pedaço, cortado pela caixa em volta delas.
    let mut seen = vec![false; cols * rows];
    let mut patches = Vec::new();
    for start in 0..changed.len() {
        if !changed[start] || seen[start] {
            continue;
        }
        let (mut x0, mut y0, mut x1, mut y1) =
            (start % cols, start / cols, start % cols, start / cols);
        let mut stack = vec![start];
        seen[start] = true;
        while let Some(cell) = stack.pop() {
            let (cx, cy) = (cell % cols, cell / cols);
            x0 = x0.min(cx);
            x1 = x1.max(cx);
            y0 = y0.min(cy);
            y1 = y1.max(cy);
            for ny in cy.saturating_sub(1)..=(cy + 1).min(rows - 1) {
                for nx in cx.saturating_sub(1)..=(cx + 1).min(cols - 1) {
                    let next = ny * cols + nx;
                    if changed[next] && !seen[next] {
                        seen[next] = true;
                        stack.push(next);
                    }
                }
            }
        }
        let (x, y) = (x0 as u32 * CELL, y0 as u32 * CELL);
        let w = width.min((x1 as u32 + 1) * CELL) - x;
        let h = height.min((y1 as u32 + 1) * CELL) - y;
        let piece = image::imageops::crop_imm(after, x, y, w, h).to_image();
        let mut bytes = Vec::new();
        image::codecs::webp::WebPEncoder::new_lossless(Cursor::new(&mut bytes))
            .encode(piece.as_raw(), w, h, image::ExtendedColorType::Rgb8)
            .ok()?;
        patches.push(Patch {
            x,
            y,
            webp: B64.encode(bytes),
        });
    }
    Some(PageLayer {
        format: FORMAT,
        source: String::new(),
        tag: String::new(),
        width,
        height,
        block_count,
        patches,
    })
}

/// Põe os pedaços guardados sobre a página. Uma página de outro tamanho, na mesma proporção, recebe
/// os pedaços redimensionados; `false` quando a proporção não bate.
pub fn apply(image: &mut RgbImage, layer: &PageLayer) -> bool {
    let (w, h) = image.dimensions();
    if layer.width == 0 || layer.height == 0 {
        return false;
    }
    let (sx, sy) = (
        w as f64 / layer.width as f64,
        h as f64 / layer.height as f64,
    );
    if (sx - sy).abs() > sx.max(sy) * 0.01 {
        return false;
    }
    for patch in &layer.patches {
        let Ok(bytes) = B64.decode(&patch.webp) else {
            return false;
        };
        let Ok(piece) = image::load_from_memory(&bytes) else {
            return false;
        };
        let mut piece = piece.to_rgb8();
        let (mut x, mut y) = (patch.x as i64, patch.y as i64);
        if (layer.width, layer.height) != (w, h) {
            let x1 = ((patch.x + piece.width()) as f64 * sx).round() as i64;
            let y1 = ((patch.y + piece.height()) as f64 * sy).round() as i64;
            x = (patch.x as f64 * sx).round() as i64;
            y = (patch.y as f64 * sy).round() as i64;
            let (pw, ph) = ((x1 - x).max(1) as u32, (y1 - y).max(1) as u32);
            piece =
                image::imageops::resize(&piece, pw, ph, image::imageops::FilterType::CatmullRom);
        }
        image::imageops::replace(image, &piece, x, y);
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pages() -> (RgbImage, RgbImage) {
        let before = RgbImage::from_pixel(100, 120, image::Rgb([250, 250, 250]));
        let mut after = before.clone();
        for y in 30..50 {
            for x in 10..60 {
                after.put_pixel(x, y, image::Rgb([0, 0, 0]));
            }
        }
        (before, after)
    }

    #[test]
    fn layer_rebuilds_the_page() {
        let (before, after) = pages();
        let layer = extract(&before, &after, 1).unwrap();
        assert_eq!(layer.patches.len(), 1);
        let mut again = before.clone();
        assert!(apply(&mut again, &layer));
        assert_eq!(again, after);
    }

    #[test]
    fn layer_fits_a_page_of_another_size() {
        let (before, after) = pages();
        let layer = extract(&before, &after, 1).unwrap();
        let mut bigger = RgbImage::from_pixel(200, 240, image::Rgb([250, 250, 250]));
        assert!(apply(&mut bigger, &layer));
        assert_eq!(bigger.get_pixel(70, 80)[0], 0);
        assert_eq!(bigger.get_pixel(150, 200)[0], 250);
        let mut other = RgbImage::from_pixel(200, 100, image::Rgb([250, 250, 250]));
        assert!(!apply(&mut other, &layer));
    }

    #[test]
    fn key_depends_only_on_source_and_options() {
        assert_eq!(key("abc", "pt|sfx:false"), key("abc", "pt|sfx:false"));
        assert_ne!(key("abc", "pt|sfx:false"), key("abc", "pt|sfx:true"));
    }
}
