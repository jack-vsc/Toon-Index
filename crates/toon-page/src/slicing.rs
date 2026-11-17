//! Páginas altas (webtoon) vão para o modelo em faixas. Os cortes caem nas linhas em branco entre os
//! quadros quando dá, para nenhum balão ser cortado; sem vão, as faixas se sobrepõem.

use image::RgbImage;

const SAMPLE_WIDTH: u32 = 200;
/// Uma linha é vão quando quase nenhum pixel foge do tom dominante dela.
const BLANK_ROW_BUSYNESS: f32 = 0.01;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Slice {
    pub y0: u32,
    pub y1: u32,
}

/// Corta a página em faixas de mais ou menos `slice_height`. As linhas em `keep` (texto conhecido,
/// cujo espaço entre linhas parece vão) nunca são cortadas.
pub fn plan_slices(image: &RgbImage, slice_height: u32, overlap: u32, keep: &[(f32, f32)]) -> Vec<Slice> {
    let height = image.height();
    if height as f32 <= slice_height as f32 * 1.15 {
        return vec![Slice { y0: 0, y1: height }];
    }
    let busy = row_busyness(image);
    let ratio = height as f32 / busy.len() as f32;
    let is_blank = |y: f32| {
        let row = ((y / ratio).floor() as usize).min(busy.len() - 1);
        busy[row] < BLANK_ROW_BUSYNESS && !keep.iter().any(|&(a, b)| y > a && y < b)
    };
    let mut slices = Vec::new();
    let mut start = 0u32;
    while (height - start) as f32 > slice_height as f32 * 1.15 {
        let target = start + slice_height;
        let earliest = start as f32 + slice_height as f32 * 0.55;
        let mut cut = None;
        let mut y = target as f32;
        while y >= earliest {
            if is_blank(y) {
                cut = Some(y.round() as u32);
                break;
            }
            y -= ratio;
        }
        match cut {
            Some(c) => {
                slices.push(Slice { y0: start, y1: c });
                start = c;
            }
            None => {
                slices.push(Slice { y0: start, y1: target });
                start = target - overlap;
            }
        }
    }
    slices.push(Slice { y0: start, y1: height });
    slices
}

/// Fração de pixels "fora do fundo" em cada linha, numa cópia reduzida em cinza.
fn row_busyness(image: &RgbImage) -> Vec<f32> {
    let w = SAMPLE_WIDTH.min(image.width());
    let h = ((image.height() as f32 * w as f32 / image.width() as f32).round() as u32).max(1);
    let small = image::imageops::resize(image, w, h, image::imageops::FilterType::Triangle);
    let mut result = Vec::with_capacity(h as usize);
    let mut row = vec![0u8; w as usize];
    for y in 0..h {
        for x in 0..w {
            let p = small.get_pixel(x, y);
            row[x as usize] = ((p[0] as u32 * 299 + p[1] as u32 * 587 + p[2] as u32 * 114) / 1000) as u8;
        }
        let mut sorted = row.clone();
        sorted.sort_unstable();
        let median = sorted[(w >> 1) as usize] as i32;
        let differing = row.iter().filter(|&&v| (v as i32 - median).abs() > 24).count();
        result.push(differing as f32 / w as f32);
    }
    result
}
