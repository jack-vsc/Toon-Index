//! O que os sites sabem de uma obra: os outros nomes, as páginas dela, a capa, a sinopse, os gêneros,
//! a situação e o ano. Também o vínculo automático das obras ainda não procuradas e as capas que faltam.

use std::sync::LazyLock;
use std::time::Duration;

use regex::Regex;
use serde::Deserialize;
use serde_json::Value;
use toon_core::library::{self, CatalogFound};
use toon_core::names::{chapter_in_url, normalize_name, same_name};
use toon_core::reading;
use toon_core::settings;
use toon_core::works::{Format, Work, WorkInfo};

use crate::browser::Tab;
use crate::catalog::{self, Match, Site, is_likely_same_work};

const MANGADEX: &str = "https://api.mangadex.org";
const COVER_WIDTH: u32 = 400;
/// Obras procuradas por rodada e quantos nomes de cada uma.
const AUTO_PER_RUN: usize = 5;
const AUTO_SEARCHES: usize = 3;
const COVERS_PER_RUN: usize = 20;
/// Uma obra procurada sem resultado só é procurada de novo depois de uma semana.
const AUTO_RETRY_MS: i64 = 7 * 24 * 60 * 60_000;

static HTTP: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(60))
        .build()
        .expect("cliente HTTP")
});

fn now() -> i64 {
    toon_core::now_ms()
}

/// Nomes em letras latinas, de tamanho razoável: os que os sites usam para procurar.
pub fn readable_names(names: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for n in names.iter().map(|n| n.trim()) {
        let latin = n
            .chars()
            .any(|c| c.is_ascii_alphabetic() || ('\u{00C0}'..='\u{024F}').contains(&c));
        let foreign = n.chars().any(|c| {
            c.is_alphabetic()
                && !(c.is_ascii_alphabetic() || ('\u{00C0}'..='\u{024F}').contains(&c))
        });
        if n.chars().count() > 1
            && n.chars().count() <= 150
            && latin
            && !foreign
            && !out.iter().any(|o| normalize_name(o) == normalize_name(n))
        {
            out.push(n.to_string());
        }
    }
    out
}

/// O link de um capítulo vira a página da obra no mesmo site: "/manga/nome/chapter-53/" → "/manga/nome/".
pub fn source_from_chapter(url: &str) -> Option<String> {
    static NAMED: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)[a-z].*[-_].*[a-z]").unwrap());
    static LABEL: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)^(chapter|capitulo|cap|ch)$").unwrap());
    let u = url::Url::parse(url).ok()?;
    let origin = u.origin().ascii_serialization();
    let segments: Vec<&str> = u.path_segments()?.filter(|s| !s.is_empty()).collect();
    let at = segments
        .iter()
        .position(|s| chapter_in_url(&format!("{origin}/{s}/")).is_some() || LABEL.is_match(s))?;
    let name = segments[..at].iter().rposition(|s| NAMED.is_match(s))?;
    Some(format!("{origin}/{}/", segments[..=name].join("/")))
}

/// A capa como JPEG pequeno, buscada como as próprias páginas buscam (WebP e AVIF incluídos no WebP).
pub async fn download_cover(url: &str) -> Option<Vec<u8>> {
    let host = url::Url::parse(url).ok()?.host_str()?.to_string();
    let mut req = HTTP.get(url).header(
        "Referer",
        format!(
            "{}/",
            url::Url::parse(url).ok()?.origin().ascii_serialization()
        ),
    );
    // As capas do MangaDex, como a API, recusam navegadores.
    if host.ends_with("mangadex.org") {
        req = req.header("User-Agent", "ToonIndex/1.0");
    } else {
        req = req.header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36");
    }
    let bytes = req
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?
        .bytes()
        .await
        .ok()?;
    let image = image::load_from_memory(&bytes).ok()?;
    let image = if image.width() > COVER_WIDTH {
        image.resize(COVER_WIDTH, u32::MAX, image::imageops::FilterType::Triangle)
    } else {
        image
    };
    let mut out = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 85)
        .encode_image(&image.to_rgb8())
        .ok()?;
    Some(out)
}

/// Junta à obra os resultados escolhidos (do PC ou do celular): nomes, páginas e a primeira capa.
pub async fn link_work(work_id: &str, matches: &[Match]) -> anyhow::Result<Vec<Work>> {
    let mut names = Vec::new();
    for m in matches {
        names.push(m.title.clone());
        names.extend(m.alt_names.clone());
    }
    let mut cover = None;
    for m in matches {
        if let Some(c) = &m.cover {
            cover = download_cover(c).await;
            if cover.is_some() {
                break;
            }
        }
    }
    library::apply_catalog(
        work_id,
        CatalogFound {
            title: None,
            names: readable_names(&names),
            sources: matches.iter().map(|m| m.url.clone()).collect(),
            sites: matches
                .iter()
                .filter(|m| m.site != Site::Link)
                .map(|m| site_key(m.site))
                .collect(),
            cover,
            info: None,
        },
    )
}

fn site_key(site: Site) -> String {
    serde_json::to_value(site)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_default()
}

fn mangadex_id(url: &str) -> Option<String> {
    static ID: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)mangadex\.org/title/([0-9a-f-]{36})").unwrap());
    ID.captures(url).map(|c| c[1].to_lowercase())
}

/// As línguas em que o MangaDex escreve o nome da obra, para o idioma em que os capítulos são traduzidos.
fn title_languages(target: &str) -> &'static [&'static str] {
    match target {
        "Brazilian Portuguese" => &["pt-br", "pt"],
        "European Portuguese" => &["pt", "pt-br"],
        "English" => &["en"],
        "Spanish" => &["es-la", "es"],
        "French" => &["fr"],
        "Italian" => &["it"],
        "German" => &["de"],
        "Russian" => &["ru"],
        "Indonesian" => &["id"],
        "Thai" => &["th"],
        "Vietnamese" => &["vi"],
        "Arabic" => &["ar"],
        _ => &[],
    }
}

fn tag_pt(tag: &str) -> String {
    let pt = match tag {
        "Action" => "Ação",
        "Adventure" => "Aventura",
        "Comedy" => "Comédia",
        "Fantasy" => "Fantasia",
        "Horror" => "Terror",
        "Mystery" => "Mistério",
        "Sci-Fi" => "Ficção científica",
        "Slice of Life" => "Cotidiano",
        "Sports" => "Esportes",
        "Thriller" => "Suspense",
        "Tragedy" => "Tragédia",
        "Psychological" => "Psicológico",
        "Historical" => "Histórico",
        "Martial Arts" => "Artes marciais",
        "Magic" => "Magia",
        "Time Travel" => "Viagem no tempo",
        "Reincarnation" => "Reencarnação",
        "Monsters" => "Monstros",
        "Demons" => "Demônios",
        "Supernatural" => "Sobrenatural",
        "School Life" => "Vida escolar",
        "Video Games" => "Videogames",
        "Survival" => "Sobrevivência",
        "Long Strip" => "Webtoon",
        "Full Color" => "Colorido",
        "Web Comic" => "Web comic",
        "Adaptation" => "Adaptação",
        "Military" => "Militar",
        "Villainess" => "Vilã",
        other => other,
    };
    pt.to_string()
}

/// As descrições do MangaDex vêm em Markdown: links viram texto e as notas depois de uma linha saem.
fn clean_synopsis(text: &str) -> String {
    static CUT: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?i)\n\s*(?:---+|\*\*\*+|___+)\s*\n|\n\s*\**(?:links?|official|raw)\**\s*:")
            .unwrap()
    });
    static LINK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\[([^\]]*)\]\([^)]*\)").unwrap());
    static EMPHASIS: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"[*_]{1,2}([^*_]+)[*_]{1,2}").unwrap());
    static BLANK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\n{3,}").unwrap());
    let first = CUT.split(text).next().unwrap_or("");
    let t = LINK.replace_all(first, "$1");
    let t = EMPHASIS.replace_all(&t, "$1");
    BLANK.replace_all(&t, "\n\n").trim().to_string()
}

struct Details {
    title: Option<String>,
    in_language: bool,
    names: Vec<String>,
    cover: Option<Vec<u8>>,
    info: WorkInfo,
}

async fn mangadex_details(id: &str) -> anyhow::Result<Details> {
    let data: Value = HTTP
        .get(format!("{MANGADEX}/manga/{id}?includes[]=cover_art"))
        .header("User-Agent", "ToonIndex/1.0")
        .send()
        .await?
        .json()
        .await?;
    let a = &data["data"]["attributes"];
    let alts: Vec<&serde_json::Map<String, Value>> = a["altTitles"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_object)
        .collect();
    let alt = |lang: &str| -> Option<String> {
        a["title"][lang].as_str().map(str::to_string).or_else(|| {
            alts.iter()
                .find_map(|m| m.get(lang).and_then(Value::as_str).map(str::to_string))
        })
    };
    let langs = title_languages(&settings::load().target_language);
    let in_language = langs.iter().find_map(|l| alt(l));
    let file = data["data"]["relationships"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|r| r["type"] == "cover_art")
        .and_then(|r| r["attributes"]["fileName"].as_str());
    let cover = match file {
        Some(f) => {
            download_cover(&format!(
                "https://uploads.mangadex.org/covers/{id}/{f}.512.jpg"
            ))
            .await
        }
        None => None,
    };
    let description = a["description"]["pt-br"]
        .as_str()
        .filter(|s| !s.is_empty())
        .or(a["description"]["en"].as_str())
        .unwrap_or("");
    let synopsis = clean_synopsis(description);
    let tags: Vec<String> = a["tags"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|t| t["attributes"]["group"] != "content")
        .filter_map(|t| t["attributes"]["name"]["en"].as_str().map(tag_pt))
        .collect();
    let status = a["status"].as_str().map(|s| {
        match s {
            "ongoing" => "Em andamento",
            "completed" => "Completo",
            "hiatus" => "Em hiato",
            "cancelled" => "Cancelado",
            other => other,
        }
        .to_string()
    });
    let mut names: Vec<String> = a["title"]
        .as_object()
        .map(|o| {
            o.values()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    names.extend(
        alts.iter()
            .flat_map(|m| m.values().filter_map(|v| v.as_str().map(str::to_string))),
    );
    Ok(Details {
        title: in_language.clone().or_else(|| alt("en")),
        in_language: in_language.is_some(),
        names,
        cover,
        info: WorkInfo {
            synopsis: (!synopsis.is_empty()).then_some(synopsis),
            tags: (!tags.is_empty()).then_some(tags),
            status,
            year: a["year"].as_i64().map(|y| y as i32),
            from: format!("https://mangadex.org/title/{id}"),
            updated_at: now(),
        },
    })
}

#[derive(Deserialize)]
struct PageFound {
    title: String,
    synopsis: String,
    tags: Vec<String>,
}

/// Roda na página da obra: o nome (sem o do site), a maior sinopse e os links de gênero.
const PAGE_DETAILS: &str = r#"(() => {
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim()
  const meta = (s) => norm(document.querySelector(s)?.content)
  const site = location.hostname.replace(/^www\./, '').split('.')[0].replace(/[^a-z0-9]/gi, '').toLowerCase()
  const own = meta('meta[property="og:site_name"]').replace(/[^a-z0-9]/gi, '').toLowerCase()
  const isSite = (s) => {
    const key = s.replace(/[^a-z0-9]/gi, '').toLowerCase()
    return key === site || key === own || (!/\s/.test(s) && key.length >= 6 && site.length >= 6 && key.slice(0, 6) === site.slice(0, 6))
  }
  const title = [meta('meta[property="og:title"]'), document.querySelector('h1')?.innerText, document.title]
    .map((s) => norm((s || '').split(/\s+[|–—-]\s+/)[0]))
    .find((s) => s && !isSite(s)) || ''
  const blocks = [...document.querySelectorAll('[class*="summary" i], [class*="synopsis" i], [class*="sinopse" i], [class*="description" i], [id*="summary" i], [id*="synopsis" i], [itemprop="description"]')]
    .map((el) => (el.innerText || '').trim())
    .filter((t) => t.length > 40 && t.length < 4000)
  const synopsis = [meta('meta[property="og:description"]'), meta('meta[name="description"]'), ...blocks].sort((a, b) => b.length - a.length)[0] || ''
  const tags = [...new Set([...document.querySelectorAll('a[href*="genre" i], a[href*="genero" i], a[href*="/tag/" i], a[href*="/tags/" i]')]
    .map((a) => norm(a.innerText))
    .filter((t) => t && t.length < 25))].slice(0, 12)
  return { title, synopsis, tags }
})()"#;

const OG_IMAGE: &str = r#"(() => { const m = document.querySelector('meta[property="og:image"], meta[name="og:image"], meta[name="twitter:image"], meta[property="twitter:image"]'); return m ? new URL(m.content, location.href).href : '' })()"#;

/// A imagem que a primeira página que tiver uma mostra ao ser compartilhada: a capa nos sites de scan.
/// O logo do site não é capa: capas são mais altas que largas.
async fn page_cover(tab: &mut Tab, pages: &[String]) -> Option<Vec<u8>> {
    for page in pages {
        if tab.open(page).await.is_err() || tab.pass_challenge(|| ()).await.is_err() {
            continue;
        }
        let image: String = tab.eval(OG_IMAGE).await.unwrap_or_default();
        if image.is_empty() {
            continue;
        }
        if let Some(jpeg) = download_cover(&image).await {
            if image::load_from_memory(&jpeg).is_ok_and(|i| i.height() > i.width()) {
                return Some(jpeg);
            }
        }
    }
    None
}

async fn page_details(pages: &[String]) -> Option<(Vec<String>, Option<Vec<u8>>, WorkInfo)> {
    let mut tab = Tab::new().await.ok()?;
    for page in pages {
        if tab.open(page).await.is_err() || tab.pass_challenge(|| ()).await.is_err() {
            continue;
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
        let Ok(found) = tab.eval::<PageFound>(PAGE_DETAILS).await else {
            continue;
        };
        let cover = page_cover(&mut tab, std::slice::from_ref(page)).await;
        if found.synopsis.is_empty() && found.tags.is_empty() && cover.is_none() {
            continue;
        }
        let info = WorkInfo {
            synopsis: (!found.synopsis.is_empty()).then_some(found.synopsis),
            tags: (!found.tags.is_empty()).then_some(found.tags),
            status: None,
            year: None,
            from: page.clone(),
            updated_at: now(),
        };
        return Some((
            (!found.title.is_empty())
                .then_some(found.title)
                .into_iter()
                .collect(),
            cover,
            info,
        ));
    }
    None
}

/// As páginas da obra nos sites: as dela, depois as de onde os capítulos foram lidos ou salvos.
fn work_pages(work: &Work) -> Vec<String> {
    let mut read: Vec<reading::Record> = reading::list()
        .into_iter()
        .filter(|r| r.work_id == work.id && !r.url.is_empty())
        .collect();
    read.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    let mut saved: Vec<library::Entry> = library::list_library()
        .into_iter()
        .filter(|e| e.work_id == work.id && e.source.is_some())
        .collect();
    saved.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    let mut pages: Vec<String> = work.sources().to_vec();
    let chapters = read
        .into_iter()
        .map(|r| r.url)
        .chain(saved.into_iter().filter_map(|e| e.source));
    for u in chapters {
        let page = if mangadex_id(&u).is_some() {
            Some(u)
        } else {
            source_from_chapter(&u)
        };
        if let Some(p) = page.filter(|p| !pages.contains(p)) {
            pages.push(p);
        }
    }
    pages
}

async fn find_mangadex_id(work: &Work) -> Option<String> {
    if work.format() != Format::Comic {
        return None;
    }
    for name in readable_names(&work.names).into_iter().take(AUTO_SEARCHES) {
        let results = catalog::search_mangadex(&name).await.unwrap_or_default();
        if let Some(m) = results.iter().find(|m| is_likely_same_work(&work.names, m)) {
            return mangadex_id(&m.url);
        }
    }
    None
}

/// "Atualizar dados": capa, nome mostrado, sinopse, gêneros, situação e ano pelo MangaDex; o que ele
/// não tiver (ou tudo, para obras que ele não tem), pela página da obra no site dos capítulos.
pub async fn refresh_work(work_id: &str) -> anyhow::Result<Vec<Work>> {
    let work = library::list_works()
        .into_iter()
        .find(|w| w.id == work_id)
        .ok_or_else(|| anyhow::anyhow!("Obra não encontrada."))?;
    let dex = match work.sources().iter().find_map(|s| mangadex_id(s)) {
        Some(id) => Some(id),
        None => find_mangadex_id(&work).await,
    };
    let details = match &dex {
        Some(id) => mangadex_details(id).await.ok(),
        None => None,
    };
    let pages: Vec<String> = work_pages(&work)
        .into_iter()
        .filter(|p| mangadex_id(p).is_none())
        .take(2)
        .collect();
    let lacking = details
        .as_ref()
        .is_none_or(|d| d.cover.is_none() || d.info.synopsis.is_none() || d.info.tags.is_none());
    let page = if lacking && !pages.is_empty() {
        page_details(&pages).await
    } else {
        None
    };
    if details.is_none() && page.is_none() {
        anyhow::bail!(
            "Não achei a obra no MangaDex nem uma página dela num site: adicione o site dela em \"Editar obra\" e tente de novo."
        );
    }
    let page_info = page.as_ref().map(|p| p.2.clone());
    let info = WorkInfo {
        synopsis: details
            .as_ref()
            .and_then(|d| d.info.synopsis.clone())
            .or(page_info.as_ref().and_then(|p| p.synopsis.clone())),
        tags: details
            .as_ref()
            .and_then(|d| d.info.tags.clone())
            .or(page_info.as_ref().and_then(|p| p.tags.clone())),
        status: details.as_ref().and_then(|d| d.info.status.clone()),
        year: details.as_ref().and_then(|d| d.info.year),
        from: details
            .as_ref()
            .map(|d| d.info.from.clone())
            .or(page_info.map(|p| p.from))
            .unwrap_or_default(),
        updated_at: now(),
    };
    let target = settings::load().target_language;
    // O nome mostrado: o do idioma da tradução; o inglês só traduzindo para inglês ou no lugar do mesmo nome escrito de outro jeito.
    let title = details.as_ref().and_then(|d| {
        d.title
            .clone()
            .filter(|t| d.in_language || target == "English" || same_name(work.name(), t))
    });
    let mut names = details
        .as_ref()
        .map(|d| d.names.clone())
        .unwrap_or_default();
    names.extend(page.as_ref().map(|p| p.0.clone()).unwrap_or_default());
    let has_dex_page = dex.as_ref().is_some_and(|id| {
        work.sources()
            .iter()
            .any(|s| mangadex_id(s).as_deref() == Some(id))
    });
    library::apply_catalog(
        work_id,
        CatalogFound {
            title,
            names: readable_names(&names),
            sources: dex
                .iter()
                .filter(|_| !has_dex_page)
                .map(|id| format!("https://mangadex.org/title/{id}"))
                .collect(),
            sites: dex.iter().map(|_| "mangadex".to_string()).collect(),
            cover: details.and_then(|d| d.cover).or(page.and_then(|p| p.1)),
            info: Some(info),
        },
    )
}

/// A obra em cada site, pelos nomes dela. Os sites costumam listar por outro nome em inglês, então os
/// nomes que um site dá são procurados nos sites que ainda não acharam.
async fn find_same_work(work: &Work) -> (Vec<Match>, bool) {
    let mut picks: Vec<Match> = Vec::new();
    let mut names = readable_names(&work.names);
    let mut searched: Vec<String> = Vec::new();
    let mut failed = false;
    for _ in 0..AUTO_SEARCHES {
        let missing: Vec<Site> = Site::CATALOG
            .into_iter()
            .filter(|s| !picks.iter().any(|p| p.site == *s))
            .collect();
        let Some(query) = names
            .iter()
            .find(|n| !searched.contains(&normalize_name(n)))
            .cloned()
        else {
            break;
        };
        if missing.is_empty() {
            break;
        }
        searched.push(normalize_name(&query));
        for result in catalog::search_sites(&query, &missing).await {
            failed |= result.error.is_some();
            let exact = |m: &&Match| {
                std::iter::once(&m.title)
                    .chain(&m.alt_names)
                    .any(|n| names.iter().any(|k| normalize_name(k) == normalize_name(n)))
            };
            if let Some(m) = result.matches.iter().find(exact).cloned() {
                names.extend(readable_names(
                    &std::iter::once(m.title.clone())
                        .chain(m.alt_names.clone())
                        .collect::<Vec<_>>(),
                ));
                picks.push(m);
            }
        }
    }
    (picks, failed)
}

/// Obras ainda não procuradas: cada uma é procurada pelo nome, e os resultados com um dos nomes dela
/// exatamente são vinculados. O que for menos certo fica para a pessoa ("Buscar obra").
pub async fn auto_link() {
    let due: Vec<Work> = library::list_works()
        .into_iter()
        .filter(|w| w.format() == Format::Comic)
        .filter(|w| {
            w.catalog
                .as_ref()
                .is_none_or(|c| c.sites.is_empty() && now() - c.checked_at > AUTO_RETRY_MS)
        })
        .take(AUTO_PER_RUN)
        .collect();
    for work in due {
        let (picks, failed) = find_same_work(&work).await;
        // Um site que falhou (verificação, por exemplo) é tentado de novo na próxima vez.
        if picks.is_empty() && failed {
            continue;
        }
        let _ = link_work(&work.id, &picks).await;
        tokio::time::sleep(Duration::from_secs(3)).await;
    }
}

/// Obras ainda sem capa ganham uma: a do MangaDex quando o resultado tem o nome dela, senão a imagem de
/// compartilhamento da página dela num site em que é lida.
pub async fn auto_covers(
    tried: &parking_lot::Mutex<std::collections::HashMap<String, i64>>,
) -> usize {
    let records = reading::list();
    let due: Vec<Work> = library::list_works()
        .into_iter()
        .filter(|w| {
            library::work_cover(&w.id).is_none()
                && now() - tried.lock().get(&w.id).copied().unwrap_or(0) > AUTO_RETRY_MS
        })
        .take(COVERS_PER_RUN)
        .collect();
    let mut found = 0;
    for work in due {
        tried.lock().insert(work.id.clone(), now());
        let mut cover = None;
        if work.format() == Format::Comic {
            for name in readable_names(&work.names).into_iter().take(AUTO_SEARCHES) {
                let results = catalog::search_mangadex(&name).await.unwrap_or_default();
                if let Some(c) = results
                    .iter()
                    .find(|m| m.cover.is_some() && is_likely_same_work(&work.names, m))
                    .and_then(|m| m.cover.clone())
                {
                    cover = download_cover(&c).await;
                    if cover.is_some() {
                        break;
                    }
                }
            }
        }
        if cover.is_none() {
            let mut read: Vec<&reading::Record> = records
                .iter()
                .filter(|r| r.work_id == work.id && !r.url.is_empty())
                .collect();
            read.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
            let mut pages = work.sources().to_vec();
            pages.extend(read.iter().filter_map(|r| source_from_chapter(&r.url)));
            pages.dedup();
            if let Ok(mut tab) = Tab::new().await {
                cover = page_cover(&mut tab, &pages[..pages.len().min(2)]).await;
            }
        }
        if let Some(jpeg) = cover {
            if library::save_work_cover(&work.id, &jpeg).is_ok() {
                found += 1;
            }
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chapter_link_to_work_page() {
        assert_eq!(
            source_from_chapter("https://site.com/manga/solo-leveling/chapter-53/").as_deref(),
            Some("https://site.com/manga/solo-leveling/")
        );
        assert_eq!(
            readable_names(&[
                "나 혼자".into(),
                "Solo Leveling".into(),
                "Só Leveling".into()
            ]),
            ["Solo Leveling", "Só Leveling"]
        );
    }
}
