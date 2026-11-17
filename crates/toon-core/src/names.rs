//! Nomes de obras e capítulos. Os capítulos chegam com o nome que o site ou a pessoa deu:
//! "[EN] [054] The Mythical Weapon Creation", "The Mythical Weapon Creation – Chapter 53",
//! ".../manga/the-mythical-weapon-creation/chapter-53/". Daqui sai o nome da obra e o número.

use std::sync::LazyLock;

use regex::Regex;
use unicode_normalization::UnicodeNormalization;
use unicode_normalization::char::is_combining_mark;

/// Nomes mais curtos que isso (normalizados) só batem por inteiro: "Solo" não pode pegar todo "Solo …".
const MIN_PREFIX: usize = 12;

static CHAPTER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(?:\b(?:chapter|chap|ch|cap(?:[ií]tulo)?|ep(?:is[oó]dio|isode)?)\.?\s*[-#:]?\s*|#)(\d+(?:[.,]\d+)?)").unwrap()
});
static VOLUME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\b(?:volume|vol)\.?\s*[-#:]?\s*(\d+(?:[.,]\d+)?)").unwrap());
static NOVEL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)novel|wuxia|ranobe|royalroad|scribblehub|comrademao|webnovel|mtlnation|novelupdates",
    )
    .unwrap()
});

#[derive(Debug, Clone, PartialEq)]
pub struct ChapterName {
    /// O nome da obra como veio, sem etiquetas, número do capítulo nem nome do site.
    pub work: String,
    pub chapter: Option<f64>,
}

fn number(text: &str) -> Option<f64> {
    text.replace(',', ".").parse().ok()
}

/// Separa o título de um capítulo (nome do arquivo, título da página) em obra e número; o link, quando
/// há, completa o que faltar.
pub fn parse_chapter_name(title: &str, url: Option<&str>) -> ChapterName {
    static EXT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\.(pdf|cbz|zip)$").unwrap());
    static BRACKET_NUMBER: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"[\[(]\s*(\d{1,4}(?:[.,]\d+)?)\s*[\])]").unwrap());
    static TAGS: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"\[[^\]]*\]|\([^)]*\)|@\S+").unwrap());
    static READ: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?i)^\s*(?:(?:read|ler|leia)\s+|(?:manga|manhwa|manhua|webtoon)\s*:\s*)")
            .unwrap()
    });
    static SPLIT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+[|–—-]\s+").unwrap());
    static TRAILING_VOLUME: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)\s*\b(?:volume|vol)\.?\s*\d+(?:[.,]\d+)?\s*$").unwrap());
    static TRAILING_PUNCT: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"[\s\-–—:|,.·•]+$").unwrap());
    static SPACES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").unwrap());

    let mut text = EXT.replace(title, "").into_owned();
    let mut chapter = None;
    // "[054]": número entre colchetes; as outras etiquetas ([EN], [@Grupo]) saem.
    if let Some(m) = BRACKET_NUMBER.captures(&text) {
        chapter = number(&m[1]);
        let whole = m.get(0).unwrap().range();
        text.replace_range(whole, " ");
    }
    text = TAGS.replace_all(&text, " ").into_owned();
    if let Some(found) = CHAPTER.captures(&text).or_else(|| VOLUME.captures(&text)) {
        if chapter.is_none() {
            chapter = number(&found[1]);
        }
        // O que vem depois do número é o título do capítulo ou o nome do site.
        text.truncate(found.get(0).unwrap().start());
    }
    text = READ.replace(&text, "").into_owned();

    // "Nome - Site" / "Nome | Site": a parte do site sai quando o resto ainda nomeia algo. Quando o
    // link mostra qual parte é o site ("MangaSite - Nome" em mangasite.com), sai essa.
    let mut parts: Vec<String> = SPLIT
        .split(&text)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    let site = url.map(site_name).unwrap_or_default();
    let named: Vec<String> = if site.is_empty() {
        parts.clone()
    } else {
        parts
            .iter()
            .filter(|p| !is_site(p, &site))
            .cloned()
            .collect()
    };
    if named.len() < parts.len() && !named.is_empty() {
        parts = named;
    } else if parts.len() > 1 {
        parts.pop();
    }
    let joined = parts.join(" - ");
    let mut work = TRAILING_VOLUME.replace(&joined, "").into_owned();
    work = TRAILING_PUNCT.replace(&work, "").trim().to_string();
    if let Some(url) = url {
        let from_url = parse_url(url);
        if chapter.is_none() {
            chapter = from_url.chapter;
        }
        if work.is_empty() && !from_url.work.is_empty() {
            work = from_url.work;
        }
    }
    ChapterName {
        work: SPACES.replace_all(&work, " ").into_owned(),
        chapter,
    }
}

/// "www.manga-site.com" → "mangasite".
fn site_name(url: &str) -> String {
    let Ok(u) = url::Url::parse(url) else {
        return String::new();
    };
    let host = u.host_str().unwrap_or("").trim_start_matches("www.");
    let labels: Vec<&str> = host.split('.').collect();
    let base = if labels.len() > 1 {
        labels[..labels.len() - 1].concat()
    } else {
        labels[0].to_string()
    };
    normalize_name(&base)
}

fn is_site(part: &str, site: &str) -> bool {
    let name = normalize_name(part);
    name.chars().count() >= 3 && (name.contains(site) || site.contains(&name))
}

/// O número do capítulo no caminho do link ("/chapter-53/").
pub fn chapter_in_url(url: &str) -> Option<f64> {
    parse_url(url).chapter
}

/// "/manga/the-mythical-weapon/chapter-53/" → "the mythical weapon", 53.
fn parse_url(url: &str) -> ChapterName {
    static LABEL: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)^(chapter|capitulo|cap|ch|episode|ep)$").unwrap());
    static NAMED: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)[a-z].*[-_].*[a-z]").unwrap());
    let empty = ChapterName {
        work: String::new(),
        chapter: None,
    };
    let Ok(u) = url::Url::parse(url) else {
        return empty;
    };
    let segments: Vec<String> = u
        .path_segments()
        .map(|s| s.filter(|x| !x.is_empty()).map(|x| x.to_string()).collect())
        .unwrap_or_default();
    // "chapter-53", ou "chapter/53" separado em dois.
    let label = |i: usize| -> String {
        let s = &segments[i];
        let next = segments.get(i + 1).map(String::as_str).unwrap_or("");
        let joined = if LABEL.is_match(s) && next.starts_with(|c: char| c.is_ascii_digit()) {
            format!("{s} {next}")
        } else {
            s.clone()
        };
        joined.replace(['-', '_'], " ")
    };
    let at = (0..segments.len()).find(|&j| CHAPTER.is_match(&label(j)));
    let chapter_seg = at.and_then(|i| CHAPTER.captures(&label(i)).map(|c| c[1].to_string()));
    // O segmento da obra vem antes do capítulo, às vezes com outros no meio ("/novels/nome/post/capitulo-5").
    let slug = match at {
        Some(i) if i > 0 => segments[..i]
            .iter()
            .rev()
            .find(|s| NAMED.is_match(s))
            .or(segments.get(i - 1)),
        Some(_) => None,
        None => segments.iter().find(|s| NAMED.is_match(s)),
    };
    let name = slug
        .map(|s| strip_site_id(s).replace(['-', '_'], " "))
        .unwrap_or_default();
    // "/capitulo/591535": um número desse tamanho é o id do site, não o número do capítulo.
    let chapter = chapter_seg
        .and_then(|c| number(&c))
        .filter(|&n| n < 10_000.0);
    ChapterName {
        work: name,
        chapter,
    }
}

/// "solo-leveling-7f873ca6": o id do site no fim do nome não faz parte dele.
fn strip_site_id(slug: &str) -> &str {
    if let Some(cut) = slug.rfind(['-', '_']) {
        let tail = &slug[cut + 1..];
        if tail.len() >= 4
            && tail.chars().all(|c| c.is_ascii_alphanumeric())
            && tail.chars().any(|c| c.is_ascii_digit())
        {
            return &slug[..cut];
        }
    }
    slug
}

/// Só letras e dígitos, minúsculos e sem acento: "Gênio Regressado!" → "genioregressado".
pub fn normalize_name(name: &str) -> String {
    name.nfd()
        .filter(|c| !is_combining_mark(*c))
        .flat_map(char::to_lowercase)
        .filter(|c| c.is_alphanumeric())
        .collect()
}

/// Mesmo nome, ou um cortado do outro (nomes de arquivo vêm truncados), a não ser que o resto do mais
/// longo seja um subtítulo: "Solo Leveling: Ragnarok" e "Tower of God 2" são outras obras.
pub fn same_name(a: &str, b: &str) -> bool {
    static SUBTITLE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?i)^\s*([:–—(]|-\s|\d|season\b|part\b|temporada\b|parte\b)").unwrap()
    });
    let x = normalize_name(a);
    let y = normalize_name(b);
    if x.is_empty() || y.is_empty() {
        return false;
    }
    if x == y {
        return true;
    }
    let (short, long, long_raw) = if x.chars().count() <= y.chars().count() {
        (x, y, b)
    } else {
        (y, x, a)
    };
    if short.chars().count() < MIN_PREFIX || !long.starts_with(&short) {
        return false;
    }
    !SUBTITLE.is_match(rest(long_raw, short.chars().count()))
}

/// O texto de `name` depois dos primeiros `count` caracteres normalizados.
fn rest(name: &str, count: usize) -> &str {
    let mut seen = 0;
    for (i, c) in name.char_indices() {
        if seen == count {
            return &name[i..];
        }
        seen += normalize_name(&c.to_string()).chars().count();
    }
    ""
}

/// Um nome sem o que o título da página pôs em volta: "[Manga]: Manga One Day, Suddenly, Seoul Is Read"
/// → "One Day, Suddenly, Seoul Is", "The Asterisk War, Vol. 8 Overview" → "The Asterisk War".
pub fn clean_work_name(name: &str) -> String {
    static TAGGED: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^(?:\[[^\]]*\]\s*)?:\s*").unwrap());
    static KIND: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)^(?:manga|manhwa|manhua|webtoon)\s+").unwrap());
    static READ: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)\s+read(?:\s+online)?$").unwrap());
    static OVERVIEW: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)[,\s]+(?:vol(?:ume)?\.?\s*\d+\s*)?overview$").unwrap());
    static TAIL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[,\s\-–—:|]+$").unwrap());
    let trimmed = name.trim();
    let tagged = TAGGED.is_match(trimmed);
    let mut clean = TAGGED.replace(trimmed, "").into_owned();
    if tagged {
        clean = KIND.replace(&clean, "").into_owned();
        clean = READ.replace(&clean, "").into_owned();
    }
    clean = OVERVIEW.replace(&clean, "").into_owned();
    clean = TAIL.replace(&clean, "").trim().to_string();
    if clean.is_empty() {
        trimmed.to_string()
    } else {
        clean
    }
}

/// "The mythical weapon creation" → "The Mythical Weapon Creation" (nomes tirados de links vêm minúsculos).
pub fn display_name(name: &str) -> String {
    let name = clean_work_name(name);
    if name != name.to_lowercase() {
        return name;
    }
    let mut out = String::with_capacity(name.len());
    let mut start = true;
    for c in name.chars() {
        if start && c.is_alphabetic() {
            out.extend(c.to_uppercase());
        } else {
            out.push(c);
        }
        start = c.is_whitespace();
    }
    out
}

/// A página de uma obra como as outras cópias dela a têm: MangaDex pelo id, o resto pelo endereço.
pub fn source_key(url: &str) -> String {
    static DEX: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)mangadex\.org/title/([0-9a-f-]{36})").unwrap());
    if let Some(m) = DEX.captures(url) {
        return format!("mangadex:{}", m[1].to_lowercase());
    }
    match url::Url::parse(url) {
        Ok(u) => format!(
            "{}{}",
            u.host_str().unwrap_or("").trim_start_matches("www."),
            u.path().trim_end_matches('/')
        ),
        Err(_) => url.to_string(),
    }
}

/// Se o link é de uma web novel (os capítulos são texto, não o mangá de mesmo nome).
pub fn is_novel_url(url: &str) -> bool {
    url::Url::parse(url)
        .is_ok_and(|u| NOVEL.is_match(u.host_str().unwrap_or("")) || NOVEL.is_match(u.path()))
}

/// "Asterisk War - Volume 08": numerado por volume, sem número de capítulo.
pub fn is_volume_name(name: &str) -> bool {
    VOLUME.is_match(name) && !CHAPTER.is_match(name)
}

/// "The Mythical Weapon Creation o": nome de arquivo cortado no meio de uma palavra.
pub fn cut_short(name: &str) -> bool {
    let mut chars = name.trim().chars().rev();
    matches!((chars.next(), chars.next()), (Some(last), Some(before)) if last.is_lowercase() && before.is_whitespace())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chapter_names() {
        let p = parse_chapter_name("[EN] [054] The Mythical Weapon Creation.pdf", None);
        assert_eq!(
            p,
            ChapterName {
                work: "The Mythical Weapon Creation".into(),
                chapter: Some(54.0)
            }
        );
        let p = parse_chapter_name(
            "The Genius Midfielder With the Killer Pass Chapter 79",
            None,
        );
        assert_eq!(p.work, "The Genius Midfielder With the Killer Pass");
        assert_eq!(p.chapter, Some(79.0));
        let p = parse_chapter_name(
            "Blue Lock Manga Chapter 346 Read online - MangaKakalot",
            None,
        );
        assert_eq!(p.chapter, Some(346.0));
        let p = parse_chapter_name(
            "",
            Some("https://mgread.io/manga/solo-spell-caster/chapter-149/"),
        );
        assert_eq!(
            p,
            ChapterName {
                work: "solo spell caster".into(),
                chapter: Some(149.0)
            }
        );
        let p = parse_chapter_name("x", Some("https://mediocrescan.com/capitulo/591546"));
        assert_eq!(p.chapter, None);
    }

    #[test]
    fn names() {
        assert_eq!(normalize_name("Gênio Regressado!"), "genioregressado");
        assert!(same_name(
            "The Mythical Weapon Creation",
            "The Mythical Weapon Creation of the Regressed"
        ));
        assert!(!same_name(
            "Solo Leveling Ragnarok Story",
            "Solo Leveling Ragnarok Story: Part 2"
        ));
        assert!(!same_name("Solo", "Solo Leveling"));
        assert_eq!(
            clean_work_name("[Manga]: Manga One Day, Suddenly, Seoul Is Read"),
            "One Day, Suddenly, Seoul Is"
        );
        assert_eq!(
            clean_work_name("The Asterisk War, Vol. 8 Overview"),
            "The Asterisk War"
        );
        assert_eq!(display_name("the mythical weapon"), "The Mythical Weapon");
        assert_eq!(strip_site_id("solo-leveling-7f873ca6"), "solo-leveling");
        assert!(cut_short("The Mythical Weapon Creation o"));
        assert_eq!(
            source_key("https://mangadex.org/title/4141C5DC-c525-4df5-afd7-cc7d192a832f/blue-lock"),
            "mangadex:4141c5dc-c525-4df5-afd7-cc7d192a832f"
        );
    }
}
