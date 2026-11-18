//! Apaga o texto original de cada bloco e escreve a tradução por cima: primeiro acha as letras de
//! todos os blocos na página intacta, depois apaga, depois escreve, para nenhum passo ver o resultado
//! de outro.

use image::RgbImage;
use toon_ai::{BlockKind, FontRole, TextBlock};

use crate::detect::IBox;
use crate::fonts::{Coverage, FACES, Pen};
use crate::glyphs::{FLAT_TOLERANCE, components, dilate, erode, is_glyph, odd, quantile, round};
use crate::vision::{self, GlyphMask, Scene, SfxShape};

const MIN_FONT: f32 = 8.0;
const INK_STRONG: i32 = 45;
const INK_WEAK: i32 = 22;
/// Fração da largura e da altura do balão que a tradução pode ocupar.
const FILL: f32 = 0.84;
/// Distância por canal para um pixel contar como fundo do balão ao medir o balão.
const BG_TOLERANCE: i32 = 42;
/// Distância entre linhas sobre a altura das maiúsculas.
const LINE_PITCH: f32 = 1.55;

/// O que o overlay achou e fez com um bloco.
#[derive(Debug, Clone)]
pub struct Drawn {
    pub drawn: bool,
    pub skipped: Option<&'static str>,
    pub letter_height: f32,
    pub font_size: Option<f32>,
}

struct Glyphs {
    win: IBox,
    ww: usize,
    wh: usize,
    /// 1 = pixel de uma letra original, em coordenadas da janela.
    mask: Vec<u8>,
    /// 1 = qualquer traço fino, escuro ou claro.
    ink: Vec<u8>,
    /// Caixa das letras na página.
    bbox: Option<IBox>,
    letter_height: f32,
}

/// Placas e narração só sobre o desenho vão numa nota embaixo do quadro, não por cima da arte.
fn is_footnote(block: &TextBlock) -> bool {
    block.kind == BlockKind::Signage
        || (block.kind == BlockKind::Narration && block.ink_boxes.is_none())
}

pub fn normalize_text(text: &str) -> String {
    text.to_lowercase()
        .chars()
        .filter(|c| c.is_alphanumeric())
        .collect()
}

/// Coeficiente de Dice em pares de letras, ou um texto contido no outro (bloco cortado na faixa).
pub fn similar_text(a: &str, b: &str) -> bool {
    let (x, y) = (normalize_text(a), normalize_text(b));
    if x.is_empty() || y.is_empty() {
        return false;
    }
    let (short, long) = if x.chars().count() <= y.chars().count() {
        (&x, &y)
    } else {
        (&y, &x)
    };
    if long.contains(short.as_str()) {
        return short.chars().count() as f32 >= 8f32.min(long.chars().count() as f32 * 0.4);
    }
    let grams = |s: &str| {
        let c: Vec<char> = s.chars().collect();
        let mut m = std::collections::HashMap::new();
        for w in c.windows(2) {
            *m.entry((w[0], w[1])).or_insert(0) += 1;
        }
        m
    };
    let (gx, gy) = (grams(&x), grams(&y));
    let common: i32 = gx
        .iter()
        .map(|(g, n)| *n.min(gy.get(g).unwrap_or(&0)))
        .sum();
    let total = (x.chars().count() + y.chars().count())
        .saturating_sub(2)
        .max(1);
    2.0 * common as f32 / total as f32 > 0.6
}

fn estimate_letter(block: &TextBlock) -> f32 {
    let tb = block.text_box;
    let (w, h) = (tb[2] - tb[0], tb[3] - tb[1]);
    let lines = block.original.split('\n').count().max(1) as f32;
    let chars = block
        .original
        .chars()
        .filter(|c| !c.is_whitespace())
        .count()
        .max(1) as f32;
    if lines > 1.0 {
        h / lines / 1.25
    } else {
        (h / 1.25).min((w * h / (chars * 0.7 * 1.3)).sqrt())
    }
}

fn to_ibox(b: [f32; 4], w: usize, h: usize) -> IBox {
    [
        (b[0].round().max(0.0) as usize).min(w),
        (b[1].round().max(0.0) as usize).min(h),
        (b[2].round().max(0.0) as usize).min(w),
        (b[3].round().max(0.0) as usize).min(h),
    ]
}

fn expand(b: [f32; 4], px: f32, py: f32) -> [f32; 4] {
    [b[0] - px, b[1] - py, b[2] + px, b[3] + py]
}

/// Escreve as traduções na página. Devolve o que fez com cada bloco; a página pode crescer embaixo
/// (notas das placas).
///
/// Com a `scene` dos modelos de visão, o LaMa repinta embaixo do texto e as onomatopeias são apagadas
/// pelo desenho das letras; sem ela (ou com o servidor falhando), o preenchimento próprio apaga.
pub fn draw_overlay(
    image: &mut RgbImage,
    blocks: &[TextBlock],
    scene: Option<&Scene>,
) -> Vec<Drawn> {
    let (w, h) = (image.width() as usize, image.height() as usize);
    let found: Vec<Glyphs> = blocks.iter().map(|b| find_glyphs(image, b, w, h)).collect();
    // Onomatopeias são traços de pincel sobre o desenho: a forma delas vem da máscara dos modelos.
    let sfx: Vec<Option<SfxShape>> = blocks
        .iter()
        .enumerate()
        .map(|(i, block)| {
            let scene = scene?;
            if block.kind != BlockKind::Sfx {
                return None;
            }
            let b = found[i].page_box().unwrap_or(block.text_box);
            let pad = (b[2] - b[0]).max(b[3] - b[1]) * 0.1;
            Some(vision::sfx_shape(
                scene,
                expand(b, pad, pad),
                found[i].bbox.map(|_| found[i].glyph_mask()),
            ))
        })
        .collect();
    let mut kept = vec![false; blocks.len()];
    for (i, block) in blocks.iter().enumerate() {
        // Interjeições e nomes que se escrevem igual nos dois idiomas ficam com o letreiro original.
        let text = normalize_text(&block.translation);
        if block.kind != BlockKind::Watermark
            && (text.is_empty() || text == normalize_text(&block.original))
        {
            kept[i] = true;
        }
        // Posto pela caixa do próprio modelo e sem letreiro ali: escrever cobriria o desenho.
        if block.ink_boxes.is_none()
            && found[i].bbox.is_none()
            && !is_footnote(block)
            && sfx[i].is_none()
        {
            kept[i] = true;
        }
        if let Some(scene) = scene {
            // Uma marca d'água encostada num balão pode dividir a caixa com a fala dele: apagar
            // levaria a linha junto.
            if block.kind == BlockKind::Watermark
                && vision::touches_speech(image, scene, block.text_box)
            {
                kept[i] = true;
            }
            // Uma onomatopeia em que os modelos não veem letreiro fica como está.
            if sfx[i]
                .as_ref()
                .is_some_and(|s| s.coverage < vision::SFX_MIN_COVERAGE)
            {
                kept[i] = true;
            }
        }
    }
    let copies = duplicates(blocks, &found, &kept);
    let mut skip_draw: Vec<bool> = (0..blocks.len())
        .map(|i| {
            kept[i]
                || copies[i]
                || is_footnote(&blocks[i])
                || blocks[i].kind == BlockKind::Watermark
        })
        .collect();
    let skip_erase: Vec<bool> = (0..blocks.len())
        .map(|i| skip_draw[i] && (blocks[i].kind != BlockKind::Watermark || kept[i]))
        .collect();
    let erased = scene
        .is_some_and(|scene| erase_with_models(image, scene, blocks, &found, &sfx, &skip_erase));
    if !erased {
        for (i, g) in found.iter().enumerate() {
            if !skip_erase[i] {
                erase(image, g);
            }
        }
    }
    let notes: Vec<String> = blocks
        .iter()
        .enumerate()
        .filter(|(i, b)| is_footnote(b) && !kept[*i])
        .map(|(_, b)| b.translation.trim().to_string())
        .filter(|t| !t.is_empty())
        .collect();
    let mut result = Vec::new();
    for (i, block) in blocks.iter().enumerate() {
        let mut drawn = Drawn {
            drawn: !skip_draw[i],
            skipped: None,
            letter_height: found[i].letter_height,
            font_size: None,
        };
        if skip_draw[i] {
            drawn.skipped = Some(if kept[i] {
                "kept"
            } else if copies[i] {
                "duplicate"
            } else if is_footnote(block) {
                "footnote"
            } else {
                "watermark"
            });
        } else {
            drawn.font_size = typeset(image, block, &found[i]);
            if drawn.font_size.is_none() {
                skip_draw[i] = true;
            }
        }
        result.push(drawn);
    }
    if !notes.is_empty() {
        append_footnotes(image, &notes);
    }
    result
}

/// Uma passada do LaMa sobre tudo o que sai da página; `false` quando o servidor falhou.
fn erase_with_models(
    image: &mut RgbImage,
    scene: &Scene,
    blocks: &[TextBlock],
    found: &[Glyphs],
    sfx: &[Option<SfxShape>],
    skip: &[bool],
) -> bool {
    if (scene.width, scene.height) != (image.width() as usize, image.height() as usize) {
        return false;
    }
    let mut mask = vec![0u8; scene.width * scene.height];
    let mut any = false;
    for (i, block) in blocks.iter().enumerate() {
        if skip[i] {
            continue;
        }
        any = true;
        if let Some(shape) = &sfx[i] {
            vision::add_sfx_erase_area(&mut mask, scene, shape);
            continue;
        }
        let g = &found[i];
        let b = match g.page_box() {
            Some(gb) if block.ink_boxes.is_some() => toon_ai::prompt::union(gb, block.text_box),
            Some(gb) => gb,
            None => block.text_box,
        };
        let letter = if g.letter_height > 0.0 {
            g.letter_height
        } else {
            block
                .letter_height
                .unwrap_or_else(|| estimate_letter(block))
        };
        vision::add_erase_area(&mut mask, scene, b, letter, g.bbox.map(|_| g.glyph_mask()));
    }
    !any || vision::inpaint(image, &mask)
}

impl Glyphs {
    fn page_box(&self) -> Option<[f32; 4]> {
        self.bbox.map(|b| b.map(|v| v as f32))
    }

    fn glyph_mask(&self) -> GlyphMask<'_> {
        GlyphMask {
            win: self.win,
            ww: self.ww,
            wh: self.wh,
            mask: &self.mask,
        }
    }
}

/// Faixas que se sobrepõem às vezes mandam o mesmo balão duas vezes: blocos cujas letras são as
/// mesmas viram um só.
fn duplicates(blocks: &[TextBlock], glyphs: &[Glyphs], ignored: &[bool]) -> Vec<bool> {
    let area = |b: IBox| (((b[2] - b[0]) * (b[3] - b[1])) as f32).max(1.0);
    let overlap = |a: IBox, b: IBox| {
        let w = a[2].min(b[2]) as f32 - a[0].max(b[0]) as f32;
        let h = a[3].min(b[3]) as f32 - a[1].max(b[1]) as f32;
        w.max(0.0) * h.max(0.0)
    };
    let mut drop = vec![false; blocks.len()];
    for i in 0..blocks.len() {
        for j in i + 1..blocks.len() {
            if ignored[i]
                || ignored[j]
                || blocks[i].kind == BlockKind::Watermark
                || blocks[j].kind == BlockKind::Watermark
            {
                continue;
            }
            let (a, b) = (&glyphs[i], &glyphs[j]);
            let loser = if blocks[i].original.len() >= blocks[j].original.len() {
                j
            } else {
                i
            };
            match (a.bbox, b.bbox) {
                (Some(x), Some(y)) if overlap(x, y) > 0.5 * area(x).min(area(y)) => {
                    drop[loser] = true
                }
                (Some(_), None) | (None, Some(_))
                    if similar_text(&blocks[i].original, &blocks[j].original) =>
                {
                    drop[if a.bbox.is_some() { j } else { i }] = true;
                }
                _ => {}
            }
        }
    }
    drop
}

fn gray_window(image: &RgbImage, win: IBox) -> (Vec<u8>, usize, usize) {
    let (ww, wh) = (win[2] - win[0], win[3] - win[1]);
    let mut gray = vec![0u8; ww * wh];
    for y in 0..wh {
        for x in 0..ww {
            let p = image.get_pixel((win[0] + x) as u32, (win[1] + y) as u32);
            gray[y * ww + x] =
                ((p[0] as u32 * 77 + p[1] as u32 * 150 + p[2] as u32 * 29) >> 8) as u8;
        }
    }
    (gray, ww, wh)
}

/// As caixas do modelo erram por uma linha ou mais, então as letras se acham pelos pixels: traços
/// finos sobre fundo liso perto do bloco. Com as caixas do detector, valem as letras dentro delas.
fn find_glyphs(image: &RgbImage, block: &TextBlock, w: usize, h: usize) -> Glyphs {
    let tb = block.text_box;
    let (tbw, tbh) = (tb[2] - tb[0], tb[3] - tb[1]);
    let margin = (w as f32 * 0.05).max((tbh * 1.5).min(w as f32 * 0.15));
    // Um texto maior do que a caixa comporta continua em linhas que o detector não marcou: a busca
    // desce (e sobe) o tanto dessas linhas.
    let line = block
        .letter_height
        .unwrap_or_else(|| estimate_letter(block))
        .max(4.0);
    let letters = block
        .original
        .chars()
        .filter(|c| c.is_alphanumeric())
        .count() as f32;
    let lines = (letters * line * 0.6 / tbw.max(1.0)).ceil();
    let rows = tbh / (line * 1.3);
    let margin_y = margin.max((lines - rows).max(0.0) * line * 1.8 + margin);
    let around = toon_ai::prompt::union(tb, block.area_box);
    let win = to_ibox(expand(around, margin, margin_y), w, h);
    let (ww, wh) = (win[2].saturating_sub(win[0]), win[3].saturating_sub(win[1]));
    let empty = |ink: Vec<u8>| Glyphs {
        win,
        ww,
        wh,
        mask: vec![0; ww * wh],
        ink,
        bbox: None,
        letter_height: 0.0,
    };
    if ww < 8 || wh < 8 {
        return empty(vec![0; ww * wh]);
    }
    let (gray, ww, wh) = gray_window(image, win);
    let letter = estimate_letter(block);
    let k = odd(round((w as f64 / 50.0).max(letter as f64 * 0.8)).clamp(11, 41));
    let closing = erode(&dilate(&gray, ww, wh, k), ww, wh, k);
    let opening = dilate(&erode(&gray, ww, wh, k), ww, wh, k);
    let contrasts: [Vec<u8>; 2] = [
        gray.iter()
            .zip(&closing)
            .map(|(g, c)| c.saturating_sub(*g))
            .collect(),
        gray.iter()
            .zip(&opening)
            .map(|(g, o)| g.saturating_sub(*o))
            .collect(),
    ];
    let strokes: Vec<u8> = (0..ww * wh)
        .map(|p| (contrasts[0][p] as i32 > INK_WEAK || contrasts[1][p] as i32 > INK_WEAK) as u8)
        .collect();
    let local = |b: [f32; 4]| -> IBox {
        to_ibox(
            [
                b[0] - win[0] as f32,
                b[1] - win[1] as f32,
                b[2] - win[0] as f32,
                b[3] - win[1] as f32,
            ],
            ww,
            wh,
        )
    };
    let ink_boxes: Vec<IBox> = block
        .ink_boxes
        .iter()
        .flatten()
        .map(|b| local(*b))
        .filter(|b| b[2] > b[0] && b[3] > b[1])
        .collect();
    let lh = block.letter_height.unwrap_or(letter).max(3.0);
    let mut mask = vec![0u8; ww * wh];
    let bbox = if !ink_boxes.is_empty() {
        add_ink_boxes(&mut mask, ww, wh, &ink_boxes, &contrasts, &gray, lh);
        let mut b = ink_boxes[0];
        for x in &ink_boxes {
            b = [
                b[0].min(x[0]),
                b[1].min(x[1]),
                b[2].max(x[2]),
                b[3].max(x[3]),
            ];
        }
        let expected = block
            .original
            .chars()
            .filter(|c| c.is_alphanumeric())
            .count();
        Some(grow_lines(
            &mut mask, ww, wh, b, &contrasts, &gray, lh, expected,
        ))
    } else {
        // Sem caixas do detector: as letras são os traços fortes com fundo liso em volta, perto da caixa do modelo.
        let near = local(expand(tb, tbw * 0.15, tbh * 0.3));
        letters_near(&mut mask, ww, wh, near, &contrasts, &gray, lh)
    };
    let Some(b) = bbox else { return empty(strokes) };
    Glyphs {
        win,
        ww,
        wh,
        mask,
        ink: strokes,
        bbox: Some([b[0] + win[0], b[1] + win[1], b[2] + win[0], b[3] + win[1]]),
        letter_height: lh,
    }
}

fn components_of(
    contrast: &[u8],
    ww: usize,
    wh: usize,
) -> (Vec<u8>, Vec<i32>, Vec<crate::glyphs::Comp>) {
    let ink: Vec<u8> = contrast
        .iter()
        .map(|&c| (c as i32 > INK_WEAK) as u8)
        .collect();
    let strong: Vec<u8> = contrast
        .iter()
        .map(|&c| (c as i32 > INK_STRONG) as u8)
        .collect();
    let (labels, comps) = components(&strong, ww, wh);
    (ink, labels, comps)
}

fn median_gray(c: &crate::glyphs::Comp, labels: &[i32], gray: &[u8], ww: usize) -> i32 {
    let step = round((c.count as f64 / 100.0).sqrt()).max(1);
    let mut values = Vec::new();
    for y in (c.y0..c.y1).step_by(step) {
        for x in (c.x0..c.x1).step_by(step) {
            if labels[y * ww + x] == c.id {
                values.push(gray[y * ww + x] as i32);
            }
        }
    }
    quantile(&values, 0.5)
}

/// Marca as letras dentro das caixas do detector, com a tinta fraca em volta (bordas suavizadas). A
/// polaridade com mais traços do tamanho de letra é o letreiro; a outra só conta onde encosta nele
/// (contorno, brilho).
fn add_ink_boxes(
    mask: &mut [u8],
    ww: usize,
    wh: usize,
    boxes: &[IBox],
    contrasts: &[Vec<u8>; 2],
    gray: &[u8],
    letter_height: f32,
) {
    let pad = round(letter_height as f64 * 0.25);
    let zones: Vec<IBox> = boxes
        .iter()
        .map(|b| {
            [
                b[0].saturating_sub(pad),
                b[1].saturating_sub(pad),
                (b[2] + pad).min(ww),
                (b[3] + pad).min(wh),
            ]
        })
        .collect();
    let mut samples = Vec::new();
    for b in boxes {
        let step = round((((b[2] - b[0]) * (b[3] - b[1])) as f64 / 2000.0).sqrt()).max(1);
        for y in (b[1]..b[3]).step_by(step) {
            for x in (b[0]..b[2]).step_by(step) {
                samples.push(gray[y * ww + x] as i32);
            }
        }
    }
    let bg = quantile(&samples, 0.5);
    struct Found {
        glyphs: Vec<crate::glyphs::Comp>,
        labels: Vec<i32>,
        own: Vec<u8>,
        mass: usize,
    }
    let found: Vec<Found> = contrasts
        .iter()
        .map(|contrast| {
            let (ink, labels, comps) = components_of(contrast, ww, wh);
            let glyphs: Vec<_> = comps
                .into_iter()
                .filter(|c| {
                    if c.count < 3 || c.h as f32 > letter_height * 2.0 {
                        return false;
                    }
                    if (median_gray(c, &labels, gray, ww) - bg).abs() < 40 {
                        return false;
                    }
                    if boxes
                        .iter()
                        .any(|b| c.x0 >= b[0] && c.y0 >= b[1] && c.x1 <= b[2] && c.y1 <= b[3])
                    {
                        return true;
                    }
                    let inside = zones.iter().any(|z| {
                        let ow = c.x1.min(z[2]) as f32 - c.x0.max(z[0]) as f32;
                        let oh = c.y1.min(z[3]) as f32 - c.y0.max(z[1]) as f32;
                        ow.max(0.0) * oh.max(0.0) >= 0.7 * (c.w * c.h).max(1) as f32
                    });
                    inside && is_glyph(c, gray, &ink, &labels, ww, wh, FLAT_TOLERANCE)
                })
                .collect();
            let mut own = vec![0u8; ww * wh];
            for c in &glyphs {
                for y in c.y0.saturating_sub(pad)..(c.y1 + pad).min(wh) {
                    for x in c.x0.saturating_sub(pad)..(c.x1 + pad).min(ww) {
                        let p = y * ww + x;
                        if labels[p] == c.id || ink[p] != 0 {
                            own[p] = 1;
                        }
                    }
                }
            }
            let mass = glyphs.iter().map(|c| c.count).sum();
            Found {
                glyphs,
                labels,
                own,
                mass,
            }
        })
        .collect();
    let (main, other) = if found[0].mass >= found[1].mass {
        (&found[0], &found[1])
    } else {
        (&found[1], &found[0])
    };
    let touch = dilate(&main.own, ww, wh, 3);
    for p in 0..mask.len() {
        if main.own[p] != 0 {
            mask[p] = 1;
        }
    }
    for c in &other.glyphs {
        let touching = (c.y0..c.y1).any(|y| {
            (c.x0..c.x1).any(|x| other.labels[y * ww + x] == c.id && touch[y * ww + x] != 0)
        });
        if !touching {
            continue;
        }
        for y in c.y0.saturating_sub(pad)..(c.y1 + pad).min(wh) {
            for x in c.x0.saturating_sub(pad)..(c.x1 + pad).min(ww) {
                if other.own[y * ww + x] != 0 {
                    mask[y * ww + x] = 1;
                }
            }
        }
    }
}

/// O detector às vezes marca só uma linha de um parágrafo de letras grandes e espaçadas (capítulo 79 de
/// The Genius Midfielder: "Even a child whose" e mais duas linhas embaixo). Quando o texto original tem
/// bem mais letras do que as caixas, as linhas logo acima e abaixo, de letras do mesmo tamanho, entram
/// também, uma de cada vez.
#[allow(clippy::too_many_arguments)]
fn grow_lines(
    mask: &mut [u8],
    ww: usize,
    wh: usize,
    start: IBox,
    contrasts: &[Vec<u8>; 2],
    gray: &[u8],
    lh: f32,
    expected: usize,
) -> IBox {
    let letter = |c: &crate::glyphs::Comp| {
        (c.h as f32) >= lh * 0.6 && (c.h as f32) <= lh * 1.7 && c.count >= 3
    };
    let centre_in = |c: &crate::glyphs::Comp, b: IBox| {
        let (x, y) = ((c.x0 + c.x1) / 2, (c.y0 + c.y1) / 2);
        x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3]
    };
    // A polaridade com mais letras dentro da caixa é a do letreiro.
    let mut best: Option<(usize, Vec<crate::glyphs::Comp>, Vec<i32>, Vec<u8>)> = None;
    for contrast in contrasts {
        let (ink, labels, comps) = components_of(contrast, ww, wh);
        let comps: Vec<_> = comps
            .into_iter()
            .filter(|c| letter(c) && is_glyph(c, gray, &ink, &labels, ww, wh, FLAT_TOLERANCE))
            .collect();
        let inside = comps.iter().filter(|c| centre_in(c, start)).count();
        if best.as_ref().is_none_or(|(n, ..)| inside > *n) {
            best = Some((inside, comps, labels, ink));
        }
    }
    let Some((inside, comps, labels, ink)) = best else {
        return start;
    };
    // Letras grudadas contam como uma peça: só cresce com folga clara.
    if inside == 0 || (expected as f32) < inside as f32 * 1.6 {
        return start;
    }
    let mut b = start;
    let mut taken: Vec<bool> = comps.iter().map(|c| centre_in(c, start)).collect();
    let mut pieces = inside;
    let width = (start[2] - start[0]) as f32;
    let pad = round(lh as f64 * 0.25);
    loop {
        // A próxima linha: peças logo acima ou abaixo, sob a largura do bloco.
        let near: Vec<usize> = (0..comps.len())
            .filter(|&i| !taken[i])
            .filter(|&i| {
                let c = &comps[i];
                let gap = (c.y0 as f32 - b[3] as f32).max(b[1] as f32 - c.y1 as f32);
                let cx = (c.x0 + c.x1) as f32 / 2.0;
                gap >= -lh * 0.5
                    && gap <= lh * 2.2
                    && cx >= b[0] as f32 - width * 0.3
                    && cx <= b[2] as f32 + width * 0.3
            })
            .collect();
        if near.len() < 2 || pieces as f32 >= expected as f32 * 1.15 {
            break;
        }
        for &i in &near {
            let c = comps[i];
            taken[i] = true;
            pieces += 1;
            b = [
                b[0].min(c.x0),
                b[1].min(c.y0),
                b[2].max(c.x1),
                b[3].max(c.y1),
            ];
            for y in c.y0.saturating_sub(pad)..(c.y1 + pad).min(wh) {
                for x in c.x0.saturating_sub(pad)..(c.x1 + pad).min(ww) {
                    let p = y * ww + x;
                    if labels[p] == c.id || ink[p] != 0 {
                        mask[p] = 1;
                    }
                }
            }
        }
    }
    b
}

/// Letras perto da caixa do modelo: componentes fortes do tamanho de letra sobre fundo liso.
fn letters_near(
    mask: &mut [u8],
    ww: usize,
    wh: usize,
    near: IBox,
    contrasts: &[Vec<u8>; 2],
    gray: &[u8],
    letter: f32,
) -> Option<IBox> {
    let mut best: Option<(usize, Vec<crate::glyphs::Comp>, Vec<i32>, Vec<u8>)> = None;
    for contrast in contrasts {
        let (ink, labels, comps) = components_of(contrast, ww, wh);
        let letters: Vec<_> = comps
            .into_iter()
            .filter(|c| {
                let (cx, cy) = ((c.x0 + c.x1) / 2, (c.y0 + c.y1) / 2);
                c.count >= 3
                    && (c.h as f32) <= letter * 2.0
                    && (c.h as f32) >= letter * 0.3
                    && cx >= near[0]
                    && cx <= near[2]
                    && cy >= near[1]
                    && cy <= near[3]
                    && is_glyph(c, gray, &ink, &labels, ww, wh, FLAT_TOLERANCE)
            })
            .collect();
        let mass: usize = letters.iter().map(|c| c.count).sum();
        if letters.len() >= 2 && best.as_ref().is_none_or(|b| mass > b.0) {
            best = Some((mass, letters, labels, ink));
        }
    }
    let (_, letters, labels, ink) = best?;
    let pad = round(letter as f64 * 0.25);
    let mut b = [usize::MAX, usize::MAX, 0, 0];
    for c in &letters {
        b = [
            b[0].min(c.x0),
            b[1].min(c.y0),
            b[2].max(c.x1),
            b[3].max(c.y1),
        ];
        for y in c.y0.saturating_sub(pad)..(c.y1 + pad).min(wh) {
            for x in c.x0.saturating_sub(pad)..(c.x1 + pad).min(ww) {
                let p = y * ww + x;
                if labels[p] == c.id || ink[p] != 0 {
                    mask[p] = 1;
                }
            }
        }
    }
    Some(b)
}

/// Apaga as letras: a máscara engrossada (contorno, suavização, o "eco" do JPEG em volta) é
/// repintada com o fundo de perto.
fn erase(image: &mut RgbImage, g: &Glyphs) {
    if g.bbox.is_none() {
        return;
    }
    let grow = round(g.letter_height as f64 * 0.18).max(1) + 1;
    let halo = round(g.letter_height as f64 * 0.12).max(1);
    let mask = dilate(&g.mask, g.ww, g.wh, (grow + halo) * 2 + 1);
    let mut data: Vec<[f32; 3]> = Vec::with_capacity(g.ww * g.wh);
    for y in 0..g.wh {
        for x in 0..g.ww {
            let p = image.get_pixel((g.win[0] + x) as u32, (g.win[1] + y) as u32);
            data.push([p[0] as f32, p[1] as f32, p[2] as f32]);
        }
    }
    fill_masked(
        &mut data,
        g.ww,
        g.wh,
        &mask,
        &g.ink,
        round(g.letter_height as f64 * 0.6).max(3),
    );
    for y in 0..g.wh {
        for x in 0..g.ww {
            if mask[y * g.ww + x] != 0 {
                let c = data[y * g.ww + x];
                image.put_pixel(
                    (g.win[0] + x) as u32,
                    (g.win[1] + y) as u32,
                    image::Rgb([c[0].round() as u8, c[1].round() as u8, c[2].round() as u8]),
                );
            }
        }
    }
}

/// Convolução normalizada: cada pixel mascarado vira a média dos pixels lisos num quadrado em volta,
/// alargado até achar o bastante, e o preenchimento é borrado uma vez para esconder onde alargou.
/// Fundo liso e degradê voltam sem as listras de espalhar da borda para o centro; traços (bordas de
/// balão, outro texto, desenho) quase não contam e não borram dentro.
fn fill_masked(d: &mut [[f32; 3]], ww: usize, wh: usize, mask: &[u8], ink: &[u8], radius: usize) {
    let masked: Vec<usize> = (0..mask.len()).filter(|&p| mask[p] != 0).collect();
    if masked.is_empty() {
        return;
    }
    let known = integrals(d, ww, wh, |p| {
        if mask[p] != 0 || ink[p] != 0 {
            0.0
        } else {
            1.0
        }
    });
    let mut colors = vec![[0f32; 3]; masked.len()];
    let mut filled = vec![false; masked.len()];
    let mut todo: Vec<usize> = (0..masked.len()).collect();
    for r in [radius, radius * 2] {
        let mut next = Vec::new();
        for n in todo {
            let p = masked[n];
            let s = box_sum(&known, ww, wh, p % ww, p / ww, r);
            if s[3] < 0.15 * ((2 * r + 1) * (2 * r + 1)) as f64 {
                next.push(n);
                continue;
            }
            colors[n] = [
                (s[0] / s[3]) as f32,
                (s[1] / s[3]) as f32,
                (s[2] / s[3]) as f32,
            ];
            filled[n] = true;
        }
        todo = next;
    }
    // O meio de um bloco grande apagado fica longe de qualquer fundo: ele cresce a partir dos vizinhos já
    // preenchidos em vez de buscar uma média tão larga que alcance a borda do balão.
    if !todo.is_empty() {
        let mut index = vec![usize::MAX; ww * wh];
        for (n, &p) in masked.iter().enumerate() {
            index[p] = n;
        }
        let mut strokes = false;
        while !todo.is_empty() {
            let mut next = Vec::new();
            let mut updates = Vec::new();
            for &n in &todo {
                let p = masked[n];
                let (x, y) = ((p % ww) as i64, (p / ww) as i64);
                let mut sum = [0f32; 3];
                let mut count = 0;
                for dy in -1..=1i64 {
                    for dx in -1..=1i64 {
                        let (nx, ny) = (x + dx, y + dy);
                        if (dx == 0 && dy == 0)
                            || nx < 0
                            || ny < 0
                            || nx >= ww as i64
                            || ny >= wh as i64
                        {
                            continue;
                        }
                        let q = ny as usize * ww + nx as usize;
                        let value = if mask[q] != 0 {
                            if !filled[index[q]] {
                                continue;
                            }
                            colors[index[q]]
                        } else {
                            if ink[q] != 0 && !strokes {
                                continue;
                            }
                            d[q]
                        };
                        for k in 0..3 {
                            sum[k] += value[k];
                        }
                        count += 1;
                    }
                }
                if count > 0 {
                    updates.push((n, sum.map(|v| v / count as f32)));
                } else {
                    next.push(n);
                }
            }
            if updates.is_empty() {
                // Cercado só por traços: usa eles em vez de deixar um buraco.
                if strokes {
                    break;
                }
                strokes = true;
            }
            for (n, c) in updates {
                colors[n] = c;
                filled[n] = true;
            }
            todo = next;
        }
    }
    for (n, &p) in masked.iter().enumerate() {
        // O que o preenchimento não alcançou (desenho carregado atrás das letras) viraria mancha escura.
        d[p] = if filled[n] { colors[n] } else { [255.0; 3] };
    }
    let flat = integrals(d, ww, wh, |p| {
        if mask[p] != 0 || ink[p] == 0 {
            1.0
        } else {
            0.0
        }
    });
    let smooth = (radius >> 1).max(1);
    for (n, &p) in masked.iter().enumerate() {
        if !filled[n] {
            continue;
        }
        let s = box_sum(&flat, ww, wh, p % ww, p / ww, smooth);
        if s[3] > 0.0 {
            d[p] = [
                (s[0] / s[3]) as f32,
                (s[1] / s[3]) as f32,
                (s[2] / s[3]) as f32,
            ];
        }
    }
}

/// Tabelas de soma de área de r, g, b (ponderados) e do peso; (ww + 1) × (wh + 1).
fn integrals(d: &[[f32; 3]], ww: usize, wh: usize, weight: impl Fn(usize) -> f64) -> Vec<[f64; 4]> {
    let stride = ww + 1;
    let mut t = vec![[0f64; 4]; stride * (wh + 1)];
    for y in 0..wh {
        let mut row = [0f64; 4];
        for x in 0..ww {
            let p = y * ww + x;
            let w = weight(p);
            for k in 0..3 {
                row[k] += d[p][k] as f64 * w;
            }
            row[3] += w;
            let above = t[y * stride + x + 1];
            let cell = &mut t[(y + 1) * stride + x + 1];
            for k in 0..4 {
                cell[k] = above[k] + row[k];
            }
        }
    }
    t
}

fn box_sum(t: &[[f64; 4]], ww: usize, wh: usize, x: usize, y: usize, r: usize) -> [f64; 4] {
    let stride = ww + 1;
    let (x0, y0) = (x.saturating_sub(r), y.saturating_sub(r));
    let (x1, y1) = ((x + r + 1).min(ww), (y + r + 1).min(wh));
    let (a, b, c, e) = (
        t[y0 * stride + x0],
        t[y0 * stride + x1],
        t[y1 * stride + x0],
        t[y1 * stride + x1],
    );
    [0, 1, 2, 3].map(|k| e[k] - b[k] - c[k] + a[k])
}

// --- Escrita ----------------------------------------------------------------------------------------

/// O espaço livre em volta do texto, linha por linha: a largura usável em cada altura, centrada em `cx`.
struct Room {
    cx: f32,
    cy: f32,
    top: f32,
    widths: Vec<f32>,
}

impl Room {
    fn width_at(&self, y0: f32, y1: f32) -> f32 {
        let a = ((y0 - self.top).floor().max(0.0)) as usize;
        let b = ((y1 - self.top).ceil().max(0.0) as usize).min(self.widths.len());
        if a >= b {
            return 0.0;
        }
        self.widths[a..b].iter().cloned().fold(f32::MAX, f32::min)
    }
}

/// Mede o balão depois de apagado: a partir do centro do texto, até onde vai o fundo da mesma cor
/// para cada lado, em cada linha.
fn measure_room(image: &RgbImage, text_box: IBox, cap: f32) -> (Room, [u8; 3]) {
    let (w, h) = (image.width() as i64, image.height() as i64);
    let cx = (text_box[0] + text_box[2]) as f32 / 2.0;
    let cy = (text_box[1] + text_box[3]) as f32 / 2.0;
    let mut ring = Vec::new();
    for x in text_box[0]..text_box[2] {
        for y in [text_box[1], text_box[3].saturating_sub(1)] {
            if (x as i64) < w && (y as i64) < h {
                ring.push(*image.get_pixel(x as u32, y as u32));
            }
        }
    }
    let channel = |k: usize| quantile(&ring.iter().map(|p| p[k] as i32).collect::<Vec<_>>(), 0.5);
    let bg = [channel(0), channel(1), channel(2)];
    let is_bg = |x: i64, y: i64| {
        x >= 0 && y >= 0 && x < w && y < h && {
            let p = image.get_pixel(x as u32, y as u32);
            (0..3).all(|k| (p[k] as i32 - bg[k]).abs() <= BG_TOLERANCE)
        }
    };
    let reach = (w as f32 * 0.45) as i64;
    let rows_up = (cap * 6.0 + (text_box[3] - text_box[1]) as f32) as i64;
    let top = (cy as i64 - rows_up).max(0);
    let bottom = (cy as i64 + rows_up).min(h - 1);
    let tw = (text_box[2] - text_box[0]) as f32;
    let mut widths = Vec::with_capacity((bottom - top + 1) as usize);
    for y in top..=bottom {
        let x = cx as i64;
        let (mut left, mut right) = (0, 0);
        while left < reach && is_bg(x - left - 1, y) {
            left += 1;
        }
        while right < reach && is_bg(x + right + 1, y) {
            right += 1;
        }
        let mut width = 2.0 * left.min(right) as f32;
        // Dentro da caixa do texto a linha é sempre usável: um fundo que não é liso (degradê) não a corta.
        if y >= text_box[1] as i64 && y < text_box[3] as i64 {
            width = width.max(tw);
        }
        widths.push(width);
    }
    // A sala termina onde a largura cai abaixo de algumas letras, acima e abaixo do centro.
    let mid = (cy as i64 - top) as usize;
    let min_w = cap * 2.0;
    let mut a = mid.min(widths.len().saturating_sub(1));
    while a > 0 && widths[a - 1] >= min_w {
        a -= 1;
    }
    let mut b = mid.min(widths.len().saturating_sub(1));
    while b + 1 < widths.len() && widths[b + 1] >= min_w {
        b += 1;
    }
    let widths: Vec<f32> = widths[a..=b].to_vec();
    let bg_rgb = [bg[0] as u8, bg[1] as u8, bg[2] as u8];
    (
        Room {
            cx,
            cy,
            top: (top + a as i64) as f32,
            widths,
        },
        bg_rgb,
    )
}

struct Layout {
    size: f32,
    lines: Vec<String>,
    /// Topo de cada linha.
    ys: Vec<f32>,
}

/// Quebra o texto em linhas que cabem na sala, num tamanho de fonte, com o bloco centralizado em `cy`.
fn layout_at(pen: &Pen, text: &str, room: &Room, cap: f32, pitch: f32) -> Option<Layout> {
    let words: Vec<&str> = text.split_whitespace().collect();
    if words.is_empty() {
        return None;
    }
    let line_h = cap * pitch;
    let span = room.widths.len() as f32 * FILL;
    // Tenta de poucas linhas para mais: a primeira que couber é a mais larga e baixa.
    for count in 1..=words.len() {
        let height = cap + line_h * (count - 1) as f32;
        if height > span {
            return None;
        }
        let top = room.cy - height / 2.0;
        let ys: Vec<f32> = (0..count).map(|i| top + i as f32 * line_h).collect();
        let limits: Vec<f32> = ys
            .iter()
            .map(|y| room.width_at(*y - cap * 0.2, *y + cap * 1.2) * FILL)
            .collect();
        if let Some(lines) = fill_lines(pen, &words, &limits) {
            return Some(Layout {
                size: pen.size,
                lines,
                ys,
            });
        }
    }
    None
}

/// Distribui as palavras em exatamente `limits.len()` linhas, cada uma no limite da sua altura.
fn fill_lines(pen: &Pen, words: &[&str], limits: &[f32]) -> Option<Vec<String>> {
    let total: f32 = pen.width(&words.join(" "));
    let goal = total / limits.len() as f32;
    let mut lines = Vec::new();
    let mut i = 0;
    for (n, &limit) in limits.iter().enumerate() {
        if i >= words.len() {
            return None;
        }
        let last = n == limits.len() - 1;
        let mut line = words[i].to_string();
        i += 1;
        if pen.width(&line) > limit {
            return None;
        }
        while i < words.len() {
            let next = format!("{line} {}", words[i]);
            let wide = pen.width(&next);
            // Linhas parecidas: passa da média só na última, que leva o resto.
            if wide > limit || (!last && pen.width(&line) >= goal) {
                break;
            }
            line = next;
            i += 1;
        }
        lines.push(line);
    }
    (i == words.len()).then_some(lines)
}

fn from_hex(hex: &str) -> Option<[u8; 3]> {
    let h = hex.trim_start_matches('#');
    (h.len() == 6).then(|| [0, 2, 4].map(|i| u8::from_str_radix(&h[i..i + 2], 16).unwrap_or(0)))
}

fn luminance(c: [u8; 3]) -> f32 {
    0.299 * c[0] as f32 + 0.587 * c[1] as f32 + 0.114 * c[2] as f32
}

fn match_case(translation: &str, original: &str) -> String {
    let letters: Vec<char> = original
        .chars()
        .filter(|c| c.is_lowercase() || c.is_uppercase())
        .collect();
    if letters.len() < 3 {
        return translation.to_string();
    }
    let upper = letters.iter().filter(|c| c.is_uppercase()).count();
    if upper as f32 / letters.len() as f32 > 0.85 {
        translation.to_uppercase()
    } else {
        translation.to_string()
    }
}

fn role_of(block: &TextBlock) -> FontRole {
    block.font.unwrap_or(match block.kind {
        BlockKind::Shout => FontRole::Brush,
        BlockKind::Narration | BlockKind::System => FontRole::Sans,
        _ => FontRole::Comic,
    })
}

/// Escreve a tradução onde o original estava, com letra parecida com a do original. Devolve o tamanho
/// da fonte, ou `None` quando não havia onde escrever.
fn typeset(image: &mut RgbImage, block: &TextBlock, g: &Glyphs) -> Option<f32> {
    let text = match_case(&block.translation, &block.original);
    let w = image.width() as usize;
    let text_box = g
        .bbox
        .unwrap_or_else(|| to_ibox(block.text_box, w, image.height() as usize));
    let cap = block
        .letter_height
        .unwrap_or(g.letter_height)
        .max(estimate_letter(block) * 0.5)
        .max(6.0);
    let (room, bg) = measure_room(image, text_box, cap);
    if room.widths.is_empty() {
        return None;
    }
    let role = role_of(block);
    let shout = block.kind == BlockKind::Shout;
    let font = FACES.face(role, shout || role == FontRole::Comic);
    let fill = block
        .color
        .as_deref()
        .and_then(from_hex)
        .unwrap_or(if luminance(bg) > 128.0 {
            [0, 0, 0]
        } else {
            [255, 255, 255]
        });
    let mut stroke = block.outline.as_deref().and_then(from_hex);
    // Comentários pequenos atravessam a borda do balão: um contorno da cor do papel mantém legível.
    if block.kind == BlockKind::Aside && stroke.is_none() {
        stroke = Some(if luminance(fill) > 140.0 {
            [0, 0, 0]
        } else {
            [255, 255, 255]
        });
    }
    let cap_ratio = Pen { font, size: 100.0 }.cap_ratio().max(0.4);
    // Sussurros e comentários vêm um pouco menores que o original, como nas scans.
    let quiet = if matches!(block.kind, BlockKind::Whisper | BlockKind::Aside) {
        0.8
    } else {
        1.0
    };
    let max_font = (quiet * cap / cap_ratio)
        .min((w as f32 / 10.0).max(14.0))
        .max(MIN_FONT);
    let (mut lo, mut hi) = (MIN_FONT as i32, max_font.floor() as i32);
    let mut best = None;
    while lo <= hi {
        let size = (lo + hi) / 2;
        let pen = Pen {
            font,
            size: size as f32,
        };
        match layout_at(&pen, &text, &room, cap_ratio * size as f32, LINE_PITCH) {
            Some(layout) => {
                best = Some(layout);
                lo = size + 1;
            }
            None => hi = size - 1,
        }
    }
    // Não coube nem na menor: uma palavra por linha no tamanho mínimo, centrado.
    let layout = best.unwrap_or_else(|| {
        let lines: Vec<String> = text.split_whitespace().map(str::to_string).collect();
        let c = cap_ratio * MIN_FONT;
        let height = c + c * LINE_PITCH * (lines.len().max(1) - 1) as f32;
        let ys = (0..lines.len())
            .map(|i| room.cy - height / 2.0 + i as f32 * c * LINE_PITCH)
            .collect();
        Layout {
            size: MIN_FONT,
            lines,
            ys,
        }
    });
    let pen = Pen {
        font,
        size: layout.size,
    };
    let c = cap_ratio * layout.size;
    let italic = block.italic.unwrap_or(false);
    let slant = if italic { 0.2 } else { 0.0 };
    let margin = (c * 1.5) as i64 + 4;
    let widest = layout
        .lines
        .iter()
        .map(|l| pen.width(l))
        .fold(0.0, f32::max);
    let x0 = (room.cx - widest / 2.0) as i64 - margin;
    let y0 = layout.ys.first().copied().unwrap_or(room.cy) as i64 - margin;
    let height =
        (layout.ys.last().copied().unwrap_or(room.cy) - layout.ys[0] + c) as i64 + 2 * margin;
    let mut cover = Coverage::new(
        x0,
        y0,
        (widest as i64 + 2 * margin) as usize,
        height.max(1) as usize,
    );
    for (line, y) in layout.lines.iter().zip(&layout.ys) {
        let lw = pen.width(line);
        pen.rasterize(&mut cover, line, room.cx - lw / 2.0, y + c, slant);
    }
    if let Some(color) = stroke {
        cover.grown((0.2 * c).max(1.5)).paint(image, color);
    }
    cover.paint(image, fill);
    Some(layout.size)
}

/// As traduções das placas e títulos vão numa faixa embaixo da página, como as scans fazem.
fn append_footnotes(image: &mut RgbImage, notes: &[String]) {
    let w = image.width();
    let pad = (w as f32 * 0.02).round();
    let size = (w as f32 / 52.0).round().max(13.0);
    let line_h = size * 1.35;
    let pen = Pen {
        font: FACES.face(FontRole::Sans, false),
        size,
    };
    let max_w = w as f32 - 2.0 * pad;
    let mut lines = Vec::new();
    for note in notes {
        let mut line = String::new();
        for word in format!("*{note}").split_whitespace() {
            let next = if line.is_empty() {
                word.to_string()
            } else {
                format!("{line} {word}")
            };
            if !line.is_empty() && pen.width(&next) > max_w {
                lines.push(std::mem::replace(&mut line, word.to_string()));
            } else {
                line = next;
            }
        }
        lines.push(line);
    }
    let band = (pad * 2.0 + lines.len() as f32 * line_h).ceil() as u32;
    let old_h = image.height();
    let mut grown = RgbImage::from_pixel(w, old_h + band, image::Rgb([240, 240, 240]));
    image::imageops::replace(&mut grown, image, 0, 0);
    for x in 0..w {
        grown.put_pixel(x, old_h, image::Rgb([189, 189, 189]));
    }
    let mut cover = Coverage::new(0, old_h as i64, w as usize, band as usize);
    for (i, line) in lines.iter().enumerate() {
        pen.rasterize(
            &mut cover,
            line,
            pad,
            old_h as f32 + pad + i as f32 * line_h + size * 0.8,
            0.15,
        );
    }
    cover.paint(&mut grown, [33, 33, 33]);
    *image = grown;
}
