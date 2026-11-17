//! As imagens que o modelo recebe: a página com cada bloco achado numa caixa magenta numerada, e a
//! "chave", cada bloco recortado e ampliado com o número ao lado.

use image::{Rgb, RgbImage};
use toon_ai::FontRole;

use crate::detect::IBox;
use crate::fonts::{Coverage, FACES, Pen};

const MARK: Rgb<u8> = Rgb([0xff, 0x00, 0xcc]);
const KEY_WIDTH: u32 = 1024;
const KEY_MAX_HEIGHT: u32 = 1536;
/// Altura de letra para a qual as regiões são ampliadas (ou reduzidas) na chave.
const KEY_LETTER: f32 = 28.0;

pub struct Mark {
    pub id: u32,
    pub r#box: IBox,
}

fn fill_rect(image: &mut RgbImage, x0: i64, y0: i64, x1: i64, y1: i64, color: Rgb<u8>) {
    let (w, h) = (image.width() as i64, image.height() as i64);
    for y in y0.max(0)..y1.min(h) {
        for x in x0.max(0)..x1.min(w) {
            image.put_pixel(x as u32, y as u32, color);
        }
    }
}

fn label(image: &mut RgbImage, text: &str, x: f32, y_top: f32, size: f32) {
    let pen = Pen { font: FACES.face(FontRole::Sans, true), size };
    let cap = pen.cap_ratio() * size;
    let mut cover = Coverage::new(x as i64 - 2, y_top as i64 - 2, (pen.width(text) + 6.0) as usize, (size * 1.4) as usize + 4);
    pen.rasterize(&mut cover, text, x, y_top + cap + (size - cap) / 2.0, 0.0);
    cover.paint(image, [255, 255, 255]);
}

/// Uma cópia da imagem com cada região contornada e etiquetada com o número dela.
pub fn draw_marks(source: &RgbImage, marks: &[Mark]) -> RgbImage {
    let mut image = source.clone();
    let (w, h) = (image.width() as i64, image.height() as i64);
    let line = (w / 400).max(2);
    let font = ((w as f32 / 50.0).clamp(13.0, 24.0)).round();
    for m in marks {
        // Por fora dos traços, para a caixa nunca esconder parte de uma letra.
        let pad = line + 3;
        let x0 = (m.r#box[0] as i64 - pad).max(0);
        let y0 = (m.r#box[1] as i64 - pad).max(0);
        let x1 = (m.r#box[2] as i64 + pad).min(w);
        let y1 = (m.r#box[3] as i64 + pad).min(h);
        fill_rect(&mut image, x0, y0, x1, y0 + line, MARK);
        fill_rect(&mut image, x0, y1 - line, x1, y1, MARK);
        fill_rect(&mut image, x0, y0, x0 + line, y1, MARK);
        fill_rect(&mut image, x1 - line, y0, x1, y1, MARK);
        let text = m.id.to_string();
        let pen = Pen { font: FACES.face(FontRole::Sans, true), size: font };
        let tw = pen.width(&text) as i64 + 8;
        let th = font as i64 + 4;
        let tx = x0.min(w - tw);
        let ty = if y0 - th >= 0 { y0 - th } else { y1.min(h - th) };
        fill_rect(&mut image, tx, ty, tx + tw, ty + th, MARK);
        label(&mut image, &text, tx as f32 + 4.0, ty as f32 + 2.0, font);
    }
    image
}

pub struct KeyRegion<'a> {
    pub id: u32,
    pub source: &'a RgbImage,
    pub r#box: IBox,
    pub letter_height: f32,
}

/// Cada região recortada da sua imagem, numa altura de letra legível e com o número, empacotadas no
/// menor número de imagens: o modelo lê cada caixa ali e vê a página para o contexto.
pub fn draw_key(regions: &[KeyRegion]) -> Vec<RgbImage> {
    let gap = 10u32;
    let font = 20.0;
    let tag_w = 44u32;
    struct Tile {
        id: u32,
        crop: RgbImage,
        x: u32,
        y: u32,
    }
    let mut sheets: Vec<(Vec<Tile>, u32)> = Vec::new();
    let mut sheet: (Vec<Tile>, u32) = (Vec::new(), gap);
    let (mut x, mut row_top, mut row_h) = (gap, gap, 0u32);
    for r in regions {
        let pad = (r.letter_height * 0.4).round() as usize;
        let x0 = r.r#box[0].saturating_sub(pad);
        let y0 = r.r#box[1].saturating_sub(pad);
        let x1 = (r.r#box[2] + pad).min(r.source.width() as usize);
        let y1 = (r.r#box[3] + pad).min(r.source.height() as usize);
        if x1 <= x0 || y1 <= y0 {
            continue;
        }
        let s = (KEY_LETTER / r.letter_height.max(1.0))
            .clamp(0.6, 3.0)
            .min((KEY_WIDTH - tag_w - 2 * gap) as f32 / (x1 - x0) as f32)
            .min((KEY_MAX_HEIGHT - 2 * gap) as f32 / (y1 - y0) as f32);
        let tw = (((x1 - x0) as f32 * s).round() as u32).max(1);
        let th = (((y1 - y0) as f32 * s).round() as u32).max(1);
        let cut = image::imageops::crop_imm(r.source, x0 as u32, y0 as u32, (x1 - x0) as u32, (y1 - y0) as u32).to_image();
        let crop = image::imageops::resize(&cut, tw, th, image::imageops::FilterType::CatmullRom);
        let width = tag_w + tw + gap;
        if x + width > KEY_WIDTH {
            x = gap;
            row_top += row_h + gap;
            row_h = 0;
        }
        if row_top + th + gap > KEY_MAX_HEIGHT && !sheet.0.is_empty() {
            sheets.push(std::mem::replace(&mut sheet, (Vec::new(), gap)));
            x = gap;
            row_top = gap;
            row_h = 0;
        }
        sheet.1 = sheet.1.max(row_top + th + gap);
        sheet.0.push(Tile { id: r.id, crop, x, y: row_top });
        x += width;
        row_h = row_h.max(th);
    }
    if !sheet.0.is_empty() {
        sheets.push(sheet);
    }
    sheets
        .into_iter()
        .map(|(tiles, height)| {
            let mut image = RgbImage::from_pixel(KEY_WIDTH, height, Rgb([0x55, 0x55, 0x55]));
            for t in tiles {
                let tag_h = t.crop.height().min(font as u32 + 12);
                fill_rect(&mut image, t.x as i64, t.y as i64, (t.x + tag_w - 4) as i64, (t.y + tag_h) as i64, MARK);
                label(&mut image, &t.id.to_string(), t.x as f32 + 4.0, t.y as f32 + (tag_h as f32 - font) / 2.0, font);
                image::imageops::replace(&mut image, &t.crop, (t.x + tag_w) as i64, t.y as i64);
            }
            image
        })
        .collect()
}
