//! Uma página do começo ao fim: na resolução de saída, cortada em faixas, com as caixas marcadas,
//! traduzida pelo modelo e com a tradução escrita por cima.

use image::RgbImage;
use toon_ai::{Cancel, MarkedRegion, PageImage, Ready, TextBlock, TranslateRequest};

use crate::detect::{TextRegion, detect_text};
use crate::glyphs::Gray;
use crate::marks::{KeyRegion, Mark, draw_key, draw_marks};
use crate::overlay::{draw_overlay, normalize_text, similar_text};
use crate::pdf::{PdfPage, is_tall};
use crate::slicing::{Slice, plan_slices};

/// Largura de saída das páginas, em pixels.
pub const OUTPUT_WIDTH: u32 = 1400;
pub const OUTPUT_WIDTH_TALL: u32 = 1000;
/// Lado maior de cada imagem mandada ao modelo; os modelos de visão reduzem acima de ~1568 px.
const AI_LONG_SIDE: u32 = 1568;
const AI_LONG_SIDE_TALL: u32 = 1280;
/// As faixas de uma página alta têm umas 1,6 vez a largura de altura.
const SLICE_ASPECT: f32 = 1.6;
const SLICE_OVERLAP: f32 = 0.45;
const MAX_IMAGES_PER_REQUEST: usize = 6;
/// Lado maior que uma imagem pode ter sem estourar memória.
const MAX_SIDE: u32 = 32_000;

/// A página na largura de saída, como o app sempre mandou traduzir.
pub fn render(page: &PdfPage) -> RgbImage {
    let width = if is_tall(page.width_pt, page.height_pt) {
        OUTPUT_WIDTH_TALL
    } else {
        OUTPUT_WIDTH
    };
    let src = page.image.to_rgb8();
    let scale = (width as f32 / src.width() as f32).min(MAX_SIDE as f32 / src.height() as f32);
    let (w, h) = (
        ((src.width() as f32 * scale).round() as u32).max(1),
        ((src.height() as f32 * scale).round() as u32).max(1),
    );
    if (w, h) == src.dimensions() {
        src
    } else {
        image::imageops::resize(&src, w, h, image::imageops::FilterType::CatmullRom)
    }
}

/// Uma cópia do pedaço da imagem, reduzida para o lado maior caber em `long_side`.
pub fn crop(image: &RgbImage, y0: u32, y1: u32, long_side: u32) -> RgbImage {
    let part = image::imageops::crop_imm(image, 0, y0, image.width(), y1 - y0).to_image();
    let scale = (long_side as f32 / part.width().max(part.height()) as f32).min(1.0);
    if scale >= 1.0 {
        return part;
    }
    let (w, h) = (
        ((part.width() as f32 * scale).round() as u32).max(1),
        ((part.height() as f32 * scale).round() as u32).max(1),
    );
    image::imageops::resize(&part, w, h, image::imageops::FilterType::Triangle)
}

pub struct PreparedSlice {
    pub crop: RgbImage,
    pub regions: Vec<TextRegion>,
    pub offset_y: f32,
    /// Pixels da página por pixel da faixa.
    pub scale: f32,
}

/// Sem os blocos dos modelos de visão, as linhas em que o detector acha texto na página inteira: o vão
/// entre duas linhas de narração sobre branco parece o vão entre quadros, e um corte ali deixava as
/// linhas de baixo na borda da faixa, descartadas como texto cortado.
fn text_rows(image: &RgbImage, slice_height: u32, long_side: u32) -> Vec<(f32, f32)> {
    if image.height() as f32 <= slice_height as f32 * 1.15 {
        return Vec::new();
    }
    let whole = crop(image, 0, image.height(), long_side);
    let scale = image.width() as f32 / whole.width() as f32;
    detect_text(&Gray::from_rgb(&whole))
        .into_iter()
        .map(|r| {
            (
                (r.r#box[1] as f32 - r.letter_height as f32) * scale,
                (r.r#box[3] as f32 + r.letter_height as f32) * scale,
            )
        })
        .collect()
}

/// Corta a página nas faixas mandadas ao modelo e acha o texto em cada uma.
pub fn prepare_slices(image: &RgbImage, tall: bool) -> Vec<PreparedSlice> {
    let slice_height = (image.width() as f32 * SLICE_ASPECT).round() as u32;
    let long_side = if tall {
        AI_LONG_SIDE_TALL
    } else {
        AI_LONG_SIDE
    };
    let keep = text_rows(image, slice_height, long_side);
    let slices: Vec<Slice> = plan_slices(
        image,
        slice_height,
        (slice_height as f32 * SLICE_OVERLAP).round() as u32,
        &keep,
    );
    let mut prepared: Vec<PreparedSlice> = slices
        .iter()
        .map(|s| {
            let crop = crop(image, s.y0, s.y1, long_side);
            let scale = image.width() as f32 / crop.width() as f32;
            let (cut_top, cut_bottom) = (s.y0 > 0, s.y1 < image.height());
            let regions = detect_text(&Gray::from_rgb(&crop))
                .into_iter()
                .filter(|r| {
                    !(cut_top && r.r#box[1] <= 2)
                        && !(cut_bottom && r.r#box[3] + 2 >= crop.height() as usize)
                })
                .collect();
            PreparedSlice {
                crop,
                regions,
                offset_y: s.y0 as f32,
                scale,
            }
        })
        .collect();
    box_once(&mut prepared);
    prepared
}

/// Texto na sobra entre duas faixas é achado nas duas, às vezes cortado numa. Cada texto fica só com a
/// caixa mais completa (a maior, longe do corte), para o modelo ler uma vez e inteiro.
fn box_once(slices: &mut [PreparedSlice]) {
    struct Seen {
        slice: usize,
        index: usize,
        page: [f32; 4],
        score: f32,
    }
    let mut all = Vec::new();
    for (i, s) in slices.iter().enumerate() {
        for (j, r) in s.regions.iter().enumerate() {
            let b = r.r#box.map(|v| v as f32);
            let page = [
                b[0] * s.scale,
                b[1] * s.scale + s.offset_y,
                b[2] * s.scale,
                b[3] * s.scale + s.offset_y,
            ];
            let margin = b[1].min(s.crop.height() as f32 - b[3]);
            let area = (page[2] - page[0]) * (page[3] - page[1]);
            all.push(Seen {
                slice: i,
                index: j,
                page,
                score: area
                    * if margin >= r.letter_height as f32 {
                        1.0
                    } else {
                        0.5
                    },
            });
        }
    }
    let mut dropped = std::collections::HashSet::new();
    for a in &all {
        for b in &all {
            if a.slice == b.slice
                || dropped.contains(&(a.slice, a.index))
                || dropped.contains(&(b.slice, b.index))
            {
                continue;
            }
            let ix = a.page[2].min(b.page[2]) - a.page[0].max(b.page[0]);
            let iy = a.page[3].min(b.page[3]) - a.page[1].max(b.page[1]);
            let area = |p: [f32; 4]| (p[2] - p[0]) * (p[3] - p[1]);
            if ix > 0.0 && iy > 0.0 && ix * iy > 0.3 * area(a.page).min(area(b.page)) {
                dropped.insert(if a.score >= b.score {
                    (b.slice, b.index)
                } else {
                    (a.slice, a.index)
                });
            }
        }
    }
    for (i, s) in slices.iter_mut().enumerate() {
        let mut j = 0;
        s.regions.retain(|_| {
            let keep = !dropped.contains(&(i, j));
            j += 1;
            keep
        });
    }
}

fn jpeg_image(image: &RgbImage) -> PageImage {
    let bytes = crate::pdf::encode_jpeg(image, 85).unwrap_or_default();
    PageImage::jpeg(&bytes, image.width(), image.height())
}

/// Numera as regiões no pedido inteiro, desenha nas imagens e monta a chave.
pub fn marked_request(
    part: &[&PreparedSlice],
    page_number: u32,
    chapter: Option<String>,
) -> TranslateRequest {
    let mut regions = Vec::new();
    let mut images = Vec::new();
    let mut key_regions = Vec::new();
    for (image, slice) in part.iter().enumerate() {
        let mut marks = Vec::new();
        for r in &slice.regions {
            let id = regions.len() as u32 + 1;
            regions.push(MarkedRegion {
                id,
                image,
                r#box: r.r#box.map(|v| v as f32),
                letter_height: r.letter_height as f32,
                glyphs: r.glyphs as u32,
            });
            marks.push(Mark { id, r#box: r.r#box });
            key_regions.push(KeyRegion {
                id,
                source: &slice.crop,
                r#box: r.r#box,
                letter_height: r.letter_height as f32,
            });
        }
        images.push(jpeg_image(&draw_marks(&slice.crop, &marks)));
    }
    let key = draw_key(&key_regions).iter().map(jpeg_image).collect();
    TranslateRequest {
        images,
        key,
        regions,
        page_number,
        chapter,
    }
}

fn to_page_space(mut b: TextBlock, scale: f32, offset_y: f32) -> TextBlock {
    let map = |x: [f32; 4]| {
        [
            x[0] * scale,
            x[1] * scale + offset_y,
            x[2] * scale,
            x[3] * scale + offset_y,
        ]
    };
    b.text_box = map(b.text_box);
    b.area_box = map(b.area_box);
    b.ink_boxes = b.ink_boxes.map(|list| list.into_iter().map(map).collect());
    b.letter_height = b.letter_height.map(|h| h * scale);
    b
}

/// Faixas sobrepostas mandam o mesmo balão duas vezes, com caixas e palavras um pouco diferentes; fica
/// a cópia mais completa.
pub fn dedupe(blocks: Vec<TextBlock>) -> Vec<TextBlock> {
    let area = |b: [f32; 4]| (b[2] - b[0]).max(0.0) * (b[3] - b[1]).max(0.0);
    let score = |b: &TextBlock| {
        (if b.ink_boxes.is_some() { 1e15 } else { 0.0 })
            + normalize_text(&b.original).chars().count() as f64 * 1e9
            + area(b.text_box) as f64
    };
    let mut sorted = blocks;
    sorted.sort_by(|a, b| {
        score(b)
            .partial_cmp(&score(a))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let mut kept: Vec<TextBlock> = Vec::new();
    for block in sorted {
        let duplicate = kept.iter().any(|k| {
            let (a, b) = (k.text_box, block.text_box);
            let ix = a[2].min(b[2]) - a[0].max(b[0]);
            let iy = a[3].min(b[3]) - a[1].max(b[1]);
            if ix > 0.0 && iy > 0.0 && ix * iy / area(a).min(area(b)).max(1.0) > 0.5 {
                return true;
            }
            let height = (a[3] - a[1]).max(b[3] - b[1]);
            ix > 0.0 && iy > -2.0 * height && similar_text(&k.original, &block.original)
        });
        if !duplicate {
            kept.push(block);
        }
    }
    kept.sort_by(|a, b| {
        a.text_box[1]
            .partial_cmp(&b.text_box[1])
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    kept
}

/// Manda as faixas ao modelo, até seis por pedido; os blocos voltam em pixels da página.
pub async fn translate_slices(
    ready: &Ready,
    prepared: &[PreparedSlice],
    page_number: u32,
    chapter: Option<String>,
    cancel: &Cancel,
) -> Result<Vec<TextBlock>, toon_ai::AiError> {
    let parts: Vec<Vec<&PreparedSlice>> = prepared
        .chunks(MAX_IMAGES_PER_REQUEST)
        .map(|c| c.iter().collect())
        .collect();
    let requests: Vec<TranslateRequest> = parts
        .iter()
        .map(|p| marked_request(p, page_number, chapter.clone()))
        .collect();
    let answers =
        futures::future::try_join_all(requests.iter().map(|r| ready.translate_page(r, cancel)))
            .await?;
    let mut blocks = Vec::new();
    for (part, lists) in parts.iter().zip(answers) {
        for (slice, list) in part.iter().zip(lists) {
            blocks.extend(
                list.into_iter()
                    .map(|b| to_page_space(b, slice.scale, slice.offset_y)),
            );
        }
    }
    Ok(dedupe(blocks))
}

/// Uma página traduzida: a imagem pronta e quantos blocos foram escritos.
pub struct Translated {
    pub image: RgbImage,
    pub blocks: Vec<TextBlock>,
}

pub async fn translate_page(
    ready: &Ready,
    page: &PdfPage,
    page_number: u32,
    chapter: Option<String>,
    cancel: &Cancel,
) -> Result<Translated, toon_ai::AiError> {
    let mut image = render(page);
    let tall = is_tall(page.width_pt, page.height_pt);
    let prepared = {
        let image = image.clone();
        tokio::task::spawn_blocking(move || prepare_slices(&image, tall))
            .await
            .expect("faixas")
    };
    let blocks = translate_slices(ready, &prepared, page_number, chapter, cancel).await?;
    let (image, blocks) = tokio::task::spawn_blocking(move || {
        draw_overlay(&mut image, &blocks);
        (image, blocks)
    })
    .await
    .expect("overlay");
    Ok(Translated { image, blocks })
}
