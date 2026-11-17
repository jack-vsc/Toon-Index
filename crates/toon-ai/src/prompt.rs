//! O que se pede ao modelo e como a resposta vira blocos de texto na página.

use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;
use toon_core::settings::{AUTO_LANGUAGE, Settings};

use crate::error::AiError;
use crate::json::parse_lenient;
use crate::types::{BlockKind, Box, FontRole, MarkedRegion, TextBlock, TranslateRequest};

const EXAMPLE_FIELDS: &str =
    r##""original":"","translation":"","kind":"speech","font":"comic","italic":false,"color":"#000000","outline":null"##;

fn source_line(settings: &Settings) -> String {
    if settings.source_language == AUTO_LANGUAGE {
        "Detect the source language automatically.".into()
    } else {
        format!("The source language is {}.", settings.source_language)
    }
}

fn block_fields(target: &str) -> String {
    format!(
        r##"- "original": the original text.
- "translation": natural, fluent {target}, matching the tone of the character. Keep it concise so it fits the bubble.
- "kind": "speech" (regular dialogue bubble), "thought" (inner monologue: cloud, fuzzy or dark bubble), "shout" (yelling: jagged burst bubble or big bold lettering), "whisper" (said quietly: dashed or faint bubble, small light lettering), "narration" (caption box with a flat background), "system" (game-like system window, status screen or notification), "aside" (small remark in the corner of a bubble or beside a character, always its own block), "signage" (a sign, building name or label drawn on the artwork, such as a hospital or shop front; the translation is shown below the panel, not over the art), "sfx" (sound effect), "watermark" (a scanlation group's watermark, credit or website, to be erased).
- "font": typeface of the original lettering: "comic" (standard comic lettering), "brush" (bold slanted marker/brush lettering), "condensed" (tall narrow sans-serif), "sans", "serif" or "handwritten" (small casual handwriting).
- "italic": true if the original lettering is slanted.
- "color": fill colour of the original letters as "#rrggbb".
- "outline": colour of the outline drawn around the original letters as "#rrggbb", or null if they have none."##
    )
}

pub fn build_prompt(req: &TranslateRequest, settings: &Settings) -> String {
    let source = source_line(settings);
    let target = &settings.target_language;
    let sfx = if settings.translate_sfx {
        format!(
            r#"Also include sound effects / onomatopoeia drawn in the artwork (kind "sfx"), Korean, Japanese and Chinese ones too: each sound effect is one block, and its "translation" is the onomatopoeia a {target} letterer would draw instead (short, uppercase: a laugh, a gulp, a thud), never a description of the sound and never the original characters: a Korean, Japanese or Chinese sound effect is always rewritten in Latin letters."#
        )
    } else {
        "Ignore sound effects / onomatopoeia drawn as part of the artwork; do not return them.".into()
    };
    let multi = req.images.len() > 1;
    let sizes: Vec<String> = req.images.iter().enumerate().map(|(i, im)| format!("image {i}: {}x{}", im.width, im.height)).collect();
    let intro = if multi {
        format!(
            "The first {} attached images are consecutive vertical slices of ONE long manga/webtoon page, ordered top to bottom. Sizes (width x height): {}.\nNeighbouring slices overlap, so some text shows in two slices; it is boxed in only one of them, and is returned only once. If a text block is cut by the top or bottom edge of a slice, skip it in that slice: it appears complete in the neighbouring slice.",
            req.images.len(),
            sizes.join(", ")
        )
    } else {
        let first = &req.images[0];
        format!("The first attached image is one manga/webtoon page, exactly {}x{} pixels (width x height).", first.width, first.height)
    };
    let fields = block_fields(target);

    if req.regions.is_empty() {
        return format!(
            r#"You are a professional manga translator.

{intro}
{source}
Translate every piece of readable text into {target}.
{sfx}
Scanlation watermarks, credits and website URLs written over the artwork (such as "YOU CAN FIND ALL CHAPTERS ON OUR WEBSITE: ...") are blocks of kind "watermark" with an empty translation: they are erased, not translated. A watermark sometimes runs into a bubble, its lines side by side with a character's words: then give two blocks listing the same boxes, the watermark, and the words alone (their original and translation without any of the watermark).

Return EVERY text block, including small bubbles, one-word bubbles and short interjections: a missed bubble stays untranslated.

For each text block (one speech bubble, thought bubble, narration box, system window or caption = one block) return:
- "image": index of the image the block is on.
- "box_2d": a bounding box [ymin, xmin, ymax, xmax] that tightly encloses all of the block's glyphs, normalized to 0-1000 relative to the height and width of that image.
{fields}

List blocks in reading order. Images without text get no entries.

Respond with ONLY a JSON object, no markdown fences and no commentary, in exactly this shape:
{{"blocks":[{{"image":0,"box_2d":[0,0,0,0],{EXAMPLE_FIELDS}}}]}}"#
        );
    }

    let key_count = req.key.len();
    let key_images = if key_count == 1 {
        format!("image {}", req.images.len())
    } else {
        format!("images {}-{}", req.images.len(), req.images.len() + key_count - 1)
    };
    let s = if multi { "s" } else { "" };
    let key_intro = if key_count == 1 { "image".to_string() } else { format!("{key_count} images") };
    let is_are = if key_count == 1 { "is" } else { "are" };
    let sfx_skip = if settings.translate_sfx { ", unless it is a sound effect" } else { "" };
    format!(
        r#"You are a professional manga translator.

{intro}
Text detection software has drawn numbered magenta boxes on the page image{s}, each around a block of lettering it found; the number is on a magenta tag next to the box and is unique across all images. The last attached {key_intro} ({key_images}) {is_are} the key: every box cut out and enlarged, its number on the magenta tag at its left. Read the text of each box on the key; use the page for context (who speaks to whom, what is happening, which boxes share a bubble).
The software can be wrong: a box may surround artwork or a bubble's border with no text, one bubble may be split into several boxes, and some text may have no box.
{source}
Translate the text into {target}.
{sfx}
Scanlation watermarks, credits and website URLs written over the artwork (such as "YOU CAN FIND ALL CHAPTERS ON OUR WEBSITE: ...") are blocks of kind "watermark" with an empty translation: they are erased, not translated. Korean, Japanese or Chinese writing left in the artwork of a page lettered in another language (shop signs, background writing, leftovers of the original edition) is part of the art: skip it{sfx_skip}. Lettered text is always translated, system windows and status screens included.

Answer EVERY numbered box exactly once: put its number in the "ids" of the text block it belongs to, or in "skip" when it holds nothing to translate (artwork, a pattern, a bubble border, a sound effect that is not translated). A bubble whose text is split over several boxes is one block that lists all of them; the main bubble and a small line in its corner are always separate blocks. A box holding a watermark next to other lettering is two blocks that both list it: the watermark, and the other lettering on its own. Separate bubbles, captions and side remarks beside a bubble are separate blocks too. A box left out stays untranslated on the page.

For each text block (one speech bubble, thought bubble, narration box, system window or caption = one block) return:
- "ids": the numbers of the boxes holding this block's letters; never boxes that only hold the bubble's border, spikes or artwork around the text.
{fields}

Text with no box at all (check the page for bubbles and captions without a magenta box) is a block with "ids": [] and also:
- "image": index of the page image it is on.
- "box_2d": a bounding box [ymin, xmin, ymax, xmax] that tightly encloses its glyphs, normalized to 0-1000 relative to the height and width of that image.

List blocks in reading order.

Respond with ONLY a JSON object, no markdown fences and no commentary, in exactly this shape:
{{"skip":[3],"blocks":[{{"ids":[1,2],{EXAMPLE_FIELDS}}},{{"ids":[],"image":0,"box_2d":[0,0,0,0],{EXAMPLE_FIELDS}}}]}}"#
    )
}

/// Pergunta de novo pelas caixas que o modelo deixou de fora, mostrando só a chave.
pub fn build_follow_up(ids: &[u32], req: &TranslateRequest, settings: &Settings) -> String {
    let source = source_line(settings);
    let target = &settings.target_language;
    let shows = if req.key.len() > 1 { "s show" } else { " shows" };
    let list: Vec<String> = ids.iter().map(u32::to_string).collect();
    let sfx = if settings.translate_sfx { "" } else { ", a sound effect" };
    let fields = block_fields(target);
    let first = ids.first().copied().unwrap_or(1);
    format!(
        r#"You are a professional manga translator.

The attached image{shows} blocks of lettering cut out of a manga/webtoon page, each with its number on a magenta tag at its left. {source}
Translate the text of boxes {} into {target}; ignore the other boxes.
Answer each of these boxes exactly once: put its number in the "ids" of a text block, or in "skip" when it holds nothing to translate (artwork, a pattern, a bubble border{sfx}); a watermark is a block of kind "watermark". Boxes that are parts of one sentence or bubble form one block that lists all of them.

For each text block return:
- "ids": the numbers of the boxes holding this block's text.
{fields}

Respond with ONLY a JSON object, no markdown fences and no commentary, in exactly this shape:
{{"skip":[],"blocks":[{{"ids":[{first}],{EXAMPLE_FIELDS}}}]}}"#,
        list.join(", ")
    )
}

/// Os parágrafos de uma novel (texto lido do PDF, sem imagens), traduzidos um a um.
pub fn build_novel_prompt(paragraphs: &[String], context: &[String], settings: &Settings) -> String {
    let source = source_line(settings);
    let target = &settings.target_language;
    let before = if context.is_empty() {
        String::new()
    } else {
        let quoted: Vec<String> = context.iter().map(|p| format!("> {p}")).collect();
        format!(
            "\nFor context only (already translated elsewhere, do NOT return them), the paragraphs just before:\n{}\n",
            quoted.join("\n")
        )
    };
    let numbered: Vec<String> = paragraphs.iter().enumerate().map(|(i, p)| format!("[{}] {p}", i + 1)).collect();
    let n = paragraphs.len();
    format!(
        r#"You are a professional literary translator translating a light novel into {target}.
{source}
Translate the numbered paragraphs below. Write natural, fluent prose a published {target} edition would have: keep the meaning, tone, names, honorifics and the narrator's voice, and use the dialogue punctuation that is usual in {target} novels. Do not summarize, merge, split, censor or add anything. A paragraph that is only a symbol or a scene break comes back unchanged. A chapter title is translated as a title.
{before}
Paragraphs ({n}):
{}

Answer with a JSON object and nothing else: {{"t": ["translation of [1]", "translation of [2]", ...]}} with exactly {n} strings, in order."#,
        numbered.join("\n")
    )
}

pub fn parse_novel(raw: &str, count: usize) -> Result<Vec<String>, AiError> {
    let start = raw.find('{').unwrap_or(0);
    let parsed = parse_lenient(&raw[start..]).map_err(|e| AiError::Format(e.to_string()))?;
    let list: Option<Vec<String>> = parsed
        .get("t")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|s| s.as_str().map(str::to_string)).collect());
    match list {
        Some(l) if l.len() == count => Ok(l),
        other => Err(AiError::Format(format!("A IA devolveu {} parágrafos de {count}.", other.map_or(0, |l| l.len())))),
    }
}

/// Uma lista de blocos por imagem pedida, na mesma ordem, e as caixas que a resposta cobriu.
pub struct Parsed {
    pub blocks: Vec<Vec<TextBlock>>,
    pub answered: HashSet<u32>,
    pub skipped: HashSet<u32>,
}

static WEBSITE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b[a-z0-9-]+\.(?:com|net|org|io|co|me|to|gg|cc|xyz|site|online|club|info)\b").unwrap()
});

fn extract_json(raw: &str) -> Result<Value, AiError> {
    static FENCE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)```(?:json)?").unwrap());
    let cleaned = FENCE.replace_all(raw, "");
    let cleaned = cleaned.trim();
    let preview: String = raw.chars().take(300).collect();
    let Some(start) = cleaned.find(['{', '[']) else {
        return Err(AiError::Format(format!("A IA não retornou JSON válido. Resposta: {preview}")));
    };
    parse_lenient(&cleaned[start..]).map_err(|e| AiError::Format(format!("Falha ao ler o JSON da IA: {e}. Resposta: {preview}")))
}

fn normalized_letters(text: &str) -> String {
    text.to_lowercase().chars().filter(|c| c.is_alphanumeric()).collect()
}

/// `boxed_only` descarta blocos posicionados pela caixa do próprio modelo (as repescagens só mostram a chave).
pub fn parse_blocks(raw: &str, req: &TranslateRequest, boxed_only: bool) -> Result<Parsed, AiError> {
    let json = extract_json(raw)?;
    let mut result: Vec<Vec<TextBlock>> = vec![Vec::new(); req.images.len()];
    let mut answered = HashSet::new();
    let mut skipped = HashSet::new();
    for id in json.get("skip").and_then(Value::as_array).into_iter().flatten() {
        if let Some(id) = id.as_f64() {
            answered.insert(id as u32);
            skipped.insert(id as u32);
        }
    }
    // Aceita também blocos agrupados por imagem, que alguns modelos usam.
    let mut entries: Vec<Value> = if let Some(b) = json.get("blocks").and_then(Value::as_array) {
        b.clone()
    } else if let Some(images) = json.get("images").and_then(Value::as_array) {
        images
            .iter()
            .flat_map(|g| {
                let image = g.get("image").cloned().unwrap_or(Value::Null);
                g.get("blocks").and_then(Value::as_array).cloned().unwrap_or_default().into_iter().map(move |mut b| {
                    if let Value::Object(o) = &mut b {
                        o.entry("image").or_insert(image.clone());
                    }
                    b
                })
            })
            .collect()
    } else if let Some(list) = json.as_array() {
        list.clone()
    } else {
        Vec::new()
    };
    if !boxed_only {
        realign_ids(&mut entries, req);
    }
    // Um balão na sobra entre duas faixas às vezes volta duas vezes, a segunda numa caixa qualquer
    // perto; a cópia com mais letras é a de verdade.
    struct Seen {
        image: usize,
        index: usize,
        glyphs: u32,
    }
    let mut seen: HashMap<String, Seen> = HashMap::new();
    let mut removed: HashSet<(usize, usize)> = HashSet::new();
    for entry in &entries {
        let picked = pick_regions(entry.get("ids"), req);
        if boxed_only && picked.is_empty() {
            continue;
        }
        // Uma tradução presa repetindo a si mesma ("E A E E E…") não é resposta.
        if looping(entry.get("translation")) {
            continue;
        }
        let Some((image, block, kept)) = to_block(entry, &picked, req) else {
            for r in &picked {
                answered.insert(r.id);
            }
            continue;
        };
        for r in &kept {
            answered.insert(r.id);
        }
        let glyphs: u32 = kept.iter().map(|r| r.glyphs).sum();
        let original = format!("o:{}", normalized_letters(&block.original));
        let translation = format!("t:{}", normalized_letters(&block.translation));
        let mut keys = Vec::new();
        if original.chars().count() >= 5 {
            keys.push(original.clone());
        }
        if translation.chars().count() >= 17 {
            keys.push(translation.clone());
        }
        let live = |key: &str, seen: &HashMap<String, Seen>| seen.get(key).filter(|t| !removed.contains(&(t.image, t.index))).map(|t| (t.image, t.index, t.glyphs));
        let same_text = if keys.contains(&original) { live(&original, &seen) } else { None };
        let twin = same_text
            .filter(|t| t.0 != image)
            .or_else(|| if keys.contains(&translation) { live(&translation, &seen) } else { None });
        if let Some((ti, tidx, tg)) = twin {
            if tg >= glyphs {
                continue;
            }
            removed.insert((ti, tidx));
        }
        let index = result[image].len();
        result[image].push(block);
        for key in keys {
            seen.insert(key, Seen { image, index, glyphs });
        }
    }
    let blocks = result
        .into_iter()
        .enumerate()
        .map(|(i, list)| list.into_iter().enumerate().filter(|(j, _)| !removed.contains(&(i, *j))).map(|(_, b)| b).collect())
        .collect();
    Ok(Parsed { blocks, answered, skipped })
}

const MIN_COUNTED_GLYPHS: u32 = 3;
/// Texto e caixas tão diferentes em tamanho (log da razão: umas 1,65 vez) não combinam.
const MISFIT: f64 = 0.5;

fn letter_count(text: &str) -> usize {
    text.chars().filter(|c| c.is_alphanumeric()).count()
}

/// Modelos pequenos às vezes perdem a conta das caixas no meio da página: de um bloco em diante, cada
/// texto vem com o número da caixa seguinte (ou anterior). O detector mediu quantas letras cada caixa
/// tem; quando os textos dali em diante cabem muito melhor nas caixas deslocadas, eles mudam.
pub fn realign_ids(entries: &mut [Value], req: &TranslateRequest) {
    let mut order: Vec<&MarkedRegion> = req.regions.iter().filter(|r| r.glyphs >= MIN_COUNTED_GLYPHS).collect();
    order.sort_by_key(|r| r.id);
    let at: HashMap<u32, usize> = order.iter().enumerate().map(|(i, r)| (r.id, i)).collect();
    struct Row {
        entry: usize,
        places: Vec<usize>,
        letters: usize,
    }
    let rows: Vec<Row> = entries
        .iter()
        .enumerate()
        .filter_map(|(i, e)| {
            let original = e.get("original")?.as_str()?;
            let ids = e.get("ids")?.as_array()?;
            let places: Vec<usize> = ids.iter().filter_map(|id| id.as_f64().and_then(|n| at.get(&(n as u32)).copied())).collect();
            let letters = letter_count(original);
            (letters >= 4 && !places.is_empty()).then_some(Row { entry: i, places, letters })
        })
        .collect();
    if rows.len() < 3 {
        return;
    }
    let cost = |row: &Row, shift: i64| -> f64 {
        let mut glyphs = 0u32;
        for &p in &row.places {
            let q = p as i64 + shift;
            if q < 0 || q >= order.len() as i64 {
                return f64::INFINITY;
            }
            glyphs += order[q as usize].glyphs;
        }
        (((row.letters as f64 + 4.0) / (glyphs as f64 + 4.0)).ln()).abs().min(3.0)
    };
    let given: Vec<f64> = rows.iter().map(|r| cost(r, 0)).collect();
    let mut best = (usize::MAX, 0usize, 0i64, 0.0f64, 0.0f64, 0.0f64);
    for shift in [1i64, -1] {
        let moved: Vec<f64> = rows.iter().map(|r| cost(r, shift)).collect();
        for from in 0..rows.len() {
            let (mut before, mut after) = (0.0, 0.0);
            let mut to = from + 1;
            while to <= rows.len() && given[to - 1] >= MISFIT && moved[to - 1] < given[to - 1] {
                before += given[to - 1];
                after += moved[to - 1];
                if to - from >= 2 && before - after > best.3 {
                    best = (from, to, shift, before - after, before, after);
                }
                to += 1;
            }
        }
    }
    let (from, to, shift, saved, before, after) = best;
    if from == usize::MAX || saved < 1.5 || after > 0.5 * before {
        return;
    }
    for row in &rows[from..to] {
        let ids: Vec<Value> = row.places.iter().map(|&p| Value::from(order[(p as i64 + shift) as usize].id)).collect();
        entries[row.entry]["ids"] = Value::Array(ids);
    }
    tracing::warn!("números das caixas trocados por {shift} nos blocos {}-{} de {}: corrigidos", from + 1, to, rows.len());
}

/// Uma palavra (ou poucas) repetida muitas vezes seguidas, ou bem mais texto do que cabe num balão.
pub fn looping(translation: Option<&Value>) -> bool {
    let Some(text) = translation.and_then(Value::as_str) else { return false };
    if text.chars().count() > 1200 {
        return true;
    }
    let words: Vec<&str> = text.split_whitespace().collect();
    for width in 1..=3 {
        let mut run = 1;
        let mut i = width;
        while i + width <= words.len() {
            if words[i..i + width] == words[i - width..i] {
                run += 1;
                if run >= 10 {
                    return true;
                }
                i += width;
            } else {
                run = 1;
                i += 1;
            }
        }
    }
    false
}

fn pick_regions<'a>(ids: Option<&Value>, req: &'a TranslateRequest) -> Vec<&'a MarkedRegion> {
    let list: Vec<u32> = match ids {
        Some(Value::Array(a)) => a.iter().filter_map(|v| v.as_f64().filter(|n| n.fract() == 0.0).map(|n| n as u32)).collect(),
        Some(v) => v.as_f64().map(|n| vec![n as u32]).unwrap_or_default(),
        None => Vec::new(),
    };
    list.iter().filter_map(|id| req.regions.iter().find(|r| r.id == *id)).collect()
}

fn to_block<'a>(
    item: &Value,
    picked: &[&'a MarkedRegion],
    req: &TranslateRequest,
) -> Option<(usize, TextBlock, Vec<&'a MarkedRegion>)> {
    let obj = item.as_object()?;
    let original = obj.get("original").and_then(Value::as_str).unwrap_or("").to_string();
    let kind_text = obj.get("kind").and_then(Value::as_str).unwrap_or("");
    let watermark = kind_text == "watermark" || WEBSITE.is_match(&original);
    let translation =
        if watermark { String::new() } else { obj.get("translation").and_then(Value::as_str).unwrap_or("").trim().to_string() };
    if translation.is_empty() && !watermark {
        return None;
    }
    let words = original.split_whitespace().filter(|w| w.chars().any(char::is_alphanumeric)).count();
    let placed = place(picked, from_box(obj, req), words)?;
    let size = &req.images[placed.image];
    let font = obj.get("font").and_then(Value::as_str).and_then(|f| serde_json::from_value(Value::String(f.into())).ok());
    let block = TextBlock {
        text_box: placed.r#box,
        area_box: room_around(placed.r#box, size.width as f32, size.height as f32),
        ink_boxes: placed.ink_boxes,
        letter_height: placed.letter_height,
        original,
        translation,
        kind: if watermark { BlockKind::Watermark } else { BlockKind::parse(kind_text).unwrap_or(BlockKind::Other) },
        font: font.map(|f: FontRole| f),
        italic: obj.get("italic").and_then(Value::as_bool),
        color: to_hex(obj.get("color")),
        outline: to_hex(obj.get("outline")),
    };
    Some((placed.image, block, placed.kept))
}

struct Placed<'a> {
    image: usize,
    r#box: Box,
    kept: Vec<&'a MarkedRegion>,
    ink_boxes: Option<Vec<Box>>,
    letter_height: Option<f32>,
}

/// As caixas do detector que o modelo escolheu dão a posição exata. A caixa do próprio modelo (muitas
/// vezes uma linha ou mais fora) só posiciona texto que o detector não achou.
fn place<'a>(picked: &[&'a MarkedRegion], guess: Option<(usize, Box)>, words: usize) -> Option<Placed<'a>> {
    if picked.is_empty() {
        return guess.map(|(image, b)| Placed { image, r#box: b, kept: Vec::new(), ink_boxes: None, letter_height: None });
    }
    // Faixas que se sobrepõem numeram o mesmo texto duas vezes; o bloco fica na faixa da maioria das caixas.
    let mut counts: HashMap<usize, usize> = HashMap::new();
    for r in picked {
        *counts.entry(r.image).or_default() += 1;
    }
    let image = counts.iter().max_by(|a, b| a.1.cmp(b.1).then(b.0.cmp(a.0))).map(|(i, _)| *i).unwrap();
    let on_image: Vec<&MarkedRegion> = picked.iter().copied().filter(|r| r.image == image).collect();
    // O detector já junta as linhas de um balão; outras caixas que o modelo junta são pontas do balão
    // ou desenho ao lado, a não ser que continuem o texto logo em seguida.
    let mut kept: Vec<&MarkedRegion> = vec![on_image.iter().copied().fold(on_image[0], |a, b| if b.glyphs > a.glyphs { b } else { a })];
    let mut grew = true;
    while grew {
        grew = false;
        for r in &on_image {
            if !kept.iter().any(|k| std::ptr::eq(*k, *r)) && kept.iter().any(|k| continues(k, r)) {
                kept.push(r);
                grew = true;
            }
        }
    }
    // Cada palavra é pelo menos um pedaço de tinta: bem menos pedaços que palavras é uma caixa ao lado
    // do texto (a ponta de um balão perto de um comentário pequeno, um rosto).
    let pieces: usize = kept.iter().map(|r| r.glyphs as usize).sum();
    if if words <= 2 { pieces < words } else { pieces * 2 < words } {
        return None;
    }
    let ink: Vec<Box> = kept.iter().map(|r| r.r#box).collect();
    let letter_height = kept.iter().map(|r| r.letter_height).fold(0.0f32, f32::max);
    let r#box = ink.iter().copied().reduce(union).unwrap();
    let mut all = kept.clone();
    all.extend(picked.iter().copied().filter(|r| r.image != image));
    Some(Placed { image, r#box, kept: all, ink_boxes: Some(ink), letter_height: Some(letter_height) })
}

/// Se `b` é a próxima linha de `a`, ou o resto da mesma linha.
fn continues(a: &MarkedRegion, b: &MarkedRegion) -> bool {
    let lo = a.letter_height.min(b.letter_height);
    let hi = a.letter_height.max(b.letter_height);
    if hi > 1.8 * lo {
        return false;
    }
    let (ab, bb) = (a.r#box, b.r#box);
    let gap_x = (bb[0] - ab[2]).max(ab[0] - bb[2]).max(0.0);
    let gap_y = (bb[1] - ab[3]).max(ab[1] - bb[3]).max(0.0);
    let overlap_x = ab[2].min(bb[2]) - ab[0].max(bb[0]);
    let overlap_y = ab[3].min(bb[3]) - ab[1].max(bb[1]);
    let min_w = (ab[2] - ab[0]).min(bb[2] - bb[0]);
    (gap_y <= 1.5 * hi && overlap_x >= 0.3 * min_w) || (overlap_y >= 0.5 * lo && gap_x <= 2.0 * hi)
}

fn from_box(obj: &serde_json::Map<String, Value>, req: &TranslateRequest) -> Option<(usize, Box)> {
    let image = obj.get("image").and_then(Value::as_u64).map(|n| n as usize).unwrap_or(0);
    let size = req.images.get(image)?;
    to_box(obj.get("box_2d")?, size.width as f32, size.height as f32).map(|b| (image, b))
}

/// `[ymin, xmin, ymax, xmax]` de 0 a 1000 para `[x0, y0, x1, y1]` em pixels.
fn to_box(value: &Value, width: f32, height: f32) -> Option<Box> {
    let n: Vec<f32> = value.as_array()?.iter().filter_map(|v| v.as_f64().map(|x| x as f32)).collect();
    if n.len() != 4 {
        return None;
    }
    let y0 = (n[0].min(n[2]) / 1000.0 * height).clamp(0.0, height);
    let y1 = (n[0].max(n[2]) / 1000.0 * height).clamp(0.0, height);
    let x0 = (n[1].min(n[3]) / 1000.0 * width).clamp(0.0, width);
    let x1 = (n[1].max(n[3]) / 1000.0 * width).clamp(0.0, width);
    (x1 - x0 >= 2.0 && y1 - y0 >= 2.0).then_some([x0, y0, x1, y1])
}

/// O overlay mede o próprio balão; isso só limita até onde ele procura.
fn room_around(b: Box, width: f32, height: f32) -> Box {
    let w = b[2] - b[0];
    let h = b[3] - b[1];
    let px = (w * 0.3).max(16.0);
    let py = (h * 0.6).max(16.0);
    [(b[0] - px).clamp(0.0, width), (b[1] - py).clamp(0.0, height), (b[2] + px).clamp(0.0, width), (b[3] + py).clamp(0.0, height)]
}

fn to_hex(value: Option<&Value>) -> Option<String> {
    let s = value?.as_str()?.trim();
    (s.len() == 7 && s.starts_with('#') && s[1..].chars().all(|c| c.is_ascii_hexdigit())).then(|| s.to_lowercase())
}

pub fn union(a: Box, b: Box) -> Box {
    [a[0].min(b[0]), a[1].min(b[1]), a[2].max(b[2]), a[3].max(b[3])]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::PageImage;

    fn req() -> TranslateRequest {
        let img = PageImage { base64: String::new(), mime_type: "image/jpeg".into(), width: 1000, height: 1600 };
        TranslateRequest {
            images: vec![img],
            regions: vec![
                MarkedRegion { id: 1, image: 0, r#box: [100.0, 100.0, 400.0, 140.0], letter_height: 30.0, glyphs: 15 },
                MarkedRegion { id: 2, image: 0, r#box: [100.0, 150.0, 420.0, 190.0], letter_height: 30.0, glyphs: 18 },
            ],
            ..Default::default()
        }
    }

    #[test]
    fn lines_of_one_bubble_are_one_block() {
        let raw = r#"{"skip":[],"blocks":[{"ids":[1,2],"original":"Even a child whose surname changes","translation":"Até uma criança cujo sobrenome muda","kind":"narration"}]}"#;
        let parsed = parse_blocks(raw, &req(), false).unwrap();
        let b = &parsed.blocks[0][0];
        assert_eq!(b.ink_boxes.as_ref().unwrap().len(), 2);
        assert_eq!(b.text_box, [100.0, 100.0, 420.0, 190.0]);
        assert!(parsed.answered.contains(&2));
    }

    #[test]
    fn detects_loops() {
        let text = "E A ".repeat(12);
        assert!(looping(Some(&Value::String(text))));
        assert!(!looping(Some(&Value::String("Uma fala normal de balão.".into()))));
    }
}
