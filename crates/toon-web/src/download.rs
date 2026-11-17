//! As páginas de um capítulo a partir da página de leitura no site. A maioria dos leitores monta a
//! página com scripts e só carrega as imagens quando elas aparecem na tela, então a página é aberta,
//! rolada até o fim, e as imagens do leitor (as grandes, na ordem) baixadas com os cookies do site e a
//! página como origem, como o próprio leitor faz.

use std::sync::LazyLock;
use std::time::Duration;

use anyhow::{Context, bail};
use base64::Engine;
use regex::Regex;
use serde::Deserialize;

use crate::browser::Tab;
use crate::logins::sign_in_if_asked;

const PARALLEL_DOWNLOADS: usize = 4;
/// Quanto tempo uma página com uma tela de altura tem para montar o leitor antes de ser lida como está.
const PAGES_BUILT: Duration = Duration::from_secs(12);

#[derive(Debug, Clone, Copy)]
pub enum Stage {
    Loading,
    Challenge,
    Scrolling,
    Downloading { done: usize, total: usize },
}

pub struct WebChapter {
    pub title: String,
    pub images: Vec<Vec<u8>>,
}

static HTTP: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder().connect_timeout(Duration::from_secs(20)).timeout(Duration::from_secs(90)).build().expect("cliente HTTP")
});

#[derive(Deserialize)]
struct Collected {
    title: String,
    urls: Vec<String>,
}

/// As imagens do leitor na ordem: atributos de carregamento preguiçoso incluídos, figuras pequenas
/// (logos, capas de outras obras, anúncios) deixadas de fora em comparação com as mais largas.
const COLLECT: &str = r#"(() => {
  const pick = (img) => {
    const lazy = ['data-src', 'data-lazy-src', 'data-original', 'data-original-src', 'data-url', 'data-cfsrc'].map((a) => img.getAttribute(a)).find((v) => v && !v.startsWith('data:image/'))
    const set = (img.getAttribute('data-srcset') || '').split(',').map((s) => s.trim().split(' ')[0]).filter(Boolean).pop()
    const src = lazy || set || img.currentSrc || img.src
    try { return src ? new URL(src.trim(), location.href).href : '' } catch { return '' }
  }
  const imgs = [...document.querySelectorAll('img')].map((img) => {
    const r = img.getBoundingClientRect()
    return { url: pick(img), w: Math.max(img.naturalWidth, r.width), h: Math.max(img.naturalHeight, r.height), shown: r.width }
  }).filter((i) => /^(https?|data|blob):/.test(i.url) && !/\.(svg|gif)(\?|$)/i.test(i.url) && !/^data:image\/(svg|gif)/i.test(i.url))
  const widest = Math.max(0, ...imgs.map((i) => i.shown))
  const seen = new Set()
  const urls = imgs.filter((i) => i.shown >= widest * 0.6 && i.w >= 300 && i.h >= 200).map((i) => i.url).filter((u) => !seen.has(u) && seen.add(u))
  return { title: document.title, urls }
})()"#;

/// As páginas vistas até agora junto com as da tela: uma página nova entra logo depois da que vem
/// antes dela na tela (ou antes da primeira conhecida, no topo).
pub fn merge_in_order(known: &mut Vec<String>, seen: &[String]) {
    let first_known = seen.iter().find(|u| known.contains(u));
    let mut at = first_known.and_then(|u| known.iter().position(|k| k == u)).unwrap_or(known.len());
    for url in seen {
        match known.iter().position(|k| k == url) {
            Some(i) => at = i + 1,
            None => {
                known.insert(at, url.clone());
                at += 1;
            }
        }
    }
}

fn mangadex_id(url: &str) -> Option<String> {
    static ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^https://mangadex\.org/chapter/([0-9a-f-]{36})").unwrap());
    ID.captures(url).map(|c| c[1].to_string())
}

pub async fn fetch_chapter(url: &str, progress: impl Fn(Stage)) -> anyhow::Result<WebChapter> {
    if !url.starts_with("http://") && !url.starts_with("https://") {
        bail!("Informe um link que comece com http:// ou https://.");
    }
    if let Some(id) = mangadex_id(url) {
        return mangadex_chapter(&id, &progress).await;
    }
    progress(Stage::Loading);
    let mut tab = Tab::new().await?;
    tab.open(url).await?;
    tab.pass_challenge(|| progress(Stage::Challenge)).await?;
    // Mandado para o login: entra com a conta de site-logins.env, quando há uma.
    if sign_in_if_asked(&tab, url).await {
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
    progress(Stage::Scrolling);
    until_pages_built(&tab).await;
    from_the_top(&tab).await;
    // Lido a cada passo: alguns leitores só mantêm na página as imagens perto da tela (o MangaFire
    // mostra 6 de 165), então as que já passaram somem até o fim.
    let mut found: Vec<String> = Vec::new();
    let mut title = String::new();
    let (mut last_height, mut still) = (0i64, 0);
    for _ in 0..600 {
        if still >= 6 {
            break;
        }
        #[derive(Deserialize)]
        struct Step {
            height: i64,
            bottom: bool,
        }
        let step: Step = tab
            .eval("(() => { window.scrollBy(0, Math.round(window.innerHeight * 0.9)); const h = document.documentElement.scrollHeight; return { height: h, bottom: window.scrollY + window.innerHeight >= h - 4 } })()")
            .await?;
        still = if step.bottom && step.height == last_height { still + 1 } else { 0 };
        last_height = step.height;
        tokio::time::sleep(Duration::from_millis(if step.bottom { 400 } else { 120 })).await;
        tab.frame().await;
        let seen: Collected = tab.eval(COLLECT).await?;
        title = seen.title;
        merge_in_order(&mut found, &seen.urls);
    }
    // Um leitor que mantém todas as páginas é lido como está no fim: uma imagem trocada por outra
    // mais nítida durante a rolagem viria duas vezes.
    let last: Collected = tab.eval(COLLECT).await?;
    if last.urls.len() * 2 >= found.len() {
        found = last.urls;
        title = last.title;
    }
    if found.is_empty() {
        bail!("Não encontrei as páginas do capítulo nesse link. Confira se é a página de leitura do capítulo.");
    }
    let cookies = tab.cookie_header(url).await;
    let agent = tab.user_agent().await;
    let total = found.len();
    progress(Stage::Downloading { done: 0, total });
    let done = std::sync::atomic::AtomicUsize::new(0);
    let tab_ref = &tab;
    let downloads = futures::stream::iter(found.iter().cloned().enumerate())
        .map(|(i, image)| {
            let cookies = cookies.clone();
            let agent = agent.clone();
            let done = &done;
            let progress = &progress;
            async move {
                let bytes = download(tab_ref, &image, url, &cookies, &agent).await;
                let n = done.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
                progress(Stage::Downloading { done: n, total });
                bytes.map(|b| (i, b))
            }
        })
        .buffer_unordered(PARALLEL_DOWNLOADS);
    use futures::StreamExt;
    let mut images: Vec<Option<Vec<u8>>> = vec![None; total];
    let mut stream = Box::pin(downloads);
    while let Some(result) = stream.next().await {
        let (i, bytes) = result?;
        images[i] = Some(bytes);
    }
    let host = url::Url::parse(url).ok().and_then(|u| u.host_str().map(str::to_string)).unwrap_or_default();
    let title = clean_title(&title);
    Ok(WebChapter { title: if title.is_empty() { host } else { title }, images: images.into_iter().flatten().collect() })
}

/// Leitores que montam as páginas com script depois de carregar (o do MangaFire: 183 páginas alguns
/// segundos depois) ainda têm uma tela de altura no começo, o que parece "já no fim": espera.
async fn until_pages_built(tab: &Tab) {
    let started = std::time::Instant::now();
    while started.elapsed() < PAGES_BUILT {
        if tab.eval::<bool>("document.documentElement.scrollHeight > window.innerHeight * 1.5").await.unwrap_or(true) {
            return;
        }
        tab.frame().await;
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

/// Um leitor que volta para onde o capítulo foi deixado (o MangaFire, pelo progresso da conta) abre um
/// capítulo já lido no fim, só com as últimas páginas: volta ao topo até ficar lá.
async fn from_the_top(tab: &Tab) {
    for _ in 0..5 {
        if tab.eval::<bool>("window.scrollY < window.innerHeight || (window.scrollTo(0, 0), false)").await.unwrap_or(true) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(800)).await;
        tab.frame().await;
    }
}

/// Como o `<img>` do próprio leitor pede: servidores de imagem atrás do Cloudflare (o do
/// MangaKakalot) recusam o resto.
async fn download(tab: &Tab, image: &str, page: &str, cookies: &str, agent: &str) -> anyhow::Result<Vec<u8>> {
    // Endereços que só existem dentro da página são lidos pela própria página.
    if image.starts_with("blob:") || image.starts_with("data:") {
        return from_page(tab, image).await;
    }
    let from = url::Url::parse(page)?;
    let to = url::Url::parse(image)?;
    let site = |h: &str| h.rsplitn(3, '.').take(2).collect::<Vec<_>>().join(".");
    let fetch_site = if from.origin() == to.origin() {
        "same-origin"
    } else if site(from.host_str().unwrap_or("")) == site(to.host_str().unwrap_or("")) {
        "same-site"
    } else {
        "cross-site"
    };
    let mut attempt = 1;
    loop {
        let request = HTTP
            .get(image)
            .header("Referer", format!("{}/", from.origin().ascii_serialization()))
            .header("Accept", "image/avif,image/webp,image/apng,image/*,*/*;q=0.8")
            .header("Sec-Fetch-Dest", "image")
            .header("Sec-Fetch-Mode", "no-cors")
            .header("Sec-Fetch-Site", fetch_site)
            .header("User-Agent", agent)
            .header("Cookie", cookies);
        let result = async {
            let response = request.send().await?;
            let status = response.status();
            if status.as_u16() == 403 || status.as_u16() == 401 {
                return Err(anyhow::anyhow!("recusada"));
            }
            if !status.is_success() {
                bail!("HTTP {status}");
            }
            Ok(response.bytes().await?.to_vec())
        }
        .await;
        match result {
            Ok(bytes) => return Ok(bytes),
            Err(err) if err.to_string() == "recusada" => return from_page(tab, image).await,
            Err(err) if attempt >= 3 => bail!("Não foi possível baixar uma página ({image}): {err}"),
            Err(_) => {
                tokio::time::sleep(Duration::from_millis(800 * attempt)).await;
                attempt += 1;
            }
        }
    }
}

/// A imagem como a própria página busca, com os cookies dela.
async fn from_page(tab: &Tab, image: &str) -> anyhow::Result<Vec<u8>> {
    let js = format!(
        "fetch({}, {{ credentials: 'include' }}).then((r) => {{ if (!r.ok) throw new Error('HTTP ' + r.status); return r.blob() }}).then((b) => new Promise((ok) => {{ const f = new FileReader(); f.onload = () => ok(String(f.result).split(',')[1]); f.readAsDataURL(b) }}))",
        serde_json::to_string(image)?
    );
    let encoded: String = tab.eval(&js).await.with_context(|| format!("Não foi possível baixar uma página ({image})"))?;
    Ok(base64::engine::general_purpose::STANDARD.decode(encoded)?)
}

/// O leitor do MangaDex desenha as páginas da API de imagens, que dá os endereços direto.
async fn mangadex_chapter(id: &str, progress: &impl Fn(Stage)) -> anyhow::Result<WebChapter> {
    progress(Stage::Loading);
    // A API recusa navegadores: o app se apresenta pelo nome.
    let json = |url: String| async move {
        let r = HTTP.get(&url).header("User-Agent", "ToonIndex/1.0").send().await?;
        if !r.status().is_success() {
            bail!("O MangaDex respondeu {}.", r.status().as_u16());
        }
        Ok::<serde_json::Value, anyhow::Error>(r.json().await?)
    };
    let server = json(format!("https://api.mangadex.org/at-home/server/{id}")).await?;
    let info = json(format!("https://api.mangadex.org/chapter/{id}?includes[]=manga")).await?;
    let base = server["baseUrl"].as_str().unwrap_or_default();
    let hash = server["chapter"]["hash"].as_str().unwrap_or_default();
    let files: Vec<String> = server["chapter"]["data"].as_array().into_iter().flatten().filter_map(|f| f.as_str().map(str::to_string)).collect();
    if files.is_empty() {
        bail!("Esse capítulo do MangaDex não tem páginas (pode estar só num site oficial).");
    }
    let manga = info["data"]["relationships"].as_array().into_iter().flatten().find(|r| r["type"] == "manga").cloned().unwrap_or_default();
    let titles = &manga["attributes"]["title"];
    let work = titles["en"].as_str().or_else(|| titles.as_object().and_then(|o| o.values().next()).and_then(|v| v.as_str())).unwrap_or("MangaDex");
    let chapter = info["data"]["attributes"]["chapter"].as_str().unwrap_or("");
    let total = files.len();
    let mut images = Vec::with_capacity(total);
    for (i, file) in files.iter().enumerate() {
        let r = HTTP.get(format!("{base}/data/{hash}/{file}")).send().await?;
        if !r.status().is_success() {
            bail!("O MangaDex não entregou a página {} ({}).", i + 1, r.status().as_u16());
        }
        images.push(r.bytes().await?.to_vec());
        progress(Stage::Downloading { done: i + 1, total });
    }
    Ok(WebChapter { title: format!("{work} Chapter {chapter}").trim().to_string(), images })
}

/// "Nome Chapter 53 - Nome do Site" → "Nome Chapter 53".
fn clean_title(title: &str) -> String {
    static TAIL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+[|\-–—]\s+[^|–—]*$").unwrap());
    let mut t = title.to_string();
    if let Some(m) = TAIL.find(&t) {
        let tail = m.as_str().to_lowercase();
        if !(tail.contains("cap") || tail.contains("chap") || tail.contains("ep")) {
            t.truncate(m.start());
        }
    }
    let t: String = t.chars().map(|c| if "<>:\"/\\|?*".contains(c) || c < ' ' { ' ' } else { c }).collect();
    t.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(120).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn order_of_pages_seen_while_scrolling() {
        let mut known: Vec<String> = ["a", "b", "c"].iter().map(|s| s.to_string()).collect();
        merge_in_order(&mut known, &["c".into(), "d".into(), "e".into()]);
        assert_eq!(known, ["a", "b", "c", "d", "e"]);
        merge_in_order(&mut known, &["x".into(), "a".into()]);
        assert_eq!(known[0], "x");
        assert_eq!(clean_title("Solo Leveling Chapter 3 - MangaSite"), "Solo Leveling Chapter 3");
    }
}
