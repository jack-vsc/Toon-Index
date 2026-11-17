//! O que a extensão do navegador (e o navegador do celular) pergunta de uma página aberta: de que
//! obra é, até onde foi lida, pôr numa lista, marcar como lido até aqui, e o que continuar lendo.

use serde::{Deserialize, Serialize};

use crate::library::{self, list_library, list_works};
use crate::names::{display_name, is_novel_url, parse_chapter_name};
use crate::reading::{self, Status};
use crate::updates;
use crate::works::{Format, Shelf, Work, find_work};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageInfo {
    pub work_id: Option<String>,
    pub name: String,
    pub chapter: Option<f64>,
    pub shelf: Option<Shelf>,
    pub favorite: bool,
    pub read_up_to: Option<f64>,
    pub in_library: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct Latest {
    pub chapter: f64,
    pub url: String,
    pub recent: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContinueItem {
    pub work_id: String,
    pub name: String,
    pub shelf: Option<Shelf>,
    pub favorite: bool,
    pub chapter: f64,
    pub url: String,
    pub latest: Option<Latest>,
    pub at: i64,
}

/// O que mudar na obra: lista (`Some(None)` tira de todas) e favorita.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct Bookmark {
    #[serde(default, deserialize_with = "maybe_null")]
    pub shelf: Option<Option<Shelf>>,
    #[serde(default)]
    pub favorite: Option<bool>,
}

fn maybe_null<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Option<Shelf>>, D::Error> {
    Ok(Some(Option::<Shelf>::deserialize(d)?))
}

fn bare(url: &str) -> String {
    let cut = url.find(['?', '#']).map_or(url, |i| &url[..i]);
    cut.trim_end_matches('/').to_lowercase()
}

fn format_of(url: &str) -> Format {
    if is_novel_url(url) {
        Format::Novel
    } else {
        Format::Comic
    }
}

fn work_of(url: &str, title: &str, work_url: Option<&str>) -> (Option<Work>, String, Option<f64>) {
    let parsed = parse_chapter_name(title, Some(url));
    let works = list_works();
    let mut pages = vec![bare(url)];
    if let Some(w) = work_url {
        pages.push(bare(w));
    }
    let by_source = works
        .iter()
        .find(|w| {
            w.sources()
                .iter()
                .any(|s| pages.iter().any(|p| p.starts_with(&bare(s))))
        })
        .cloned();
    let by_name = if parsed.work.is_empty() {
        None
    } else {
        find_work(&works, &parsed.work, format_of(url)).cloned()
    };
    let work = by_source.or(by_name);
    let name = work
        .as_ref()
        .map(|w| display_name(w.name()))
        .unwrap_or(parsed.work);
    (work, name, parsed.chapter)
}

pub fn page_info(url: &str, title: &str, work_url: Option<&str>) -> PageInfo {
    let (work, name, chapter) = work_of(url, title, work_url);
    let records: Vec<reading::Record> = work
        .as_ref()
        .map(|w| {
            reading::list()
                .into_iter()
                .filter(|r| r.work_id == w.id)
                .collect()
        })
        .unwrap_or_default();
    let read_up_to = records
        .iter()
        .filter(|r| r.status == Status::Read)
        .map(|r| r.chapter)
        .reduce(f64::max);
    PageInfo {
        work_id: work.as_ref().map(|w| w.id.clone()),
        name,
        chapter,
        shelf: work.as_ref().and_then(|w| w.shelf_of(!records.is_empty())),
        favorite: work.as_ref().is_some_and(|w| w.favorite),
        read_up_to,
        in_library: work
            .as_ref()
            .map(|w| list_library().iter().filter(|e| e.work_id == w.id).count())
            .unwrap_or(0),
    }
}

pub fn bookmark_page(
    url: &str,
    title: &str,
    patch: &Bookmark,
    work_url: Option<&str>,
) -> anyhow::Result<PageInfo> {
    let (work, name, chapter) = work_of(url, title, work_url);
    if work.is_none() && name.is_empty() {
        anyhow::bail!("Não deu para saber o nome da obra nesta página.");
    }
    let work_id = match work {
        Some(w) => w.id,
        None => library::index_work(&name, format_of(url), false)?,
    };
    if chapter.is_none() {
        let shown = list_works()
            .into_iter()
            .find(|w| w.id == work_id)
            .map(|w| w.name().to_string())
            .unwrap_or(name);
        library::add_work_source(&shown, url)?;
    } else if let Some(w) = work_url {
        library::add_work_source_to(&work_id, w)?;
    }
    library::set_work_shelf(&work_id, patch.shelf, patch.favorite)?;
    Ok(page_info(url, title, work_url))
}

/// Todos os capítulos até o desta página marcados como lidos.
pub fn read_up_to_page(url: &str, title: &str, work_url: Option<&str>) -> anyhow::Result<PageInfo> {
    let (work, name, chapter) = work_of(url, title, work_url);
    let Some(chapter) = chapter else {
        anyhow::bail!("Esta página não diz o capítulo.")
    };
    let work_id = match work {
        Some(w) => w.id,
        None if !name.is_empty() => library::index_work(&name, format_of(url), false)?,
        None => anyhow::bail!("Não deu para saber o nome da obra nesta página."),
    };
    let records: Vec<reading::Record> = reading::list()
        .into_iter()
        .filter(|r| r.work_id == work_id)
        .collect();
    let read: Vec<f64> = records
        .iter()
        .filter(|r| r.status == Status::Read)
        .map(|r| r.chapter)
        .collect();
    let mut chapters: Vec<f64> = (1..=chapter.floor() as i64).map(|n| n as f64).collect();
    chapters.extend(
        records
            .iter()
            .filter(|r| r.chapter <= chapter)
            .map(|r| r.chapter),
    );
    chapters.push(chapter);
    chapters.sort_by(f64::total_cmp);
    chapters.dedup();
    chapters.retain(|c| !read.contains(c));
    if !chapters.is_empty() {
        reading::mark_read(&work_id, &chapters)?;
    }
    Ok(page_info(url, title, work_url))
}

/// As obras para voltar a ler: favoritas primeiro, depois as lidas mais recentemente.
pub fn continue_list(limit: usize) -> Vec<ContinueItem> {
    let records = reading::list();
    let fresh = updates::unread();
    let mut items = Vec::new();
    for work in list_works() {
        let own: Vec<&reading::Record> = records.iter().filter(|r| r.work_id == work.id).collect();
        let shelf = work.shelf_of(!own.is_empty());
        if own.is_empty() || matches!(shelf, Some(Shelf::Done | Shelf::Dropped)) {
            continue;
        }
        let up_to = own
            .iter()
            .filter(|r| r.status == Status::Read)
            .map(|r| r.chapter)
            .fold(f64::MIN, f64::max);
        let current = own
            .iter()
            .filter(|r| r.status == Status::Reading && r.chapter > up_to)
            .max_by_key(|r| r.updated_at);
        let last = current.or_else(|| {
            own.iter()
                .filter(|r| !r.url.is_empty())
                .max_by(|a, b| a.chapter.total_cmp(&b.chapter))
        });
        let Some(last) = last.filter(|r| !r.url.is_empty()) else {
            continue;
        };
        let latest = fresh.iter().find(|u| u.work_id == work.id).map(|u| Latest {
            chapter: u.latest,
            url: u.url.clone(),
            recent: u.is_recent(),
        });
        items.push(ContinueItem {
            work_id: work.id.clone(),
            name: display_name(work.name()),
            shelf,
            favorite: work.favorite,
            chapter: last.chapter,
            url: last.url.clone(),
            latest,
            at: own.iter().map(|r| r.updated_at).max().unwrap_or(0),
        });
    }
    items.sort_by(|a, b| b.favorite.cmp(&a.favorite).then(b.at.cmp(&a.at)));
    items.truncate(limit);
    items
}
