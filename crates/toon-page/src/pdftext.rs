//! O texto de cada página de um PDF, lido dos comandos de texto do conteúdo e do mapa `ToUnicode` de
//! cada fonte. Feito à mão porque os mapas de muitas novels (Yen Press, Kobo) não passam no leitor
//! estrito das bibliotecas; aqui, o que não se entende é pulado e o resto continua.

use std::collections::HashMap;
use std::sync::LazyLock;

use lopdf::content::Content;
use lopdf::{Document, Object, ObjectId};
use regex::Regex;

/// Como uma fonte transforma os bytes das strings em texto.
struct FontMap {
    /// Bytes por código: 2 nas fontes CID (Identity-H), 1 nas simples.
    width: usize,
    map: HashMap<u32, String>,
}

impl FontMap {
    fn decode(&self, bytes: &[u8]) -> String {
        let mut out = String::new();
        for chunk in bytes.chunks(self.width) {
            let code = chunk.iter().fold(0u32, |acc, b| (acc << 8) | *b as u32);
            match self.map.get(&code) {
                Some(s) => out.push_str(s),
                // Sem mapa: nas fontes simples o byte costuma ser o próprio caractere (Latin-1).
                None if self.width == 1 => out.push(char::from_u32(code).unwrap_or(' ')),
                None => {}
            }
        }
        out
    }
}

fn hex_to_string(hex: &str) -> String {
    let units: Vec<u16> = hex
        .as_bytes()
        .chunks(4)
        .filter_map(|c| u16::from_str_radix(std::str::from_utf8(c).ok()?, 16).ok())
        .collect();
    String::from_utf16_lossy(&units)
}

/// Lê `bfchar` e `bfrange` de um CMap ToUnicode.
fn parse_cmap(text: &str) -> (usize, HashMap<u32, String>) {
    static SPACE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"begincodespacerange\s*<([0-9A-Fa-f]+)>").unwrap());
    static CHARS: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?s)beginbfchar(.*?)endbfchar").unwrap());
    static CHAR: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>").unwrap());
    static RANGES: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?s)beginbfrange(.*?)endbfrange").unwrap());
    static RANGE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(<([0-9A-Fa-f]*)>|\[([^\]]*)\])")
            .unwrap()
    });
    static ITEM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<([0-9A-Fa-f]*)>").unwrap());
    let width = SPACE
        .captures(text)
        .map(|c| c[1].len() / 2)
        .unwrap_or(2)
        .max(1);
    let mut map = HashMap::new();
    for block in CHARS.captures_iter(text) {
        for c in CHAR.captures_iter(&block[1]) {
            if let Ok(code) = u32::from_str_radix(&c[1], 16) {
                map.insert(code, hex_to_string(&c[2]));
            }
        }
    }
    for block in RANGES.captures_iter(text) {
        for c in RANGE.captures_iter(&block[1]) {
            let (Ok(lo), Ok(hi)) = (
                u32::from_str_radix(&c[1], 16),
                u32::from_str_radix(&c[2], 16),
            ) else {
                continue;
            };
            if hi < lo || hi - lo > 0xFFFF {
                continue;
            }
            if let Some(start) = c.get(4) {
                // Uma faixa contínua: o último caractere do destino avança junto com o código.
                let base = hex_to_string(start.as_str());
                let mut chars: Vec<char> = base.chars().collect();
                for code in lo..=hi {
                    map.insert(code, chars.iter().collect());
                    if let Some(last) = chars.last_mut() {
                        *last = char::from_u32(*last as u32 + 1).unwrap_or(*last);
                    }
                }
            } else if let Some(list) = c.get(5) {
                for (code, item) in (lo..=hi).zip(ITEM.captures_iter(list.as_str())) {
                    map.insert(code, hex_to_string(&item[1]));
                }
            }
        }
    }
    (width, map)
}

fn font_maps(doc: &Document, page: ObjectId) -> HashMap<Vec<u8>, FontMap> {
    let mut maps = HashMap::new();
    let Ok(fonts) = doc.get_page_fonts(page) else {
        return maps;
    };
    for (name, font) in fonts {
        let cid = font
            .get(b"Subtype")
            .and_then(Object::as_name)
            .is_ok_and(|s| s == b"Type0");
        let mut width = if cid { 2 } else { 1 };
        let mut map = HashMap::new();
        if let Ok(stream) = font
            .get(b"ToUnicode")
            .and_then(Object::as_reference)
            .and_then(|r| doc.get_object(r))
            .and_then(Object::as_stream)
        {
            let data = stream
                .decompressed_content()
                .unwrap_or_else(|_| stream.content.clone());
            let (w, m) = parse_cmap(&String::from_utf8_lossy(&data));
            width = w;
            map = m;
        }
        maps.insert(name, FontMap { width, map });
    }
    maps
}

fn bytes_of(o: &Object) -> Option<&[u8]> {
    if let Object::String(b, _) = o {
        Some(b)
    } else {
        None
    }
}

fn number(o: &Object) -> f32 {
    o.as_float()
        .ok()
        .or_else(|| o.as_i64().ok().map(|v| v as f32))
        .unwrap_or(0.0)
}

/// O texto de uma página, uma linha por linha do PDF; um recuo no começo da linha vira dois espaços.
pub fn page_text(doc: &Document, page: ObjectId) -> String {
    let fonts = font_maps(doc, page);
    let Ok(data) = doc.get_page_content(page) else {
        return String::new();
    };
    let Ok(content) = Content::decode(&data) else {
        return String::new();
    };
    let mut out = String::new();
    let mut font: Option<&FontMap> = None;
    let mut size = 10.0f32;
    let (mut x, mut y) = (0.0f32, 0.0f32);
    let mut line_y: Option<f32> = None;
    let mut left = f32::MAX;
    let mut line_x = 0.0f32;
    let mut lines: Vec<(f32, String)> = Vec::new();
    let mut current = String::new();
    let flush = |current: &mut String, lines: &mut Vec<(f32, String)>, start_x: f32| {
        if !current.trim().is_empty() {
            lines.push((start_x, std::mem::take(current)));
        }
        current.clear();
    };
    for op in &content.operations {
        let args = &op.operands;
        match op.operator.as_str() {
            "Tf" => {
                font = args
                    .first()
                    .and_then(|o| o.as_name().ok())
                    .and_then(|n| fonts.get(n));
                size = args.get(1).map(number).unwrap_or(size).abs().max(1.0);
            }
            "Td" | "TD" => {
                x += args.first().map(number).unwrap_or(0.0);
                y += args.get(1).map(number).unwrap_or(0.0);
            }
            "Tm" => {
                x = args.get(4).map(number).unwrap_or(0.0);
                y = args.get(5).map(number).unwrap_or(0.0);
            }
            "T*" => y -= size * 1.2,
            "BT" => {
                x = 0.0;
                y = 0.0;
            }
            "Tj" | "'" | "\"" | "TJ" => {
                // Uma linha nova quando a altura muda mais que meia letra.
                if line_y.is_none_or(|ly| (ly - y).abs() > size * 0.5) {
                    flush(&mut current, &mut lines, line_x);
                    line_y = Some(y);
                    line_x = x;
                    left = left.min(x);
                }
                let Some(f) = font else { continue };
                if op.operator == "TJ" {
                    for item in args
                        .first()
                        .and_then(|a| a.as_array().ok())
                        .into_iter()
                        .flatten()
                    {
                        if let Some(b) = bytes_of(item) {
                            current.push_str(&f.decode(b));
                        } else if number(item) < -250.0 && !current.ends_with(' ') {
                            // Um avanço grande entre pedaços é um espaço entre palavras.
                            current.push(' ');
                        }
                    }
                } else if let Some(b) = args.last().and_then(bytes_of) {
                    current.push_str(&f.decode(b));
                }
            }
            _ => {}
        }
    }
    flush(&mut current, &mut lines, line_x);
    for (start, text) in lines {
        if start > left + size * 0.8 {
            out.push_str("  ");
        }
        out.push_str(text.trim_end());
        out.push('\n');
    }
    out
}

pub fn pages_text(bytes: &[u8]) -> Vec<String> {
    let Ok(doc) = Document::load_mem(bytes) else {
        return Vec::new();
    };
    doc.get_pages()
        .values()
        .map(|id| page_text(&doc, *id))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_cmaps() {
        let cmap = "begincodespacerange <0000> <FFFF> endcodespacerange 2 beginbfchar <0003> <0020> <0024> <0041> endbfchar 1 beginbfrange <0044> <0046> <0061> endbfrange";
        let (w, m) = parse_cmap(cmap);
        assert_eq!(w, 2);
        let f = FontMap { width: w, map: m };
        assert_eq!(
            f.decode(&[0, 0x24, 0, 3, 0, 0x44, 0, 0x45, 0, 0x46]),
            "A abc"
        );
    }
}
