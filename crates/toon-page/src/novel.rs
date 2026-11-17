//! Novels (light novels e parecidos) são PDFs com camada de texto: as palavras saem dela em vez de
//! serem achadas numa imagem, vão para a IA parágrafo por parágrafo e são compostas de novo em páginas
//! do mesmo tamanho. Páginas que são imagem (capa, ilustrações) ficam como estão.

use std::sync::LazyLock;

use image::RgbImage;
use regex::Regex;
use toon_ai::{AiError, Cancel, FontRole, Ready};

use crate::chapter::{Output, Progress};
use crate::fonts::{Coverage, FACES, Pen};
use crate::pdf::{OutputPage, PdfPage, build_pdf, encode_jpeg};

/// Letras que uma página precisa ter na camada de texto para contar como texto.
const TEXT_PAGE: usize = 200;
/// Os parágrafos vão para a IA uns tantos caracteres por vez (uma ou duas páginas).
const BATCH_CHARS: usize = 3500;
const BATCH_PARAGRAPHS: usize = 40;
/// Largura das páginas compostas, em pixels.
const PAGE_WIDTH: u32 = 1100;

/// O texto de cada página, pela camada de texto do PDF.
pub fn page_texts(bytes: &[u8]) -> Vec<String> {
    crate::pdftext::pages_text(bytes)
}

/// Um PDF em que a maioria das páginas tem camada de texto: uma novel, não um quadrinho.
pub fn looks_like_novel(texts: &[String]) -> bool {
    !texts.is_empty() && texts.iter().filter(|t| t.chars().filter(|c| !c.is_whitespace()).count() >= TEXT_PAGE).count() * 2 >= texts.len()
}

#[derive(Debug, Clone)]
enum Piece {
    Paragraph { text: String, heading: bool },
    Break,
    Picture(usize),
}

static HEADING: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^(chapter|cap[ií]tulo|prologue|pr[oó]logo|epilogue|ep[ií]logo|interlude|afterword|posf[aá]cio|volume)\b").unwrap()
});
static ONLY_SYMBOLS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[\s*#◆◇♦●○•·~=\-–—_]+$").unwrap());
static PAGE_NUMBER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*\d{1,4}\s*$").unwrap());

/// O fluxo da novel na ordem de leitura: parágrafos (um parágrafo que passa de uma página para a
/// outra vira um só), quebras de cena e páginas de imagem.
fn flow(texts: &[String]) -> Vec<Piece> {
    let mut pieces: Vec<Piece> = Vec::new();
    let mut open: Option<String> = None;
    let close = |open: &mut Option<String>, pieces: &mut Vec<Piece>| {
        if let Some(t) = open.take().map(|t| t.trim().to_string()).filter(|t| !t.is_empty()) {
            pieces.push(Piece::Paragraph { text: t, heading: false });
        }
    };
    for (page, text) in texts.iter().enumerate() {
        if text.chars().filter(|c| !c.is_whitespace()).count() < TEXT_PAGE {
            close(&mut open, &mut pieces);
            pieces.push(Piece::Picture(page));
            continue;
        }
        let lines: Vec<&str> = text.lines().map(str::trim_end).filter(|l| !PAGE_NUMBER.is_match(l)).collect();
        for (i, line) in lines.iter().enumerate() {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                close(&mut open, &mut pieces);
                continue;
            }
            if ONLY_SYMBOLS.is_match(trimmed) {
                close(&mut open, &mut pieces);
                pieces.push(Piece::Break);
                continue;
            }
            let short = trimmed.chars().count() < 60;
            let next_blank = lines.get(i + 1).is_none_or(|l| l.trim().is_empty());
            if HEADING.is_match(trimmed) && short {
                close(&mut open, &mut pieces);
                pieces.push(Piece::Paragraph { text: trimmed.to_string(), heading: true });
                continue;
            }
            // Recuo no começo da linha ou travessão de fala abre um parágrafo novo.
            let starts = line.starts_with(|c: char| c.is_whitespace()) || trimmed.starts_with(['—', '–', '"', '“', '「']);
            if starts {
                close(&mut open, &mut pieces);
            }
            match &mut open {
                Some(t) => {
                    // Palavra hifenizada no fim da linha volta a ser uma.
                    if t.ends_with('-') && trimmed.starts_with(|c: char| c.is_lowercase()) {
                        t.pop();
                    } else {
                        t.push(' ');
                    }
                    t.push_str(trimmed);
                }
                None => open = Some(trimmed.to_string()),
            }
            let ended = trimmed.ends_with(['.', '!', '?', '"', '”', '」', '…']);
            if ended && (next_blank || short) {
                close(&mut open, &mut pieces);
            }
        }
    }
    close(&mut open, &mut pieces);
    pieces
}

/// Traduz os parágrafos em lotes; um lote que volta com parágrafos a mais ou a menos é dividido ao meio.
async fn translate_all(ready: &Ready, paragraphs: &[String], cancel: &Cancel, on_progress: &(impl Fn(Progress) + Sync)) -> Result<Vec<String>, AiError> {
    let mut out: Vec<String> = Vec::with_capacity(paragraphs.len());
    let mut start = 0;
    while start < paragraphs.len() {
        let mut end = start;
        let mut size = 0;
        while end < paragraphs.len() && end - start < BATCH_PARAGRAPHS && (size == 0 || size + paragraphs[end].len() <= BATCH_CHARS) {
            size += paragraphs[end].len();
            end += 1;
        }
        let context: Vec<String> = out.iter().rev().take(3).rev().cloned().collect();
        let translated = translate_batch(ready, &paragraphs[start..end], &context, cancel).await?;
        out.extend(translated);
        start = end;
        on_progress(Progress { done: start, total: paragraphs.len(), failed: 0 });
    }
    Ok(out)
}

fn translate_batch<'a>(
    ready: &'a Ready,
    batch: &'a [String],
    context: &'a [String],
    cancel: &'a Cancel,
) -> std::pin::Pin<Box<dyn Future<Output = Result<Vec<String>, AiError>> + Send + 'a>> {
    Box::pin(async move {
        match ready.translate_text(batch, context, cancel).await {
            Ok(list) => Ok(list),
            Err(AiError::App { code: "format", .. }) if batch.len() > 1 => {
                let half = batch.len() / 2;
                let mut first = translate_batch(ready, &batch[..half], context, cancel).await?;
                first.extend(translate_batch(ready, &batch[half..], context, cancel).await?);
                Ok(first)
            }
            Err(e) => Err(e),
        }
    })
}

/// Compõe o texto traduzido em páginas da proporção das originais, como imagem.
fn compose(pieces: &[Piece], translations: &[String], pictures: &[PdfPage], width_pt: f32, height_pt: f32) -> Vec<RgbImage> {
    let height = (PAGE_WIDTH as f32 * height_pt / width_pt).round() as u32;
    let margin = (PAGE_WIDTH as f32 * 0.09) as i64;
    let size = PAGE_WIDTH as f32 / 34.0;
    let line_h = size * 1.55;
    let body = Pen { font: FACES.face(FontRole::Serif, false), size };
    let title = Pen { font: FACES.face(FontRole::Serif, true), size: size * 1.4 };
    let max_w = PAGE_WIDTH as f32 - 2.0 * margin as f32;
    let mut pages: Vec<RgbImage> = Vec::new();
    let mut cover = Coverage::new(0, 0, PAGE_WIDTH as usize, height as usize);
    let mut y = margin as f32;
    let flush = |cover: &mut Coverage, pages: &mut Vec<RgbImage>| {
        let mut page = RgbImage::from_pixel(PAGE_WIDTH, height, image::Rgb([255, 255, 255]));
        cover.paint(&mut page, [20, 20, 20]);
        pages.push(page);
        *cover = Coverage::new(0, 0, PAGE_WIDTH as usize, height as usize);
    };
    let mut used = false;
    let mut next = 0;
    for piece in pieces {
        match piece {
            Piece::Picture(i) => {
                if used {
                    flush(&mut cover, &mut pages);
                    used = false;
                    y = margin as f32;
                }
                if let Some(p) = pictures.get(*i) {
                    let img = p.image.resize_exact(PAGE_WIDTH, height, image::imageops::FilterType::Triangle).to_rgb8();
                    pages.push(img);
                }
            }
            Piece::Break => {
                y += line_h;
                let w = body.width("◆ ◆ ◆");
                if y + line_h < (height as i64 - margin) as f32 {
                    body.rasterize(&mut cover, "* * *", (PAGE_WIDTH as f32 - w) / 2.0, y + size, 0.0);
                    used = true;
                }
                y += line_h * 1.5;
            }
            Piece::Paragraph { heading, .. } => {
                let text = translations.get(next).cloned().unwrap_or_default();
                next += 1;
                let pen = if *heading { &title } else { &body };
                let lh = if *heading { line_h * 1.4 } else { line_h };
                if *heading && used {
                    // Um título de capítulo abre página.
                    flush(&mut cover, &mut pages);
                    used = false;
                    y = margin as f32 + lh;
                }
                let indent = if *heading { 0.0 } else { size * 1.5 };
                let mut line = String::new();
                let mut first = true;
                let mut lines: Vec<(String, f32)> = Vec::new();
                for word in text.split_whitespace() {
                    let candidate = if line.is_empty() { word.to_string() } else { format!("{line} {word}") };
                    let room = max_w - if first { indent } else { 0.0 };
                    if !line.is_empty() && pen.width(&candidate) > room {
                        lines.push((std::mem::take(&mut line), if first { indent } else { 0.0 }));
                        first = false;
                        line = word.to_string();
                    } else {
                        line = candidate;
                    }
                }
                if !line.is_empty() {
                    lines.push((line, if first { indent } else { 0.0 }));
                }
                for (text, shift) in lines {
                    if y + lh > (height as i64 - margin) as f32 {
                        flush(&mut cover, &mut pages);
                        y = margin as f32;
                    }
                    let x = if *heading { (PAGE_WIDTH as f32 - pen.width(&text)) / 2.0 } else { margin as f32 + shift };
                    pen.rasterize(&mut cover, &text, x, y + size, 0.0);
                    used = true;
                    y += lh;
                }
                y += if *heading { lh } else { size * 0.35 };
            }
        }
    }
    if used {
        flush(&mut cover, &mut pages);
    }
    pages
}

/// Uma novel inteira: o texto lido do PDF, traduzido e composto de novo.
pub async fn translate_novel(
    ready: &Ready,
    bytes: Vec<u8>,
    title: &str,
    cancel: &Cancel,
    on_progress: impl Fn(Progress) + Sync,
) -> Result<Output, AiError> {
    let fail = |e: anyhow::Error| AiError::app("unknown", e.to_string());
    let (texts, pictures) = {
        let bytes = bytes.clone();
        tokio::task::spawn_blocking(move || (page_texts(&bytes), crate::pdf::read_pages(&bytes).unwrap_or_default()))
            .await
            .map_err(|e| AiError::app("unknown", e.to_string()))?
    };
    let pieces = flow(&texts);
    let paragraphs: Vec<String> = pieces.iter().filter_map(|p| if let Piece::Paragraph { text, .. } = p { Some(text.clone()) } else { None }).collect();
    if paragraphs.is_empty() {
        return Err(AiError::app("format", "Não achei texto nesse PDF: ele parece ser só imagens."));
    }
    let translations = translate_all(ready, &paragraphs, cancel, &on_progress).await?;
    let (width_pt, height_pt) = pictures.first().map(|p| (p.width_pt, p.height_pt)).unwrap_or((420.0, 595.0));
    let title = title.to_string();
    let original = bytes;
    tokio::task::spawn_blocking(move || {
        let pages = compose(&pieces, &translations, &pictures, width_pt, height_pt);
        let out: Vec<OutputPage> = pages
            .iter()
            .map(|p| Ok(OutputPage { jpeg: encode_jpeg(p, 88)?, width_px: p.width(), height_px: p.height(), width_pt, height_pt }))
            .collect::<anyhow::Result<_>>()?;
        let cover = pages.first().map(|p| encode_jpeg(&image::imageops::thumbnail(p, 254, 360), 80)).transpose()?.unwrap_or_default();
        Ok::<_, anyhow::Error>(Output {
            translated_pdf: build_pdf(&out, &title)?,
            original_pdf: original,
            cover_jpeg: cover,
            translated_pages: out.len(),
            errors: Vec::new(),
        })
    })
    .await
    .map_err(|e| AiError::app("unknown", e.to_string()))?
    .map_err(fail)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paragraphs_across_lines() {
        let page = format!(
            "Chapter 1\n\n{}\nfirst paragraph goes on here.\n\n“Hello,” she said.\n* * *\n{}",
            "The rain had not stopped since the morning and the".repeat(3),
            "x".repeat(250)
        );
        let pieces = flow(&[page]);
        assert!(matches!(&pieces[0], Piece::Paragraph { heading: true, .. }));
        assert!(matches!(&pieces[1], Piece::Paragraph { heading: false, text } if text.ends_with("goes on here.")));
        assert!(pieces.iter().any(|p| matches!(p, Piece::Break)));
    }
}
