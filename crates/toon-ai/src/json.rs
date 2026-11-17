//! JSON como os modelos escrevem. Os escorregões de sempre: aspas das falas sem escape dentro das
//! strings, quebras de linha cruas, vírgulas faltando ou sobrando e o fim cortado. Quando nada disso
//! resolve, cada bloco que dá para ler é mantido.

use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;

pub fn parse_lenient(text: &str) -> Result<Value, serde_json::Error> {
    match serde_json::from_str(text) {
        Ok(v) => Ok(v),
        Err(err) => {
            let repaired = repair(text);
            if let Ok(v) = serde_json::from_str(&repaired) {
                return Ok(v);
            }
            let blocks = salvage_blocks(&repaired);
            if blocks.is_empty() { Err(err) } else { Ok(serde_json::json!({ "blocks": blocks })) }
        }
    }
}

static LITERAL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)").unwrap());
static CLOSES: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"^\s*(?:$|[:}\]]|,\s*(?:$|["{\[\]}\d-]|true|false|null)|"[^"\\\n]*"\s*:)"#).unwrap()
});

/// Reescreve `text` (a partir do primeiro colchete) em JSON válido onde a intenção é clara.
pub fn repair(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len() + 16);
    let mut stack: Vec<char> = Vec::new();
    let mut in_string = false;
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if in_string {
            match c {
                '\\' => match chars.get(i + 1) {
                    Some(&n) if "\"\\/bfnrtu".contains(n) => {
                        out.push(c);
                        out.push(n);
                        i += 1;
                    }
                    _ => out.push_str("\\\\"),
                },
                '"' => {
                    if closes_string(&chars, i + 1) {
                        in_string = false;
                        out.push('"');
                    } else {
                        out.push_str("\\\"");
                    }
                }
                '\n' => out.push_str("\\n"),
                '\r' => out.push_str("\\r"),
                '\t' => out.push_str("\\t"),
                c if c >= ' ' => out.push(c),
                _ => {}
            }
            i += 1;
            continue;
        }
        match c {
            '"' => {
                separate(&mut out);
                in_string = true;
                out.push(c);
            }
            '{' | '[' => {
                separate(&mut out);
                stack.push(c);
                out.push(c);
            }
            '}' | ']' => {
                let Some(open) = stack.pop() else { break };
                trim_trailing_comma(&mut out);
                out.push(if open == '{' { '}' } else { ']' });
                if stack.is_empty() {
                    return out;
                }
            }
            ',' | ':' => out.push(c),
            c if c.is_whitespace() => out.push(c),
            _ => {
                let window: String = chars[i..chars.len().min(i + 40)].iter().collect();
                if let Some(m) = LITERAL.find(&window) {
                    separate(&mut out);
                    out.push_str(m.as_str());
                    i += m.as_str().chars().count() - 1;
                }
            }
        }
        i += 1;
    }
    if in_string {
        out.push('"');
    }
    let trimmed = out.trim_end().trim_end_matches([',', ':']).len();
    out.truncate(trimmed);
    while let Some(open) = stack.pop() {
        out.push(if open == '{' { '}' } else { ']' });
    }
    out
}

fn trim_trailing_comma(out: &mut String) {
    let trimmed = out.trim_end();
    if trimmed.ends_with(',') {
        out.truncate(trimmed.len() - 1);
    }
}

/// Põe a vírgula que o modelo esqueceu entre dois valores.
fn separate(out: &mut String) {
    let trimmed = out.trim_end();
    if trimmed.ends_with(['"', '}', ']', 'e', 'l']) || trimmed.ends_with(|c: char| c.is_ascii_digit()) {
        out.truncate(trimmed.len());
        out.push(',');
    }
}

/// Uma aspa dentro da string só a fecha quando o que vem depois combina com o JSON em volta (dois
/// pontos, colchete fechando, vírgula antes da próxima chave ou valor). A aspa de uma fala vem com
/// mais texto depois.
fn closes_string(chars: &[char], from: usize) -> bool {
    let rest: String = chars[from.min(chars.len())..chars.len().min(from + 200)].iter().collect();
    CLOSES.is_match(&rest)
}

/// Todo objeto completo que tenha "translation", onde quer que esteja.
fn salvage_blocks(text: &str) -> Vec<Value> {
    let bytes = text.as_bytes();
    let mut found = Vec::new();
    let mut starts = Vec::new();
    let mut in_string = false;
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i];
        if in_string {
            if c == b'\\' {
                i += 1;
            } else if c == b'"' {
                in_string = false;
            }
        } else if c == b'"' {
            in_string = true;
        } else if c == b'{' {
            starts.push(i);
        } else if c == b'}' {
            if let Some(start) = starts.pop() {
                let chunk = &text[start..=i];
                if chunk.contains("\"translation\"") {
                    if let Ok(item @ Value::Object(_)) = serde_json::from_str::<Value>(chunk) {
                        if item.get("translation").is_some() {
                            found.push(item);
                        }
                    }
                }
            }
        }
        i += 1;
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unescaped_quotes_and_cut_end() {
        let raw = r#"{"blocks":[{"ids":[1],"original":"He said "run" now","translation":"Ele disse "corre""},{"ids":[2],"original":"A"#;
        let v = parse_lenient(raw).unwrap();
        assert_eq!(v["blocks"][0]["original"], "He said \"run\" now");
    }

    #[test]
    fn missing_comma() {
        let v = parse_lenient(r#"{"skip":[1 2] "blocks":[]}"#).unwrap();
        assert_eq!(v["skip"][1], 2);
    }
}
