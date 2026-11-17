//! Capítulos lidos achados no histórico do Chrome, Brave, Opera e Edge, para importar a leitura.

use std::path::PathBuf;
use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::library::{index_work, list_works};
use crate::names::{chapter_in_url, is_novel_url, parse_chapter_name, same_name};
use crate::reading::{self, Record, Source, Status};
use crate::works::{Format, find_work};

/// Sites em que "episódio 3" ou "capítulo 2" não é de mangá.
static NOT_MANGA: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(^|\.)(youtube|google|netflix|crunchyroll|primevideo|disneyplus|max|wikipedia|github|stackoverflow|reddit|twitter|x|facebook|instagram|chatgpt|claude|bing|duckduckgo|twitch|spotify|amazon)\.[a-z.]+$").unwrap()
});

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryChapter {
    pub url: String,
    pub title: String,
    pub chapter: f64,
    pub at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryWork {
    /// O nome em que os capítulos foram achados.
    pub name: String,
    /// A obra conhecida para onde iriam, quando um nome bate.
    pub work_id: Option<String>,
    pub novel: bool,
    pub browsers: Vec<String>,
    pub sites: Vec<String>,
    pub chapters: Vec<HistoryChapter>,
}

struct HistoryFile {
    browser: &'static str,
    path: PathBuf,
}

/// Os bancos `History` de cada perfil dos navegadores.
fn history_files() -> Vec<HistoryFile> {
    let local = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_default();
    let roaming = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_default();
    let mut files = Vec::new();
    let mut profiles = |browser: &'static str, user_data: PathBuf| {
        let Ok(dirs) = std::fs::read_dir(&user_data) else {
            return;
        };
        for d in dirs.flatten() {
            let name = d.file_name().to_string_lossy().into_owned();
            let path = d.path().join("History");
            if (name == "Default" || name.starts_with("Profile ")) && path.exists() {
                files.push(HistoryFile { browser, path });
            }
        }
    };
    profiles("Chrome", local.join(r"Google\Chrome\User Data"));
    profiles(
        "Brave",
        local.join(r"BraveSoftware\Brave-Browser\User Data"),
    );
    profiles("Edge", local.join(r"Microsoft\Edge\User Data"));
    for (browser, dir) in [("Opera", "Opera Stable"), ("Opera GX", "Opera GX Stable")] {
        for path in [
            roaming.join("Opera Software").join(dir).join("History"),
            roaming
                .join("Opera Software")
                .join(dir)
                .join("Default")
                .join("History"),
        ] {
            if path.exists() {
                files.push(HistoryFile { browser, path });
            }
        }
    }
    files
}

/// O Chromium guarda o tempo em microssegundos desde 1601.
fn from_chrome_time(micros: i64) -> i64 {
    micros / 1000 - 11_644_473_600_000
}

struct Found {
    chapter: HistoryChapter,
    work: String,
    browser: &'static str,
}

/// O navegador deixa o banco travado enquanto está aberto; uma cópia dá para ler.
fn read_history(file: &HistoryFile) -> anyhow::Result<Vec<Found>> {
    let copy = std::env::temp_dir().join(format!(
        "toon-index-history-{}.sqlite",
        uuid::Uuid::new_v4()
    ));
    std::fs::copy(&file.path, &copy)?;
    let result = (|| {
        let db = rusqlite::Connection::open_with_flags(
            &copy,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )?;
        let mut stmt =
            db.prepare("SELECT url, title, last_visit_time FROM urls WHERE title != ''")?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
            ))
        })?;
        static BAD_TITLE: LazyLock<Regex> = LazyLock::new(|| {
            Regex::new(r"(?i)^\s*\d{3}\b|error occurred|not found|não encontrad").unwrap()
        });
        static WATCH: LazyLock<Regex> =
            LazyLock::new(|| Regex::new(r"(?i)^\s*(assistir|watch)\b").unwrap());
        let mut found = Vec::new();
        for row in rows.flatten() {
            let (url, title, at) = row;
            let Ok(u) = url::Url::parse(&url) else {
                continue;
            };
            if !matches!(u.scheme(), "http" | "https") {
                continue;
            }
            let host = u.host_str().unwrap_or("");
            // Sites de vídeo ("Assistir … Episódio 5") e páginas de erro guardadas no histórico.
            if NOT_MANGA.is_match(host)
                || host.to_lowercase().contains("anime")
                || WATCH.is_match(&title)
                || BAD_TITLE.is_match(&title)
            {
                continue;
            }
            // O link também tem que dizer o capítulo: só o título ("Chapter 3 - Começando") diz pouco.
            let parsed = parse_chapter_name(&title, Some(&url));
            let (Some(chapter), false) = (parsed.chapter, parsed.work.is_empty()) else {
                continue;
            };
            let number = crate::jobs::number_text(chapter).replace('.', "[.-]");
            let in_path = Regex::new(&format!(r"[/_-]{number}(?:[/_.-]|$)"))
                .map(|r| r.is_match(u.path()))
                .unwrap_or(false);
            if chapter_in_url(&url) != Some(chapter) && !in_path {
                continue;
            }
            found.push(Found {
                chapter: HistoryChapter {
                    url,
                    title,
                    chapter,
                    at: from_chrome_time(at),
                },
                work: parsed.work,
                browser: file.browser,
            });
        }
        Ok::<_, anyhow::Error>(found)
    })();
    let _ = std::fs::remove_file(&copy);
    result
}

/// Os capítulos achados em todos os históricos, agrupados por obra; a lida mais recentemente primeiro.
pub fn scan() -> (Vec<HistoryWork>, Vec<String>) {
    let mut problems = Vec::new();
    let mut found = Vec::new();
    let files = history_files();
    if files.is_empty() {
        problems.push(
            "Nenhum histórico do Chrome, Brave, Opera ou Edge foi encontrado neste computador."
                .to_string(),
        );
    }
    for f in &files {
        match read_history(f) {
            Ok(list) => found.extend(list),
            Err(e) => problems.push(format!(
                "{}: não deu para ler o histórico ({e}). Feche o navegador e tente de novo.",
                f.browser
            )),
        }
    }
    found.sort_by(|a, b| b.chapter.at.cmp(&a.chapter.at));
    let works = list_works();
    let mut groups: Vec<HistoryWork> = Vec::new();
    for item in found {
        // A novel e o mangá de mesmo nome são duas obras.
        let novel = is_novel_url(&item.chapter.url);
        let format = if novel { Format::Novel } else { Format::Comic };
        let known = find_work(&works, &item.work, format);
        let at = match known {
            Some(k) => groups
                .iter()
                .position(|g| g.work_id.as_deref() == Some(&k.id)),
            None => groups.iter().position(|g| {
                g.work_id.is_none() && g.novel == novel && same_name(&g.name, &item.work)
            }),
        };
        let group = match at {
            Some(i) => &mut groups[i],
            None => {
                groups.push(HistoryWork {
                    name: known
                        .map(|k| k.name().to_string())
                        .unwrap_or(item.work.clone()),
                    work_id: known.map(|k| k.id.clone()),
                    novel,
                    browsers: Vec::new(),
                    sites: Vec::new(),
                    chapters: Vec::new(),
                });
                groups.last_mut().unwrap()
            }
        };
        let site = url::Url::parse(&item.chapter.url)
            .ok()
            .and_then(|u| {
                u.host_str()
                    .map(|h| h.trim_start_matches("www.").to_string())
            })
            .unwrap_or_default();
        if !group.browsers.iter().any(|b| b == item.browser) {
            group.browsers.push(item.browser.to_string());
        }
        if !group.sites.contains(&site) {
            group.sites.push(site);
        }
        // O mesmo capítulo visto em vários sites ou navegadores conta uma vez, na visita mais recente.
        if !group
            .chapters
            .iter()
            .any(|c| c.chapter == item.chapter.chapter)
        {
            group.chapters.push(item.chapter);
        }
    }
    for g in &mut groups {
        g.chapters.sort_by(|a, b| a.chapter.total_cmp(&b.chapter));
    }
    (groups, problems)
}

/// Importa as obras escolhidas. Todo capítulo antes do último visto foi passado adiante, então conta
/// como lido; o último é onde a leitura parou, sem saber se terminou.
pub fn import(chosen: &[HistoryWork]) -> anyhow::Result<usize> {
    let mut incoming = Vec::new();
    for group in chosen {
        let work_id = match &group.work_id {
            Some(id) => id.clone(),
            None => index_work(
                &group.name,
                if group.novel {
                    Format::Novel
                } else {
                    Format::Comic
                },
                false,
            )?,
        };
        let last = group
            .chapters
            .iter()
            .map(|c| c.chapter)
            .fold(f64::MIN, f64::max);
        for c in &group.chapters {
            let done = c.chapter < last;
            incoming.push(Record {
                work_id: work_id.clone(),
                chapter: c.chapter,
                status: if done { Status::Read } else { Status::Reading },
                progress: done.then_some(1.0),
                url: c.url.clone(),
                title: c.title.clone(),
                source: Source::History,
                updated_at: c.at,
            });
        }
    }
    let count = incoming.len();
    reading::merge_records(incoming)?;
    Ok(count)
}
