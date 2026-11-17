//! Páginas traduzidas guardadas só com o que a tradução mudou nelas, um arquivo pequeno por página em
//! `translation-layers`, com o nome tirado da própria página: um capítulo apagado e traduzido de novo
//! volta daqui em segundos, sem ir para a IA.

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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageLayer {
    pub width: u32,
    pub height: u32,
    pub block_count: usize,
    pub patches: Vec<Patch>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Patch {
    pub x: u32,
    pub y: u32,
    /// O pedaço da página traduzida, em WebP, em base64.
    pub webp: String,
}

/// O nome do arquivo de uma página: o idioma e as opções de tradução, o tamanho e uma cópia reduzida
/// dos pixels. A mesma página do mesmo capítulo dá sempre o mesmo nome.
pub fn key(image: &RgbImage, tag: &str) -> String {
    let h = ((image.height() as f32 / image.width() as f32) * 256.0)
        .round()
        .max(1.0) as u32;
    let small = image::imageops::resize(image, 256, h, image::imageops::FilterType::Triangle);
    let mut hash = Sha256::new();
    hash.update(format!("rust|{tag}|{}x{}|", image.width(), image.height()).as_bytes());
    hash.update(small.as_raw());
    hex::encode(hash.finalize())
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
        width,
        height,
        block_count,
        patches,
    })
}

/// Põe os pedaços guardados sobre a página; `false` quando a camada é de outro tamanho.
pub fn apply(image: &mut RgbImage, layer: &PageLayer) -> bool {
    if (layer.width, layer.height) != image.dimensions() {
        return false;
    }
    for patch in &layer.patches {
        let Ok(bytes) = B64.decode(&patch.webp) else {
            return false;
        };
        let Ok(piece) = image::load_from_memory(&bytes) else {
            return false;
        };
        image::imageops::replace(image, &piece.to_rgb8(), patch.x as i64, patch.y as i64);
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layer_rebuilds_the_page() {
        let before = RgbImage::from_pixel(100, 120, image::Rgb([250, 250, 250]));
        let mut after = before.clone();
        for y in 30..50 {
            for x in 10..60 {
                after.put_pixel(x, y, image::Rgb([0, 0, 0]));
            }
        }
        let layer = extract(&before, &after, 1).unwrap();
        assert_eq!(layer.patches.len(), 1);
        let mut again = before.clone();
        assert!(apply(&mut again, &layer));
        assert_eq!(again, after);
    }
}
