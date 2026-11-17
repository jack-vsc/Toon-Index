//! Os sites de catálogo: procurar uma obra pelo nome e listar os capítulos dela. O MangaDex vai pela
//! API; mgeko, MangaKakalot e MangaLivre, pelas páginas no navegador do app.

use std::collections::BTreeMap;
use std::sync::LazyLock;
use std::time::Duration;

use anyhow::bail;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use toon_core::names::{chapter_in_url, normalize_name, same_name};

use crate::browser::Tab;
use crate::logins::sign_in_if_asked;

const MANGADEX: &str = "https://api.mangadex.org";
const AGENT: &str = "ToonIndex/1.0";
const RATINGS: &str = "contentRating[]=safe&contentRating[]=suggestive&contentRating[]=erotica";
const MANGADEX_PAGE: usize = 500;
const MANGADEX_MAX_CHAPTERS: usize = 5000;
const SETTLE: Duration = Duration::from_millis(1500);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Site {
    Mangadex,
    Mgeko,
    Mangakakalot,
    Mangalivre,
    Link,
}

impl Site {
    pub const CATALOG: [Site; 4] = [
        Site::Mangadex,
        Site::Mgeko,
        Site::Mangakakalot,
        Site::Mangalivre,
    ];

    pub fn label(self) -> &'static str {
        match self {
            Site::Mangadex => "MangaDex",
            Site::Mgeko => "mgeko",
            Site::Mangakakalot => "MangaKakalot",
            Site::Mangalivre => "MangaLivre (português)",
            Site::Link => "Link",
        }
    }

    /// O site de um link de obra colado.
    pub fn of_url(url: &str) -> Site {
        let host = url::Url::parse(url)
            .ok()
            .and_then(|u| {
                u.host_str()
                    .map(|h| h.trim_start_matches("www.").to_string())
            })
            .unwrap_or_default();
        match host.as_str() {
            "mangadex.org" => Site::Mangadex,
            "mgeko.cc" => Site::Mgeko,
            "mangakakalot.fan" | "mangakakalot.gg" => Site::Mangakakalot,
            "mangalivre.blog" => Site::Mangalivre,
            _ => Site::Link,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Match {
    pub site: Site,
    pub title: String,
    /// A página da obra lá, a que lista os capítulos.
    pub url: String,
    pub cover: Option<String>,
    #[serde(default)]
    pub alt_names: Vec<String>,
    pub latest: Option<f64>,
    /// Os nomes em português, quando o site diz (MangaDex): como os sites brasileiros chamam a obra.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub pt_names: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SiteResult {
    pub site: Site,
    pub matches: Vec<Match>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ChapterLink {
    pub chapter: f64,
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub date: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ChapterList {
    pub title: Option<String>,
    pub chapters: Vec<ChapterLink>,
    /// "pt-BR" quando o site já está em português: baixado, não traduzido.
    pub language: Option<String>,
}

static HTTP: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(60))
        .user_agent(AGENT)
        .build()
        .expect("cliente HTTP")
});

async fn get_json(url: &str) -> anyhow::Result<Value> {
    let r = HTTP.get(url).send().await?;
    if !r.status().is_success() {
        bail!("O site respondeu {}.", r.status().as_u16());
    }
    Ok(r.json().await?)
}

/// Um resultado cujo nome (ou outro nome) bate com um dos nomes da obra.
pub fn is_likely_same_work(names: &[String], m: &Match) -> bool {
    let theirs: Vec<&String> = std::iter::once(&m.title).chain(&m.alt_names).collect();
    names.iter().any(|k| {
        theirs.iter().any(|n| {
            let (a, b) = (normalize_name(k), normalize_name(n));
            same_name(k, n) || (a.chars().count() >= 6 && dice(&a, &b) >= 0.85)
        })
    })
}

fn dice(a: &str, b: &str) -> f64 {
    let pairs = |s: &str| {
        let c: Vec<char> = s.chars().collect();
        let mut m: BTreeMap<(char, char), i32> = BTreeMap::new();
        for w in c.windows(2) {
            *m.entry((w[0], w[1])).or_default() += 1;
        }
        m
    };
    let (pa, pb) = (pairs(a), pairs(b));
    let common: i32 = pa
        .iter()
        .map(|(k, n)| *n.min(pb.get(k).unwrap_or(&0)))
        .sum();
    let total = (a.chars().count() + b.chars().count())
        .saturating_sub(2)
        .max(1);
    2.0 * common as f64 / total as f64
}

fn first_number(text: &str) -> Option<f64> {
    static N: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\d+(?:\.\d+)?").unwrap());
    N.find(text).and_then(|m| m.as_str().parse().ok())
}

/// Procura nos quatro sites ao mesmo tempo. Um site português sem resultado parecido é procurado de
/// novo pelos nomes em português que o MangaDex der.
pub async fn search(query: &str) -> Vec<SiteResult> {
    let dex = attempt(Site::Mangadex, search_mangadex(query)).await;
    let pt_names: Vec<String> = dex
        .matches
        .iter()
        .take(1)
        .flat_map(|m| m.pt_names.clone())
        .collect();
    let mut results = vec![dex];
    for site in [Site::Mgeko, Site::Mangakakalot, Site::Mangalivre] {
        let mut result = attempt(site, search_site(site, query)).await;
        let names = vec![query.to_string()];
        if site == Site::Mangalivre
            && !result
                .matches
                .iter()
                .any(|m| is_likely_same_work(&names, m))
        {
            for name in &pt_names {
                let again = attempt(site, search_site(site, name)).await;
                if !again.matches.is_empty() {
                    result = again;
                    break;
                }
            }
        }
        results.push(result);
    }
    results
}

/// Procura só nos sites pedidos (os que ainda não acharam a obra).
pub async fn search_sites(query: &str, sites: &[Site]) -> Vec<SiteResult> {
    let mut results = Vec::new();
    for &site in sites {
        results.push(match site {
            Site::Mangadex => attempt(site, search_mangadex(query)).await,
            Site::Link => continue,
            other => attempt(other, search_site(other, query)).await,
        });
    }
    results
}

async fn attempt(
    site: Site,
    search: impl Future<Output = anyhow::Result<Vec<Match>>>,
) -> SiteResult {
    match search.await {
        Ok(matches) => SiteResult {
            site,
            matches,
            error: None,
        },
        Err(err) => SiteResult {
            site,
            matches: Vec::new(),
            error: Some(err.to_string()),
        },
    }
}

pub async fn search_mangadex(query: &str) -> anyhow::Result<Vec<Match>> {
    let q: String = url::form_urlencoded::byte_serialize(query.as_bytes()).collect();
    let found = get_json(&format!(
        "{MANGADEX}/manga?title={q}&limit=8&includes[]=cover_art&{RATINGS}"
    ))
    .await?;
    Ok(found["data"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|m| {
            let attrs = &m["attributes"];
            let id = m["id"].as_str().unwrap_or("");
            let titles: Vec<String> = attrs["title"]
                .as_object()
                .map(|o| {
                    o.values()
                        .filter_map(|v| v.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default();
            let title = attrs["title"]["en"]
                .as_str()
                .map(str::to_string)
                .or_else(|| titles.first().cloned())
                .unwrap_or_default();
            let alts: Vec<&serde_json::Map<String, Value>> = attrs["altTitles"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_object)
                .collect();
            // Os nomes em inglês primeiro: os outros sites usam mais eles.
            let mut alt_names: Vec<String> = alts
                .iter()
                .filter_map(|a| a.get("en").and_then(Value::as_str).map(str::to_string))
                .collect();
            alt_names.extend(titles.iter().filter(|t| **t != title).cloned());
            alt_names.extend(
                alts.iter()
                    .filter(|a| !a.contains_key("en"))
                    .flat_map(|a| a.values().filter_map(|v| v.as_str().map(str::to_string))),
            );
            let mut pt_names: Vec<String> = attrs["title"]["pt-br"]
                .as_str()
                .map(|s| vec![s.to_string()])
                .unwrap_or_default();
            pt_names.extend(alts.iter().filter_map(|a| {
                a.get("pt-br")
                    .or_else(|| a.get("pt"))
                    .and_then(Value::as_str)
                    .map(str::to_string)
            }));
            let cover = m["relationships"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|r| r["type"] == "cover_art")
                .and_then(|r| r["attributes"]["fileName"].as_str())
                .map(|f| format!("https://uploads.mangadex.org/covers/{id}/{f}.512.jpg"));
            Match {
                site: Site::Mangadex,
                title,
                url: format!("https://mangadex.org/title/{id}"),
                cover,
                alt_names,
                latest: attrs["lastChapter"].as_str().and_then(|s| s.parse().ok()),
                pt_names,
            }
        })
        .collect())
}

#[derive(Deserialize)]
struct Item {
    url: String,
    title: String,
    cover: Option<String>,
    chapter: String,
}

async fn search_site(site: Site, query: &str) -> anyhow::Result<Vec<Match>> {
    let q: String = url::form_urlencoded::byte_serialize(query.as_bytes()).collect();
    let (address, script) = match site {
        Site::Mgeko => (
            format!("https://www.mgeko.cc/search/?search={q}"),
            r"[...document.querySelectorAll('li.novel-item')].map((li) => {
                const a = li.querySelector('a[href]'); const img = li.querySelector('img'); const src = img && (img.dataset.src || img.src)
                return { url: a ? a.href : '', title: ((li.querySelector('.novel-title') || {}).innerText || (a && a.title) || '').trim(),
                  cover: src ? new URL(src, location.href).href : null, chapter: ((li.querySelector('.novel-stats strong') || {}).innerText || '').trim() } })",
        ),
        Site::Mangakakalot => {
            // A busca deles recebe o nome como os links escrevem: "omniscient_reader".
            let words: Vec<String> = query
                .split(|c: char| !c.is_alphanumeric())
                .filter(|w| !w.is_empty())
                .map(normalize_name)
                .collect();
            (
                format!(
                    "https://www.mangakakalot.fan/home/search/json?searchword={}",
                    words.join("_")
                ),
                r"[...document.querySelectorAll('.story_item')].map((item) => { const a = item.querySelector('.story_name a[href]'); const img = item.querySelector('img')
                return { url: a ? a.href : '', title: a ? a.innerText.trim() : '', cover: img ? img.src : null, chapter: ((item.querySelector('.story_chapter') || {}).innerText || '').trim() } })",
            )
        }
        Site::Mangalivre => (
            format!("https://mangalivre.blog/?s={q}"),
            r"[...document.querySelectorAll('a.manga-card-link[href]')].map((a) => { const img = a.querySelector('img')
                return { url: a.href, title: ((a.querySelector('.manga-card-title') || {}).innerText || (img && img.alt) || '').trim(),
                  cover: img ? img.currentSrc || img.src : null, chapter: ((a.querySelector('.chapter-number') || {}).innerText || '').trim() } })",
        ),
        _ => bail!("site sem busca"),
    };
    let mut tab = Tab::new().await?;
    load(&mut tab, &address).await?;
    let items: Vec<Item> = tab.eval(script).await?;
    Ok(items
        .into_iter()
        .filter(|i| !i.url.is_empty() && !i.title.is_empty())
        .map(|i| Match {
            site,
            latest: first_number(&i.chapter),
            title: i.title,
            url: i.url,
            cover: i.cover,
            alt_names: Vec::new(),
            pt_names: Vec::new(),
        })
        .collect())
}

/// Abre a página passando a verificação do site (mostrada para a pessoa quando não passa sozinha) e
/// entrando na conta quando o site pede.
async fn load(tab: &mut Tab, url: &str) -> anyhow::Result<()> {
    tab.open(url).await?;
    tab.pass_challenge(|| ()).await?;
    if sign_in_if_asked(tab, url).await {
        tokio::time::sleep(SETTLE).await;
    }
    Ok(())
}

/// Todos os capítulos de uma obra, do mais antigo ao mais novo.
pub async fn chapter_list(site: Site, url: &str) -> anyhow::Result<ChapterList> {
    let site = if site == Site::Link {
        Site::of_url(url)
    } else {
        site
    };
    match site {
        Site::Mangadex => Ok(ChapterList {
            title: None,
            chapters: mangadex_chapters(url).await?,
            language: None,
        }),
        Site::Mangakakalot => mangakakalot_chapters(url).await,
        Site::Mangalivre => mangalivre_chapters(url).await,
        Site::Mgeko => {
            let list = format!("{}/all-chapters/", url.trim_end_matches('/'));
            let mut tab = Tab::new().await?;
            load(&mut tab, &list).await?;
            let links: Vec<PageLink> = tab.eval(&links_script(".chapter-list a[href]")).await?;
            Ok(ChapterList {
                title: None,
                chapters: chapter_links(url, &links, true),
                language: None,
            })
        }
        Site::Link => page_chapters(url).await,
    }
}

fn mangadex_id(url: &str) -> Option<String> {
    static ID: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)mangadex\.org/title/([0-9a-f-]{36})").unwrap());
    ID.captures(url).map(|c| c[1].to_lowercase())
}

async fn mangadex_chapters(source: &str) -> anyhow::Result<Vec<ChapterLink>> {
    let Some(id) = mangadex_id(source) else {
        return Ok(Vec::new());
    };
    let mut found: BTreeMap<String, ChapterLink> = BTreeMap::new();
    let mut offset = 0;
    while offset < MANGADEX_MAX_CHAPTERS {
        let feed = get_json(&format!(
            "{MANGADEX}/manga/{id}/feed?limit={MANGADEX_PAGE}&offset={offset}&order[chapter]=asc&translatedLanguage[]=en&{RATINGS}"
        ))
        .await?;
        for c in feed["data"].as_array().into_iter().flatten() {
            let attrs = &c["attributes"];
            let Some(chapter) = attrs["chapter"]
                .as_str()
                .and_then(|s| s.parse::<f64>().ok())
            else {
                continue;
            };
            // Capítulos em sites oficiais são só links para lá, sem páginas para traduzir.
            if !attrs["externalUrl"].is_null() {
                continue;
            }
            found
                .entry(format!("{chapter:012.3}"))
                .or_insert(ChapterLink {
                    chapter,
                    url: format!(
                        "https://mangadex.org/chapter/{}",
                        c["id"].as_str().unwrap_or("")
                    ),
                    date: None,
                });
        }
        offset += MANGADEX_PAGE;
        if offset as u64 >= feed["total"].as_u64().unwrap_or(0) {
            break;
        }
    }
    Ok(found.into_values().collect())
}

/// Os capítulos do MangaKakalot, da lista que a página da obra usa, pedida de dentro da própria página:
/// o site fica atrás do Cloudflare, cujo cookie só uma página manda.
async fn mangakakalot_chapters(url: &str) -> anyhow::Result<ChapterList> {
    let page = url::Url::parse(url)?;
    let Some(slug) = page
        .path_segments()
        .and_then(|mut s| s.nth(1))
        .filter(|s| !s.is_empty())
        .map(str::to_string)
    else {
        bail!("Link do MangaKakalot sem a obra.");
    };
    let origin = page.origin().ascii_serialization();
    let api = format!("{origin}/api/manga/{slug}/chapters?limit=5000&offset=0");
    let mut tab = Tab::new().await?;
    load(&mut tab, url).await?;
    #[derive(Deserialize)]
    struct Answer {
        status: u16,
        text: String,
    }
    let answer: Answer = tab
        .eval(&format!(
            "fetch({}, {{ headers: {{ Accept: 'application/json' }} }}).then(async (r) => ({{ status: r.status, text: await r.text() }}))",
            serde_json::to_string(&api)?
        ))
        .await?;
    if answer.status != 200 {
        bail!("O MangaKakalot respondeu {}.", answer.status);
    }
    let body: Value = serde_json::from_str(&answer.text)?;
    let mut chapters: Vec<ChapterLink> = Vec::new();
    for c in body["data"]["chapters"]
        .as_array()
        .into_iter()
        .flatten()
        .rev()
    {
        let Some(chapter) = c["chapter_num"].as_f64() else {
            continue;
        };
        if chapters.iter().any(|x| x.chapter == chapter) {
            continue;
        }
        chapters.push(ChapterLink {
            chapter,
            url: format!(
                "{origin}/manga/{slug}/{}",
                c["chapter_slug"].as_str().unwrap_or("")
            ),
            date: None,
        });
    }
    chapters.sort_by(|a, b| a.chapter.total_cmp(&b.chapter));
    Ok(ChapterList {
        title: None,
        chapters,
        language: None,
    })
}

/// Os capítulos no MangaLivre: a página mostra 30, "Carregar mais capítulos" mostra o resto.
async fn mangalivre_chapters(url: &str) -> anyhow::Result<ChapterList> {
    let mut tab = Tab::new().await?;
    load(&mut tab, url).await?;
    tokio::time::sleep(SETTLE).await;
    tab.eval::<bool>(
        r#"(async () => {
      const count = () => new Set([...document.querySelectorAll('a[href*="/capitulo/"]')].map((a) => a.href)).size
      for (let i = 0; i < 300; i++) {
        const more = document.querySelector('.chapters-load-more')
        if (!more || !more.getClientRects().length || more.disabled) break
        const before = count()
        more.click()
        for (let waited = 0; waited < 40 && count() === before; waited++) await new Promise((r) => setTimeout(r, 250))
        if (count() === before) break
      }
      return true
    })()"#,
    )
    .await?;
    // Os capítulos da obra ficam em "/capitulo/<slug dela>-…" (a página tem link de outras também).
    let slug = url::Url::parse(url)?
        .path_segments()
        .and_then(|mut s| s.nth(1))
        .unwrap_or("")
        .to_lowercase();
    let links: Vec<PageLink> = tab.eval(&links_script(r#"a[href*="/capitulo/"]"#)).await?;
    let prefix = format!("/capitulo/{slug}-");
    let links: Vec<PageLink> = links
        .into_iter()
        .filter(|l| {
            url::Url::parse(&l.href).is_ok_and(|u| u.path().to_lowercase().starts_with(&prefix))
        })
        .collect();
    Ok(ChapterList {
        title: None,
        chapters: chapter_links(url, &links, true),
        language: Some("pt-BR".into()),
    })
}

/// Qualquer site: os capítulos com link na página da obra, rolada até o fim para listas que carregam
/// conforme aparecem.
async fn page_chapters(url: &str) -> anyhow::Result<ChapterList> {
    if !url.starts_with("http") {
        bail!("Cole o link da página da obra (o que começa com https://).");
    }
    let mut tab = Tab::new().await?;
    load(&mut tab, url).await?;
    tokio::time::sleep(Duration::from_secs(3)).await;
    if url::Url::parse(&tab.url().await).is_ok_and(|u| {
        Regex::new(r"(?i)/(entrar|login|signin|sign-in|auth)\b")
            .unwrap()
            .is_match(u.path())
    }) {
        bail!(
            "O site pediu login: clique em \"Entrar no site\", entre com a sua conta e tente de novo."
        );
    }
    for _ in 0..30 {
        let bottom: bool = tab
            .eval("(() => { window.scrollBy(0, window.innerHeight); return window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 4 })()")
            .await?;
        if bottom {
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    let title: String = tab.eval("document.title").await.unwrap_or_default();
    let language: String = tab
        .eval("document.documentElement.lang || ''")
        .await
        .unwrap_or_default();
    let links: Vec<PageLink> = tab.eval(&links_script("a[href]")).await?;
    let chapters = fill_chapter_gaps(chapter_links(url, &links, false));
    let title = title
        .split(['|', '–', '—'])
        .next()
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty());
    Ok(ChapterList {
        title,
        chapters,
        language: (!language.is_empty()).then_some(language),
    })
}

#[derive(Debug, Clone, Deserialize)]
pub struct PageLink {
    pub href: String,
    pub text: String,
}

fn links_script(selector: &str) -> String {
    format!(
        "[...document.querySelectorAll({})].map((a) => ({{ href: a.href, text: (a.innerText || a.textContent || '').trim().slice(0, 120) }}))",
        serde_json::to_string(selector).unwrap()
    )
}

static CHAPTER_TEXT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(?:\b(?:chapter|chap|ch|cap(?:[ií]tulo)?|ep(?:is[oó]dio|isode)?)\.?\s*[-#:]?\s*|#)(\d+(?:[.,]\d+)?)").unwrap()
});
static CHAPTER_PAGE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)/(capitulo|chapter|cap|ch|episode|episodio)/\d+").unwrap());

/// O nome da obra no caminho da página dela, sem o id do site no fim.
fn work_slug(path: &str) -> Option<String> {
    static NAMED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[a-z].*[-_].*[a-z]").unwrap());
    let lower = path.to_lowercase();
    let slug = lower
        .split('/')
        .filter(|s| !s.is_empty())
        .rev()
        .find(|s| NAMED.is_match(s))?
        .to_string();
    if let Some(cut) = slug.rfind(['-', '_']) {
        let tail = &slug[cut + 1..];
        if tail.len() >= 2
            && tail.chars().all(|c| c.is_ascii_alphanumeric())
            && tail.chars().any(|c| c.is_ascii_digit())
        {
            return Some(slug[..cut].to_string());
        }
    }
    Some(slug)
}

/// Os capítulos entre os links da página da obra, na ordem, um link cada. Só contam links do mesmo
/// site que têm o nome da obra no caminho, para listas de "populares" ao redor não entrarem.
pub fn chapter_links(source: &str, links: &[PageLink], only_this_work: bool) -> Vec<ChapterLink> {
    let named = chapter_links_of(source, links, only_this_work);
    if !named.is_empty() || only_this_work {
        return named;
    }
    let to_pages: Vec<PageLink> = links
        .iter()
        .filter(|l| CHAPTER_PAGE.is_match(&l.href) && CHAPTER_TEXT.is_match(&l.text))
        .cloned()
        .collect();
    chapter_links_of(source, &to_pages, true)
}

fn chapter_links_of(source: &str, links: &[PageLink], only_this_work: bool) -> Vec<ChapterLink> {
    let Ok(page) = url::Url::parse(source) else {
        return Vec::new();
    };
    let slug = work_slug(page.path());
    let host = |u: &url::Url| {
        u.host_str()
            .unwrap_or("")
            .trim_start_matches("www.")
            .to_string()
    };
    let mut found: Vec<ChapterLink> = Vec::new();
    for link in links {
        let Ok(mut url) = page.join(&link.href) else {
            continue;
        };
        if host(&url) != host(&page) {
            continue;
        }
        let path = url.path().to_lowercase();
        if !only_this_work
            && !slug
                .as_ref()
                .map_or(path.starts_with(&page.path().to_lowercase()), |s| {
                    path.contains(s.as_str())
                })
        {
            continue;
        }
        // O que o link diz primeiro: em "/capitulo/580922" o número é o id do site.
        let chapter = CHAPTER_TEXT
            .captures(&link.text)
            .and_then(|c| c[1].replace(',', ".").parse().ok())
            .or_else(|| chapter_in_url(url.as_str()));
        let Some(chapter) = chapter.filter(|&c| c <= 5000.0) else {
            continue;
        };
        if found.iter().any(|f| f.chapter == chapter) {
            continue;
        }
        url.set_fragment(None);
        found.push(ChapterLink {
            chapter,
            url: url.to_string(),
            date: None,
        });
    }
    found.sort_by(|a, b| a.chapter.total_cmp(&b.chapter));
    found
}

/// Sites costumam listar só os últimos capítulos (e o primeiro). Quando os links seguem um padrão
/// ("/nome/chapter-77/"), os capítulos inteiros que faltam entre o primeiro e o último são preenchidos.
pub fn fill_chapter_gaps(chapters: Vec<ChapterLink>) -> Vec<ChapterLink> {
    let pattern = |c: &ChapterLink| -> Option<String> {
        if c.chapter.fract() != 0.0 {
            return None;
        }
        let n = format!("{}", c.chapter as i64);
        let bytes = c.url.as_bytes();
        let mut at = None;
        let mut i = 0;
        while let Some(pos) = c.url[i..].find(&n) {
            let start = i + pos;
            let end = start + n.len();
            let before = start == 0 || !bytes[start - 1].is_ascii_digit();
            let after = end >= bytes.len() || !bytes[end].is_ascii_digit();
            if before && after {
                at = Some(start);
            }
            i = start + 1;
        }
        at.map(|s| format!("{}{{n}}{}", &c.url[..s], &c.url[s + n.len()..]))
    };
    let patterns: Vec<Option<String>> = chapters.iter().map(pattern).collect();
    let Some(template) = patterns.iter().flatten().next().cloned() else {
        return chapters;
    };
    if patterns
        .iter()
        .filter(|p| p.as_deref() == Some(template.as_str()))
        .count()
        < 2
    {
        return chapters;
    }
    let whole: Vec<i64> = chapters
        .iter()
        .filter(|c| c.chapter.fract() == 0.0)
        .map(|c| c.chapter as i64)
        .collect();
    let (lo, hi) = (*whole.iter().min().unwrap(), *whole.iter().max().unwrap());
    let mut filled = chapters.clone();
    for n in lo..=hi {
        if !chapters.iter().any(|c| c.chapter == n as f64) {
            filled.push(ChapterLink {
                chapter: n as f64,
                url: template.replace("{n}", &n.to_string()),
                date: None,
            });
        }
    }
    filled.sort_by(|a, b| a.chapter.total_cmp(&b.chapter));
    filled
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn links_of_the_work_only() {
        let links = vec![
            PageLink {
                href: "https://site.com/manga/solo-leveling/chapter-2/".into(),
                text: "Chapter 2".into(),
            },
            PageLink {
                href: "https://site.com/manga/solo-leveling/chapter-5/".into(),
                text: "Chapter 5".into(),
            },
            PageLink {
                href: "https://site.com/manga/other-work/chapter-9/".into(),
                text: "Chapter 9".into(),
            },
        ];
        let found = fill_chapter_gaps(chapter_links(
            "https://site.com/manga/solo-leveling/",
            &links,
            false,
        ));
        assert_eq!(
            found.iter().map(|c| c.chapter).collect::<Vec<_>>(),
            [2.0, 3.0, 4.0, 5.0]
        );
        assert_eq!(
            found[1].url,
            "https://site.com/manga/solo-leveling/chapter-3/"
        );
    }
}
