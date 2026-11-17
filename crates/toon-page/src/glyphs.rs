//! Primitivas de pixel da detecção e do overlay: morfologia, componentes conexos e o teste de letra.

/// Distância máxima de cinza para o entorno de uma letra contar como fundo liso.
pub const FLAT_TOLERANCE: i32 = 28;

/// Uma imagem em tons de cinza, uma linha depois da outra.
pub struct Gray {
    pub w: usize,
    pub h: usize,
    pub px: Vec<u8>,
}

impl Gray {
    pub fn from_rgba(rgba: &image::RgbaImage) -> Gray {
        let (w, h) = (rgba.width() as usize, rgba.height() as usize);
        let px = rgba
            .pixels()
            .map(|p| ((p[0] as u32 * 77 + p[1] as u32 * 150 + p[2] as u32 * 29) >> 8) as u8)
            .collect();
        Gray { w, h, px }
    }

    pub fn from_rgb(rgb: &image::RgbImage) -> Gray {
        let (w, h) = (rgb.width() as usize, rgb.height() as usize);
        let px = rgb
            .pixels()
            .map(|p| ((p[0] as u32 * 77 + p[1] as u32 * 150 + p[2] as u32 * 29) >> 8) as u8)
            .collect();
        Gray { w, h, px }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct Comp {
    pub id: i32,
    pub x0: usize,
    pub y0: usize,
    pub x1: usize,
    pub y1: usize,
    pub w: usize,
    pub h: usize,
    pub count: usize,
}

/// Arredonda como o `Math.round` do JavaScript nos valores positivos que aparecem aqui.
pub fn round(v: f64) -> usize {
    (v + 0.5).floor().max(0.0) as usize
}

/// Uma letra fica sobre fundo liso (a maior parte dos pixels em volta tem o mesmo cinza) e se
/// distingue bem dele. Desenho falha no primeiro teste; os vãos de fundo entre letras, no segundo.
pub fn is_glyph(
    c: &Comp,
    gray: &[u8],
    ink: &[u8],
    labels: &[i32],
    ww: usize,
    wh: usize,
    tolerance: i32,
) -> bool {
    let e = round(c.h as f64 * 0.35).max(2);
    let x0 = c.x0.saturating_sub(e);
    let y0 = c.y0.saturating_sub(e);
    let x1 = (c.x1 + e).min(ww);
    let y1 = (c.y1 + e).min(wh);
    let step = round((((x1 - x0) * (y1 - y0)) as f64 / 300.0).sqrt()).max(1);
    let mut around = Vec::new();
    let (mut own, mut own_count) = (0u64, 0u64);
    for y in (y0..y1).step_by(step) {
        for x in (x0..x1).step_by(step) {
            let p = y * ww + x;
            if ink[p] == 0 {
                around.push(gray[p] as i32);
            } else if labels[p] == c.id {
                own += gray[p] as u64;
                own_count += 1;
            }
        }
    }
    if around.len() < 8 {
        return false;
    }
    let median = quantile(&around, 0.5);
    let flat = around
        .iter()
        .filter(|&&v| (v - median).abs() <= tolerance)
        .count();
    if (flat as f64) / (around.len() as f64) < 0.6 {
        return false;
    }
    own_count == 0 || ((own as f64 / own_count as f64) - median as f64).abs() >= 50.0
}

/// Componentes conexos (vizinhança de 8) de uma máscara binária. Os rótulos começam em 1.
pub fn components(mask: &[u8], ww: usize, wh: usize) -> (Vec<i32>, Vec<Comp>) {
    let mut labels = vec![0i32; ww * wh];
    let mut stack: Vec<usize> = Vec::new();
    let mut comps = Vec::new();
    for start in 0..mask.len() {
        if mask[start] == 0 || labels[start] != 0 {
            continue;
        }
        let id = comps.len() as i32 + 1;
        let (mut x0, mut y0, mut x1, mut y1, mut count) = (ww, wh, 0, 0, 0);
        stack.push(start);
        labels[start] = id;
        while let Some(p) = stack.pop() {
            let (x, y) = (p % ww, p / ww);
            count += 1;
            x0 = x0.min(x);
            y0 = y0.min(y);
            x1 = x1.max(x + 1);
            y1 = y1.max(y + 1);
            for ny in y.saturating_sub(1)..=(y + 1).min(wh - 1) {
                for nx in x.saturating_sub(1)..=(x + 1).min(ww - 1) {
                    let q = ny * ww + nx;
                    if mask[q] != 0 && labels[q] == 0 {
                        labels[q] = id;
                        stack.push(q);
                    }
                }
            }
        }
        comps.push(Comp {
            id,
            x0,
            y0,
            x1,
            y1,
            w: x1 - x0,
            h: y1 - y0,
            count,
        });
    }
    (labels, comps)
}

pub fn dilate(src: &[u8], ww: usize, wh: usize, k: usize) -> Vec<u8> {
    morph(src, ww, wh, k, true)
}

pub fn erode(src: &[u8], ww: usize, wh: usize, k: usize) -> Vec<u8> {
    morph(src, ww, wh, k, false)
}

/// Filtro de máximo (ou mínimo) quadrado de lado k, separável, van Herk / Gil-Werman: O(1) por pixel.
fn morph(src: &[u8], ww: usize, wh: usize, k: usize, max: bool) -> Vec<u8> {
    let r = k / 2;
    let size = ww.max(wh) + 2 * r;
    let mut line = vec![0u8; size];
    let mut g = vec![0u8; size];
    let mut h = vec![0u8; size];
    let pick = |a: u8, b: u8| if max { a.max(b) } else { a.min(b) };
    let mut run = |n: usize, read: &dyn Fn(usize) -> u8, out: &mut dyn FnMut(usize, u8)| {
        let m = n + 2 * r;
        for (i, slot) in line.iter_mut().enumerate().take(m) {
            *slot = read(i.saturating_sub(r).min(n - 1));
        }
        for i in 0..m {
            g[i] = if i % k == 0 {
                line[i]
            } else {
                pick(line[i], g[i - 1])
            };
        }
        for i in (0..m).rev() {
            h[i] = if i == m - 1 || (i + 1) % k == 0 {
                line[i]
            } else {
                pick(line[i], h[i + 1])
            };
        }
        for i in 0..n {
            out(i, pick(h[i], g[i + 2 * r]));
        }
    };
    let mut tmp = vec![0u8; ww * wh];
    for y in 0..wh {
        let row = y * ww;
        run(ww, &|i| src[row + i], &mut |i, v| tmp[row + i] = v);
    }
    let mut out = vec![0u8; ww * wh];
    for x in 0..ww {
        run(wh, &|i| tmp[i * ww + x], &mut |i, v| out[i * ww + x] = v);
    }
    out
}

pub fn quantile<T: Copy + PartialOrd + Default>(values: &[T], q: f64) -> T {
    if values.is_empty() {
        return T::default();
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    sorted[((sorted.len() as f64 * q).floor() as usize).min(sorted.len() - 1)]
}

pub fn odd(n: usize) -> usize {
    if n % 2 == 1 { n } else { n + 1 }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn morphology_matches_naive() {
        let (w, h) = (9, 7);
        let src: Vec<u8> = (0..w * h).map(|i| ((i * 37) % 251) as u8).collect();
        let fast = dilate(&src, w, h, 3);
        for y in 0..h {
            for x in 0..w {
                let mut m = 0;
                for dy in -1i32..=1 {
                    for dx in -1i32..=1 {
                        let yy = (y as i32 + dy).clamp(0, h as i32 - 1) as usize;
                        let xx = (x as i32 + dx).clamp(0, w as i32 - 1) as usize;
                        m = m.max(src[yy * w + xx]);
                    }
                }
                assert_eq!(fast[y * w + x], m);
            }
        }
    }
}
