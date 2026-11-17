//! Um capítulo inteiro: as páginas traduzidas algumas ao mesmo tempo, o PDF traduzido e a capa.

use std::sync::Arc;

use futures::StreamExt;
use image::RgbImage;
use toon_ai::{AiError, Cancel, Ready};

use crate::page::{render, translate_page};
use crate::pdf::{OutputPage, PdfPage, build_pdf, encode_jpeg};

const COVER_LONG_SIDE: u32 = 360;
const JPEG_QUALITY: u8 = 90;

/// Páginas de um capítulo baixado como imagens (JPEG, PNG, WebP…), na ordem de leitura.
pub fn pages_from_images(images: &[Vec<u8>]) -> anyhow::Result<Vec<PdfPage>> {
    images
        .iter()
        .map(|bytes| {
            let image = image::load_from_memory(bytes)?;
            let jpeg = image::guess_format(bytes)
                .ok()
                .filter(|f| *f == image::ImageFormat::Jpeg)
                .map(|_| bytes.clone());
            // 96 pontos por polegada, como o navegador mostra.
            let (w, h) = (image.width() as f32 * 0.75, image.height() as f32 * 0.75);
            Ok(PdfPage {
                image,
                jpeg,
                width_pt: w,
                height_pt: h,
            })
        })
        .collect()
}

#[derive(Debug, Clone, Copy, Default)]
pub struct Progress {
    pub done: usize,
    pub total: usize,
    pub failed: usize,
}

pub struct Options {
    pub skip_start: usize,
    pub skip_end: usize,
    pub concurrency: usize,
    pub chapter: String,
}

pub struct Output {
    pub translated_pdf: Vec<u8>,
    pub original_pdf: Vec<u8>,
    pub cover_jpeg: Vec<u8>,
    pub translated_pages: usize,
    /// Páginas que deram erro e saíram como estavam, com o motivo.
    pub errors: Vec<(usize, String)>,
}

fn output_page(image: &RgbImage, page: &PdfPage) -> anyhow::Result<OutputPage> {
    // A página pode ter crescido embaixo (notas das placas): o tamanho físico cresce junto.
    let height_pt = page.height_pt * image.height() as f32 / render_height(page) as f32;
    Ok(OutputPage {
        jpeg: encode_jpeg(image, JPEG_QUALITY)?,
        width_px: image.width(),
        height_px: image.height(),
        width_pt: page.width_pt,
        height_pt,
    })
}

fn render_height(page: &PdfPage) -> u32 {
    let width = if crate::pdf::is_tall(page.width_pt, page.height_pt) {
        crate::page::OUTPUT_WIDTH_TALL
    } else {
        crate::page::OUTPUT_WIDTH
    };
    ((page.image.height() as f32 * width as f32 / page.image.width() as f32).round() as u32).max(1)
}

/// O PDF das páginas como vieram: os JPEGs originais sem recomprimir quando dá.
pub fn original_pdf(pages: &[PdfPage], title: &str) -> anyhow::Result<Vec<u8>> {
    let out: Vec<OutputPage> = pages
        .iter()
        .map(|p| {
            let jpeg = match &p.jpeg {
                Some(j) => j.clone(),
                None => encode_jpeg(&p.image.to_rgb8(), JPEG_QUALITY)?,
            };
            Ok(OutputPage {
                jpeg,
                width_px: p.image.width(),
                height_px: p.image.height(),
                width_pt: p.width_pt,
                height_pt: p.height_pt,
            })
        })
        .collect::<anyhow::Result<_>>()?;
    build_pdf(&out, title)
}

pub fn cover_of(page: &PdfPage) -> anyhow::Result<Vec<u8>> {
    let thumb = page
        .image
        .thumbnail(COVER_LONG_SIDE, COVER_LONG_SIDE)
        .to_rgb8();
    encode_jpeg(&thumb, 80)
}

/// Traduz as páginas; uma página com erro sai como estava (e conta em `errors`), um erro de conta
/// (chave, cota, créditos) para tudo.
pub async fn translate_chapter(
    ready: Arc<Ready>,
    pages: Arc<Vec<PdfPage>>,
    options: Options,
    cancel: Cancel,
    on_progress: impl Fn(Progress) + Send + Sync,
) -> Result<Output, AiError> {
    let total = pages.len();
    let mut progress = Progress {
        done: 0,
        total,
        failed: 0,
    };
    on_progress(progress);
    let skip = |i: usize| i < options.skip_start || i + options.skip_end >= total;
    let mut results: Vec<Option<RgbImage>> = vec![None; total];
    let mut errors = Vec::new();
    let mut stream = futures::stream::iter(0..total)
        .map(|i| {
            let ready = ready.clone();
            let pages = pages.clone();
            let cancel = cancel.clone();
            let chapter = options.chapter.clone();
            async move {
                if skip(i) {
                    return (i, Ok(None));
                }
                let r =
                    translate_page(&ready, &pages[i], i as u32 + 1, Some(chapter), &cancel).await;
                (i, r.map(|t| Some(t.image)))
            }
        })
        .buffer_unordered(options.concurrency.max(1));
    while let Some((i, result)) = stream.next().await {
        match result {
            Ok(image) => results[i] = image,
            Err(AiError::Cancelled) => return Err(AiError::Cancelled),
            Err(
                err @ AiError::App {
                    code: "auth" | "quota" | "credits" | "model" | "vision",
                    ..
                },
            ) => return Err(err),
            Err(err) => {
                tracing::warn!("página {} falhou: {err}", i + 1);
                errors.push((i + 1, err.to_string()));
                progress.failed += 1;
            }
        }
        progress.done += 1;
        on_progress(progress);
    }
    drop(stream);
    let translated_pages = results.iter().filter(|r| r.is_some()).count();
    let out: Vec<OutputPage> = pages
        .iter()
        .zip(results)
        .map(|(page, image)| output_page(&image.unwrap_or_else(|| render(page)), page))
        .collect::<anyhow::Result<_>>()
        .map_err(|e| AiError::app("unknown", e.to_string()))?;
    let translated_pdf =
        build_pdf(&out, &options.chapter).map_err(|e| AiError::app("unknown", e.to_string()))?;
    let original_pdf = original_pdf(&pages, &options.chapter)
        .map_err(|e| AiError::app("unknown", e.to_string()))?;
    let cover_jpeg = pages
        .first()
        .map(cover_of)
        .transpose()
        .map_err(|e| AiError::app("unknown", e.to_string()))?
        .unwrap_or_default();
    Ok(Output {
        translated_pdf,
        original_pdf,
        cover_jpeg,
        translated_pages,
        errors,
    })
}
