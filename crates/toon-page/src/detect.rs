//! Acha os blocos de letras de uma imagem sozinho, para a posição do texto nunca depender do modelo:
//! traços finos sobre fundo liso (black-hat para texto escuro, top-hat para texto claro), letras
//! parecidas lado a lado formando linhas, linhas empilhadas formando blocos. Desenho que passa nesses
//! testes não faz mal: o modelo deixa de fora as caixas sem texto legível.

use std::collections::{HashMap, HashSet};

use crate::glyphs::{Comp, Gray, components, dilate, erode, is_glyph, odd, quantile, round};

/// Contraste local da tinta: os fortes formam as letras, os fracos são as bordas suavizadas.
const INK_STRONG: i32 = 45;
const INK_WEAK: i32 = 22;
/// Passando disso numa imagem, o detector está lendo uma textura; ficam os melhores.
const MAX_REGIONS: usize = 40;
/// Tolerância de fundo para letras soltas: mais frouxa que a do overlay, os testes de bloco pegam o desenho.
const GLYPH_TOLERANCE: i32 = 45;
/// Distância máxima de cinza até a mediana do fundo do bloco para contar como a mesma cor lisa.
const BLOCK_TOLERANCE: i32 = 30;

pub type IBox = [usize; 4];

#[derive(Debug, Clone, PartialEq)]
pub struct TextRegion {
    /// Caixa justa em volta das letras, em pixels da imagem.
    pub r#box: IBox,
    pub letter_height: f64,
    pub glyphs: usize,
}

struct Block {
    region: TextRegion,
    list: Vec<Comp>,
}

pub fn detect_text(gray: &Gray) -> Vec<TextRegion> {
    let (w, h) = (gray.w, gray.h);
    if w < 16 || h < 16 {
        return Vec::new();
    }
    let g = &gray.px;
    // O filtro precisa ser mais largo que os traços mais grossos das letras comuns.
    let k = odd(round(w as f64 / 35.0).clamp(11, 41));
    let closing = erode(&dilate(g, w, h, k), w, h, k);
    let opening = dilate(&erode(g, w, h, k), w, h, k);
    let min_h = (w as f64 * 0.008).max(5.0);
    // Gritos chegam a um sétimo da largura da página de altura.
    let max_h = w as f64 * 0.15;

    let mut found = Vec::new();
    for dark in [true, false] {
        let mut ink = vec![0u8; w * h];
        let mut strong = vec![0u8; w * h];
        for p in 0..g.len() {
            let c = if dark { closing[p] as i32 - g[p] as i32 } else { g[p] as i32 - opening[p] as i32 };
            ink[p] = (c > INK_WEAK) as u8;
            strong[p] = (c > INK_STRONG) as u8;
        }
        let (labels, comps) = components(&strong, w, h);
        let shapes: Vec<Comp> = comps
            .into_iter()
            .filter(|c| {
                let (cw, ch) = (c.w as f64, c.h as f64);
                c.count >= 3
                    && ch >= min_h
                    && ch <= max_h
                    && cw <= w as f64 * 0.5
                    // Letras ficam afastadas das bordas; o que encosta é desenho saindo da página.
                    && c.x0 > 0
                    && c.x1 < w
                    && cw <= ch * 10.0 + 4.0
                    && ch <= cw * 8.0 + 4.0
                    // Contornos e linhas de velocidade são traços finos espalhados numa caixa grande.
                    && c.count as f64 >= cw * ch * 0.1
                    // Uma peça larga tem que ser uma palavra de letras grudadas: vários traços, não uma ponta.
                    && (cw < 2.0 * ch || strokes_across(c, &labels, w) >= 3)
                    && !is_tip(c, g, &ink, &labels, w, h)
            })
            .collect();
        let clean: HashSet<i32> =
            shapes.iter().filter(|c| is_glyph(c, g, &ink, &labels, w, h, GLYPH_TOLERANCE)).map(|c| c.id).collect();
        for block in group_blocks(&shapes, &clean) {
            if is_text_block(&block, g, &ink, w, h) && !beside_own_colour(&block, dark, g, &labels, w, h) {
                found.push(block.region);
            }
        }
    }
    let mut regions = join_bubbles(merge_regions(found), g, w, h);
    regions.sort_by(|a, b| b.glyphs.cmp(&a.glyphs));
    regions.truncate(MAX_REGIONS);
    regions.sort_by(|a, b| a.r#box[1].cmp(&b.r#box[1]).then(a.r#box[0].cmp(&b.r#box[0])));
    regions
}

fn find(parent: &mut [usize], i: usize) -> usize {
    let mut root = i;
    while parent[root] != root {
        root = parent[root];
    }
    let mut j = i;
    while parent[j] != root {
        let next = parent[j];
        parent[j] = root;
        j = next;
    }
    root
}

fn bounds_of(list: &[Comp]) -> IBox {
    let mut b = [usize::MAX, usize::MAX, 0, 0];
    for c in list {
        b[0] = b[0].min(c.x0);
        b[1] = b[1].min(c.y0);
        b[2] = b[2].max(c.x1);
        b[3] = b[3].max(c.y1);
    }
    b
}

fn gap_x(a: &Comp, b: &Comp) -> f64 {
    (b.x0 as f64 - a.x1 as f64).max(a.x0 as f64 - b.x1 as f64).max(0.0)
}

/// Letras parecidas lado a lado, depois linhas de altura parecida empilhadas e alinhadas. Brilho ou
/// textura atrás das letras podem reprovar letras soltas no teste de fundo liso (`clean`); elas ainda
/// contam quando se alinham com letras aprovadas.
fn group_blocks(shapes: &[Comp], clean: &HashSet<i32>) -> Vec<Block> {
    let mut sorted = shapes.to_vec();
    sorted.sort_by_key(|c| c.y0);
    let mut parent: Vec<usize> = (0..sorted.len()).collect();
    for i in 0..sorted.len() {
        let a = sorted[i];
        for j in i + 1..sorted.len() {
            let b = sorted[j];
            if b.y0 >= a.y1 {
                break;
            }
            let lo = a.h.min(b.h) as f64;
            let hi = a.h.max(b.h) as f64;
            let same_row = (a.y1.min(b.y1) as f64 - a.y0.max(b.y0) as f64) >= 0.5 * lo && hi <= 1.8 * lo;
            if same_row && gap_x(&a, &b) <= 0.9 * hi {
                let (ri, rj) = (find(&mut parent, i), find(&mut parent, j));
                parent[ri] = rj;
            }
        }
    }
    let mut by_root: Vec<(usize, Vec<Comp>)> = Vec::new();
    for (i, c) in sorted.iter().enumerate() {
        let root = find(&mut parent, i);
        match by_root.iter_mut().find(|(r, _)| *r == root) {
            Some((_, list)) => list.push(*c),
            None => by_root.push((root, vec![*c])),
        }
    }
    struct Line {
        list: Vec<Comp>,
        b: IBox,
        h: f64,
    }
    let mut lines: Vec<Line> = by_root
        .into_iter()
        .filter_map(|(_, mut row)| {
            // Peças duvidosas só contam entre letras limpas, nunca nas pontas da linha.
            row.sort_by_key(|c| c.x0);
            let first = row.iter().position(|c| clean.contains(&c.id))?;
            let last = row.iter().rposition(|c| clean.contains(&c.id))?;
            let list = row[first..=last].to_vec();
            let clean_count = list.iter().filter(|c| clean.contains(&c.id)).count();
            if (clean_count as f64) < list.len() as f64 * 0.25 {
                return None;
            }
            let heights: Vec<f64> = list.iter().map(|c| c.h as f64).collect();
            let h = quantile(&heights, 0.6);
            let b = bounds_of(&list);
            let width = (b[2] - b[0]) as f64;
            let wide_enough = (list.len() >= 2 && width >= h) || width >= 1.5 * h;
            (wide_enough && is_aligned(&list, h)).then_some(Line { list, b, h })
        })
        .collect();
    lines.sort_by_key(|l| l.b[1]);

    let mut stack: Vec<usize> = (0..lines.len()).collect();
    for i in 0..lines.len() {
        let a = &lines[i];
        for j in i + 1..lines.len() {
            let b = &lines[j];
            let lo = a.h.min(b.h);
            let hi = a.h.max(b.h);
            let dy = b.b[1] as f64 - a.b[3] as f64;
            // Linhas ordenadas pelo topo; uma linha empilhável tem no máximo 1,3 vez a altura de `a`.
            if dy > 1.7 * a.h {
                break;
            }
            if hi > 1.3 * lo || dy > 1.2 * hi || dy < -0.3 * lo {
                continue;
            }
            let overlap_x = a.b[2].min(b.b[2]) as f64 - a.b[0].max(b.b[0]) as f64;
            let (wa, wb) = ((a.b[2] - a.b[0]) as f64, (b.b[2] - b.b[0]) as f64);
            let centred = ((a.b[0] + a.b[2]) as f64 / 2.0 - (b.b[0] + b.b[2]) as f64 / 2.0).abs() <= wa.max(wb) * 0.25;
            if overlap_x >= 0.3 * wa.min(wb) || centred {
                let (ri, rj) = (find(&mut stack, i), find(&mut stack, j));
                stack[ri] = rj;
            }
        }
    }
    let mut blocks: Vec<(usize, Vec<Comp>)> = Vec::new();
    for i in 0..lines.len() {
        let root = find(&mut stack, i);
        match blocks.iter_mut().find(|(r, _)| *r == root) {
            Some((_, list)) => list.extend(&lines[i].list),
            None => blocks.push((root, lines[i].list.clone())),
        }
    }
    blocks
        .into_iter()
        .map(|(_, list)| {
            let heights: Vec<f64> = list.iter().map(|c| c.h as f64).collect();
            Block {
                region: TextRegion { r#box: bounds_of(&list), letter_height: quantile(&heights, 0.6).max(3.0), glyphs: list.len() },
                list,
            }
        })
        .collect()
}

/// A ponta fina de algo mais grosso que o filtro (pontas de balão de grito, cabelo, um painel escuro):
/// ao lado dela há pixels sem tinta da mesma cor. Uma letra só tem fundo em volta.
fn is_tip(c: &Comp, gray: &[u8], ink: &[u8], labels: &[i32], ww: usize, wh: usize) -> bool {
    let e = round(c.h as f64 * 0.35).max(2);
    let x0 = c.x0.saturating_sub(e);
    let y0 = c.y0.saturating_sub(e);
    let x1 = (c.x1 + e).min(ww);
    let y1 = (c.y1 + e).min(wh);
    let step = round((((x1 - x0) * (y1 - y0)) as f64 / 300.0).sqrt()).max(1);
    let (mut own, mut own_count) = (0f64, 0usize);
    for y in (c.y0..c.y1).step_by(step) {
        for x in (c.x0..c.x1).step_by(step) {
            let p = y * ww + x;
            if labels[p] == c.id {
                own += gray[p] as f64;
                own_count += 1;
            }
        }
    }
    if own_count == 0 {
        return false;
    }
    own /= own_count as f64;
    let (mut around, mut alike) = (0usize, 0usize);
    for y in (y0..y1).step_by(step) {
        for x in (x0..x1).step_by(step) {
            let p = y * ww + x;
            if ink[p] != 0 {
                continue;
            }
            around += 1;
            if (gray[p] as f64 - own).abs() < 40.0 {
                alike += 1;
            }
        }
    }
    around > 0 && alike as f64 > around as f64 * 0.08
}

/// O maior número de trechos do componente cruzados numa linha pelo meio dele.
fn strokes_across(c: &Comp, labels: &[i32], ww: usize) -> usize {
    let mut best = 0;
    for f in [0.3, 0.5, 0.7] {
        let row = (c.y0 + (c.h as f64 * f).floor() as usize) * ww;
        let (mut runs, mut inside) = (0, false);
        for x in c.x0..c.x1 {
            let on = labels[row + x] == c.id;
            if on && !inside {
                runs += 1;
            }
            inside = on;
        }
        best = best.max(runs);
    }
    best
}

/// As letras de uma linha dividem o topo ou a base, numa reta que pode estar inclinada (quadros em
/// perspectiva); pontas de espinhos ou cabelo numa curva, não.
fn is_aligned(list: &[Comp], h: f64) -> bool {
    if list.len() == 1 {
        return true;
    }
    if list.len() >= 3 {
        let heights: Vec<f64> = list.iter().map(|c| c.h as f64).collect();
        let mid = quantile(&heights, 0.5);
        if (heights.iter().filter(|&&x| (x - mid).abs() <= mid * 0.2).count() as f64) < list.len() as f64 * 0.6 {
            return false;
        }
    }
    let cx: Vec<f64> = list.iter().map(|c| (c.x0 + c.x1) as f64 / 2.0).collect();
    let cy: Vec<f64> = list.iter().map(|c| (c.y0 + c.y1) as f64 / 2.0).collect();
    let n = list.len() as f64;
    let mx = cx.iter().sum::<f64>() / n;
    let my = cy.iter().sum::<f64>() / n;
    let (mut sxy, mut sxx) = (0.0, 0.0);
    for i in 0..list.len() {
        sxy += (cx[i] - mx) * (cy[i] - my);
        sxx += (cx[i] - mx).powi(2);
    }
    let slope = if list.len() >= 3 && sxx > 0.0 { sxy / sxx } else { 0.0 };
    if slope.abs() > 0.25 {
        return false;
    }
    let tops: Vec<f64> = list.iter().zip(&cx).map(|(c, x)| c.y0 as f64 - slope * (x - mx)).collect();
    let bottoms: Vec<f64> = list.iter().zip(&cx).map(|(c, x)| c.y1 as f64 - slope * (x - mx)).collect();
    let max_b = bottoms.iter().cloned().fold(f64::MIN, f64::max);
    let min_t = tops.iter().cloned().fold(f64::MAX, f64::min);
    if max_b - min_t > 1.8 * h {
        return false;
    }
    let top = quantile(&tops, 0.5);
    let bottom = quantile(&bottoms, 0.5);
    let tol = (h * 0.2).max(2.0);
    let aligned = (0..list.len()).filter(|&i| (tops[i] - top).abs() <= tol || (bottoms[i] - bottom).abs() <= tol).count();
    if list.len() == 2 { aligned == 2 } else { aligned as f64 >= list.len() as f64 * 0.7 }
}

/// Letreiro é uma sequência de letras de altura parecida sobre uma cor lisa (balão, caixa de
/// narração); grupos tirados do desenho têm poucas peças desiguais sobre fundo carregado.
fn is_text_block(block: &Block, gray: &[u8], ink: &[u8], ww: usize, wh: usize) -> bool {
    let list = &block.list;
    let widest = list.iter().map(|c| c.w as f64 / c.h as f64).fold(0.0, f64::max);
    if list.len() < 3 && widest < 2.5 {
        return false;
    }
    let heights: Vec<f64> = list.iter().map(|c| c.h as f64).collect();
    if list.len() >= 3 && quantile(&heights, 0.8) > 2.2 * quantile(&heights, 0.2) {
        return false;
    }
    flat_between(&block.region, gray, ink, ww, wh) || flat_around(&block.region, gray, ww, wh)
}

fn clip(b: [i64; 4], ww: usize, wh: usize) -> Option<[usize; 4]> {
    let x0 = b[0].max(0) as usize;
    let y0 = b[1].max(0) as usize;
    let x1 = (b[2].max(0) as usize).min(ww);
    let y1 = (b[3].max(0) as usize).min(wh);
    (x1 >= x0 + 2 && y1 >= y0 + 2).then_some([x0, y0, x1, y1])
}

fn sample(gray: &[u8], ww: usize, r: [usize; 4], per: f64) -> Vec<i32> {
    let step = round((((r[2] - r[0]) * (r[3] - r[1])) as f64 / per).sqrt()).max(1);
    let mut values = Vec::new();
    for y in (r[1]..r[3]).step_by(step) {
        for x in (r[0]..r[2]).step_by(step) {
            values.push(gray[y * ww + x] as i32);
        }
    }
    values
}

/// Os pixels sem tinta dentro e logo em volta do bloco são quase todos do mesmo cinza.
fn flat_between(block: &TextRegion, gray: &[u8], ink: &[u8], ww: usize, wh: usize) -> bool {
    let b = block.r#box;
    let pad = round(block.letter_height * 0.5);
    let x0 = b[0].saturating_sub(pad);
    let y0 = b[1].saturating_sub(pad);
    let x1 = (b[2] + pad).min(ww);
    let y1 = (b[3] + pad).min(wh);
    let step = round((((x1 - x0) * (y1 - y0)) as f64 / 800.0).sqrt()).max(1);
    let mut around = Vec::new();
    let mut total = 0;
    for y in (y0..y1).step_by(step) {
        for x in (x0..x1).step_by(step) {
            total += 1;
            if ink[y * ww + x] == 0 {
                around.push(gray[y * ww + x] as i32);
            }
        }
    }
    if around.len() < 16 || (around.len() as f64) < total as f64 * 0.45 {
        return false;
    }
    let median = quantile(&around, 0.5);
    around.iter().filter(|&&v| (v - median).abs() <= BLOCK_TOLERANCE).count() as f64 >= around.len() as f64 * 0.7
}

/// A margem em volta do bloco, uma faixa por lado, cada uma julgada sozinha (degradês passam).
fn flat_around(block: &TextRegion, gray: &[u8], ww: usize, wh: usize) -> bool {
    let lh = block.letter_height;
    let near = round(lh * 0.3).max(2) as i64;
    let far = (round(lh * 0.9) as i64).max(near + 2);
    let [bx0, by0, bx1, by1] = block.r#box.map(|v| v as i64);
    let strips = [
        [bx0 - far, by0 - far, bx1 + far, by0 - near],
        [bx0 - far, by1 + near, bx1 + far, by1 + far],
        [bx0 - far, by0, bx0 - near, by1],
        [bx1 + near, by0, bx1 + far, by1],
    ];
    let (mut score, mut sides) = (0.0, 0);
    for s in strips {
        let Some(r) = clip(s, ww, wh) else { continue };
        let values = sample(gray, ww, r, 200.0);
        let median = quantile(&values, 0.5);
        score += values.iter().filter(|&&v| (v - median).abs() <= BLOCK_TOLERANCE).count() as f64 / values.len() as f64;
        sides += 1;
    }
    sides > 0 && score / sides as f64 >= 0.75
}

/// As pontas de um balão de grito (e os vãos brancos entre elas) se alinham como letras, mas um lado
/// delas é uma massa da mesma cor. Letreiro tem fundo em todos os lados.
fn beside_own_colour(block: &Block, dark: bool, gray: &[u8], labels: &[i32], ww: usize, wh: usize) -> bool {
    let mut values = Vec::new();
    for c in &block.list {
        let step = round((c.count as f64 / 50.0).sqrt()).max(1);
        for y in (c.y0..c.y1).step_by(step) {
            for x in (c.x0..c.x1).step_by(step) {
                if labels[y * ww + x] == c.id {
                    values.push(gray[y * ww + x] as i32);
                }
            }
        }
    }
    if values.is_empty() {
        return false;
    }
    let own = quantile(&values, 0.5);
    let lh = block.region.letter_height;
    let near = round(lh * 0.3).max(2) as i64;
    let far = (round(lh * 0.9) as i64).max(near + 2);
    let [bx0, by0, bx1, by1] = block.region.r#box.map(|v| v as i64);
    // Só em cima e embaixo: as pontas se alinham no alto e no pé do balão.
    for s in [[bx0, by0 - far, bx1, by0 - near], [bx0, by1 + near, bx1, by1 + far]] {
        let Some(r) = clip(s, ww, wh) else { continue };
        let median = quantile(&sample(gray, ww, r, 200.0), 0.5);
        if if dark { median <= own + 35 } else { median >= own - 35 } {
            return true;
        }
    }
    false
}

fn area(b: IBox) -> f64 {
    (((b[2] - b[0]) * (b[3] - b[1])) as f64).max(1.0)
}

fn overlap_area(a: IBox, b: IBox) -> f64 {
    let w = a[2].min(b[2]) as f64 - a[0].max(b[0]) as f64;
    let h = a[3].min(b[3]) as f64 - a[1].max(b[1]) as f64;
    w.max(0.0) * h.max(0.0)
}

/// Letreiro com contorno aparece nas duas passadas (contorno escuro, miolo claro): um bloco só.
fn merge_regions(mut regions: Vec<TextRegion>) -> Vec<TextRegion> {
    regions.sort_by(|a, b| b.glyphs.cmp(&a.glyphs));
    let mut out: Vec<TextRegion> = Vec::new();
    for region in regions {
        match out.iter_mut().find(|o| overlap_area(o.r#box, region.r#box) > 0.3 * area(o.r#box).min(area(region.r#box))) {
            Some(twin) => {
                twin.r#box = [
                    twin.r#box[0].min(region.r#box[0]),
                    twin.r#box[1].min(region.r#box[1]),
                    twin.r#box[2].max(region.r#box[2]),
                    twin.r#box[3].max(region.r#box[3]),
                ];
            }
            None => out.push(region),
        }
    }
    out
}

/// Linhas de um mesmo balão que o agrupamento deixou separadas viram uma região: ficam uma sobre a
/// outra e o fundo do balão liga as duas sem cruzar uma borda. Senão o modelo tende a citar só uma
/// parte, e o resto fica no idioma original.
fn join_bubbles(regions: Vec<TextRegion>, gray: &[u8], w: usize, h: usize) -> Vec<TextRegion> {
    let mut parent: Vec<usize> = (0..regions.len()).collect();
    for i in 0..regions.len() {
        for j in i + 1..regions.len() {
            let (a, b) = (&regions[i], &regions[j]);
            let lo = a.letter_height.min(b.letter_height);
            let hi = a.letter_height.max(b.letter_height);
            if hi > 1.8 * lo {
                continue;
            }
            let (ab, bb) = (a.r#box.map(|v| v as f64), b.r#box.map(|v| v as f64));
            let gap_y = (bb[1] - ab[3]).max(ab[1] - bb[3]).max(0.0);
            let overlap_x = ab[2].min(bb[2]) - ab[0].max(bb[0]);
            let (wa, wb) = (ab[2] - ab[0], bb[2] - bb[0]);
            if gap_y > 2.2 * hi || overlap_x < 0.5 * wa.min(wb) {
                continue;
            }
            let (area_a, area_b) = (wa * (ab[3] - ab[1]), wb * (bb[3] - bb[1]));
            // A fala principal e um comentário pequeno no canto têm tamanhos muito diferentes.
            if area_a.min(area_b) < 0.4 * area_a.max(area_b) && gap_y > 0.0 {
                continue;
            }
            // Linhas de um balão são centralizadas ou alinhadas à esquerda.
            let centred = (ab[0] + ab[2] - bb[0] - bb[2]).abs() / 2.0 <= 0.2 * wa.max(wb);
            if !centred && (ab[0] - bb[0]).abs() > lo {
                continue;
            }
            if same_background(a.r#box, b.r#box, hi, gray, w, h) {
                let (ri, rj) = (find(&mut parent, i), find(&mut parent, j));
                parent[ri] = rj;
            }
        }
    }
    let mut groups: HashMap<usize, Vec<&TextRegion>> = HashMap::new();
    let mut order = Vec::new();
    for (i, r) in regions.iter().enumerate() {
        let root = find(&mut parent, i);
        if !groups.contains_key(&root) {
            order.push(root);
        }
        groups.entry(root).or_default().push(r);
    }
    order
        .into_iter()
        .map(|root| {
            let list = &groups[&root];
            let mut b = list[0].r#box;
            for r in list {
                b = [b[0].min(r.r#box[0]), b[1].min(r.r#box[1]), b[2].max(r.r#box[2]), b[3].max(r.r#box[3])];
            }
            TextRegion {
                r#box: b,
                letter_height: list.iter().map(|r| r.letter_height).fold(0.0, f64::max),
                glyphs: list.iter().map(|r| r.glyphs).sum(),
            }
        })
        .collect()
}

/// Se o fundo da cor em volta de `a` leva, contornando as letras, até a área em volta de `b`.
fn same_background(a: IBox, b: IBox, letter_height: f64, gray: &[u8], w: usize, h: usize) -> bool {
    let pad = round(letter_height * 0.3).max(2);
    let x0 = a[0].min(b[0]).saturating_sub(2 * pad);
    let y0 = a[1].min(b[1]).saturating_sub(2 * pad);
    let x1 = (a[2].max(b[2]) + 2 * pad).min(w);
    let y1 = (a[3].max(b[3]) + 2 * pad).min(h);
    let ww = x1 - x0;
    let in_ring = |bx: IBox, x: usize, y: usize| {
        let (x, y) = (x as i64, y as i64);
        let [b0, b1, b2, b3] = bx.map(|v| v as i64);
        let p = pad as i64;
        x >= b0 - p && x < b2 + p && y >= b1 - p && y < b3 + p && !(x >= b0 && x < b2 && y >= b1 && y < b3)
    };
    let mut ring_a = Vec::new();
    let mut ring_b = Vec::new();
    for y in y0..y1 {
        for x in x0..x1 {
            if in_ring(a, x, y) {
                ring_a.push(y * w + x);
            }
            if in_ring(b, x, y) {
                ring_b.push(y * w + x);
            }
        }
    }
    if ring_a.is_empty() || ring_b.is_empty() {
        return false;
    }
    let bg = quantile(&ring_a.iter().map(|&p| gray[p] as i32).collect::<Vec<_>>(), 0.5);
    if (quantile(&ring_b.iter().map(|&p| gray[p] as i32).collect::<Vec<_>>(), 0.5) - bg).abs() > BLOCK_TOLERANCE {
        return false;
    }
    let target: HashSet<usize> = ring_b.into_iter().collect();
    let mut seen = vec![false; ww * (y1 - y0)];
    let mut queue = Vec::new();
    for p in ring_a {
        if (gray[p] as i32 - bg).abs() > BLOCK_TOLERANCE {
            continue;
        }
        if target.contains(&p) {
            return true;
        }
        seen[(p / w - y0) * ww + p % w - x0] = true;
        queue.push(p);
    }
    while let Some(p) = queue.pop() {
        let (x, y) = (p % w, p / w);
        let neighbours = [(x.wrapping_sub(1), y), (x + 1, y), (x, y.wrapping_sub(1)), (x, y + 1)];
        for (nx, ny) in neighbours {
            if nx < x0 || nx >= x1 || ny < y0 || ny >= y1 {
                continue;
            }
            let s = (ny - y0) * ww + nx - x0;
            let q = ny * w + nx;
            if seen[s] || (gray[q] as i32 - bg).abs() > BLOCK_TOLERANCE {
                continue;
            }
            if target.contains(&q) {
                return true;
            }
            seen[s] = true;
            queue.push(q);
        }
    }
    false
}
