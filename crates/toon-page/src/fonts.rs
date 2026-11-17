//! As fontes do letreiro (todas de licença aberta, em `assets/fonts`) e o desenho de texto sobre a
//! imagem. Letras que a fonte não tem (cirílico, tailandês, árabe…) vêm de uma fonte do Windows.

use std::sync::LazyLock;

use ab_glyph::{Font, FontArc, Glyph, PxScale, ScaleFont, point};
use image::RgbImage;
use toon_ai::FontRole;

macro_rules! face {
    ($file:literal) => {
        FontArc::try_from_slice(include_bytes!(concat!("../../../assets/fonts/", $file))).expect($file)
    };
}

pub struct Faces {
    comic: [FontArc; 3],
    brush: FontArc,
    condensed: [FontArc; 5],
    sans: [FontArc; 2],
    serif: [FontArc; 2],
    handwritten: [FontArc; 2],
    fallback: Option<FontArc>,
}

pub static FACES: LazyLock<Faces> = LazyLock::new(|| Faces {
    comic: [face!("comic-neue-300.ttf"), face!("comic-neue-400.ttf"), face!("comic-neue-700.ttf")],
    brush: face!("bangers-400.ttf"),
    condensed: [
        face!("oswald-200.ttf"),
        face!("oswald-300.ttf"),
        face!("oswald-400.ttf"),
        face!("oswald-500.ttf"),
        face!("oswald-600.ttf"),
    ],
    sans: [face!("roboto-400.ttf"), face!("roboto-700.ttf")],
    serif: [face!("noto-serif-400.ttf"), face!("noto-serif-700.ttf")],
    handwritten: [face!("kalam-400.ttf"), face!("kalam-700.ttf")],
    fallback: ["C:\\Windows\\Fonts\\segoeui.ttf", "C:\\Windows\\Fonts\\arial.ttf"]
        .iter()
        .find_map(|p| std::fs::read(p).ok())
        .and_then(|b| FontArc::try_from_vec(b).ok()),
});

impl Faces {
    /// A face do papel com peso perto do pedido (0 = a mais leve).
    pub fn face(&self, role: FontRole, bold: bool) -> &FontArc {
        match role {
            FontRole::Comic => &self.comic[if bold { 2 } else { 1 }],
            FontRole::Brush => &self.brush,
            FontRole::Condensed => &self.condensed[if bold { 4 } else { 2 }],
            FontRole::Sans => &self.sans[bold as usize],
            FontRole::Serif => &self.serif[bold as usize],
            FontRole::Handwritten => &self.handwritten[bold as usize],
        }
    }

    pub fn fallback(&self) -> Option<&FontArc> {
        self.fallback.as_ref()
    }
}

/// Uma fonte e o tamanho em pixels; mede e desenha linhas.
pub struct Pen<'a> {
    pub font: &'a FontArc,
    pub size: f32,
}

impl Pen<'_> {
    fn pick(&self, c: char) -> &FontArc {
        if self.font.glyph_id(c).0 == 0 && !c.is_whitespace() {
            if let Some(f) = FACES.fallback().filter(|f| f.glyph_id(c).0 != 0) {
                return f;
            }
        }
        self.font
    }

    /// Altura das maiúsculas sobre o tamanho da fonte.
    pub fn cap_ratio(&self) -> f32 {
        let glyph = self.font.glyph_id('H').with_scale(PxScale::from(100.0));
        self.font.outline_glyph(glyph).map(|g| g.px_bounds().height() / 100.0).unwrap_or(0.7)
    }

    pub fn width(&self, text: &str) -> f32 {
        let mut x = 0.0;
        let mut prev: Option<(ab_glyph::GlyphId, *const FontArc)> = None;
        for c in text.chars() {
            let font = self.pick(c);
            let scaled = font.as_scaled(PxScale::from(self.size));
            let id = font.glyph_id(c);
            if let Some((p, f)) = prev {
                if std::ptr::eq(f, font) {
                    x += scaled.kern(p, id);
                }
            }
            x += scaled.h_advance(id);
            prev = Some((id, font as *const _));
        }
        x
    }

    /// Escreve `text` na máscara de cobertura (0 a 1), com a linha de base em `baseline` e o começo em `x`.
    /// `slant` inclina para a direita (itálico de mentira), em pixels por pixel de altura.
    pub fn rasterize(&self, cover: &mut Coverage, text: &str, x: f32, baseline: f32, slant: f32) {
        let mut caret = x;
        for c in text.chars() {
            let font = self.pick(c);
            let scaled = font.as_scaled(PxScale::from(self.size));
            let id = font.glyph_id(c);
            let glyph: Glyph = id.with_scale_and_position(PxScale::from(self.size), point(caret, baseline));
            if let Some(outlined) = font.outline_glyph(glyph) {
                let b = outlined.px_bounds();
                outlined.draw(|gx, gy, v| {
                    let py = b.min.y + gy as f32;
                    let shift = (baseline - py) * slant;
                    let px = (b.min.x + gx as f32 + shift).round() as i64;
                    cover.add(px, py as i64, v);
                });
            }
            caret += scaled.h_advance(id);
        }
    }
}

/// Quanto cada pixel de uma região está coberto pelo texto.
pub struct Coverage {
    pub x0: i64,
    pub y0: i64,
    pub w: usize,
    pub h: usize,
    pub v: Vec<f32>,
}

impl Coverage {
    pub fn new(x0: i64, y0: i64, w: usize, h: usize) -> Self {
        Coverage { x0, y0, w, h, v: vec![0.0; w * h] }
    }

    fn add(&mut self, x: i64, y: i64, a: f32) {
        let (lx, ly) = (x - self.x0, y - self.y0);
        if lx >= 0 && ly >= 0 && (lx as usize) < self.w && (ly as usize) < self.h {
            let p = ly as usize * self.w + lx as usize;
            self.v[p] = (self.v[p] + a).min(1.0);
        }
    }

    /// A mesma cobertura engrossada `r` pixels para todos os lados: o contorno das letras.
    pub fn grown(&self, r: f32) -> Coverage {
        let ri = r.ceil() as i64;
        let mut out = Coverage::new(self.x0, self.y0, self.w, self.h);
        if ri == 0 {
            out.v.copy_from_slice(&self.v);
            return out;
        }
        let offsets: Vec<(i64, i64, f32)> = (-ri..=ri)
            .flat_map(|dy| (-ri..=ri).map(move |dx| (dx, dy)))
            .filter_map(|(dx, dy)| {
                let d = ((dx * dx + dy * dy) as f32).sqrt();
                (d <= r + 0.5).then(|| (dx, dy, (r + 0.5 - d).clamp(0.0, 1.0)))
            })
            .collect();
        for y in 0..self.h as i64 {
            for x in 0..self.w as i64 {
                let mut best = 0.0f32;
                for &(dx, dy, edge) in &offsets {
                    let (nx, ny) = (x + dx, y + dy);
                    if nx >= 0 && ny >= 0 && nx < self.w as i64 && ny < self.h as i64 {
                        best = best.max(self.v[ny as usize * self.w + nx as usize] * edge);
                        if best >= 1.0 {
                            break;
                        }
                    }
                }
                out.v[y as usize * self.w + x as usize] = best;
            }
        }
        out
    }

    /// Pinta a cor na imagem na proporção da cobertura.
    pub fn paint(&self, image: &mut RgbImage, color: [u8; 3]) {
        for y in 0..self.h {
            for x in 0..self.w {
                let a = self.v[y * self.w + x];
                if a <= 0.0 {
                    continue;
                }
                let (ix, iy) = (self.x0 + x as i64, self.y0 + y as i64);
                if ix < 0 || iy < 0 || ix >= image.width() as i64 || iy >= image.height() as i64 {
                    continue;
                }
                let px = image.get_pixel_mut(ix as u32, iy as u32);
                for k in 0..3 {
                    px[k] = (px[k] as f32 * (1.0 - a) + color[k] as f32 * a).round() as u8;
                }
            }
        }
    }
}
