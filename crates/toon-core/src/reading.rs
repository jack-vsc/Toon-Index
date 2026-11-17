//! Até onde cada obra foi lida: capítulos lidos no navegador (a extensão manda), achados no histórico
//! dos navegadores ou lidos traduzidos no app. Fica por obra, então sobrevive ao site em que foi lida.

use std::collections::HashSet;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::library::{self, LOCK};
use crate::names::{is_novel_url, parse_chapter_name};
use crate::now_ms;
use crate::paths::library_dir;
use crate::store::{read_json, write_json};
use crate::works::Format;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Read,
    Reading,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    Browser,
    History,
    App,
    Manual,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    pub work_id: String,
    pub chapter: f64,
    /// `Reading` quando não se sabe se terminou: parou no meio, ou só apareceu no histórico.
    pub status: Status,
    /// Quanto das páginas foi lido, de 0 a 1; `None` quando não se sabe.
    pub progress: Option<f64>,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub title: String,
    pub source: Source,
    pub updated_at: i64,
}

/// O que a extensão manda enquanto uma página de capítulo está aberta.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub url: String,
    pub title: String,
    #[serde(default)]
    pub work_url: Option<String>,
    pub progress: Option<f64>,
    #[serde(default)]
    pub finished: bool,
    #[serde(default)]
    pub at: Option<i64>,
}

#[derive(Default, Serialize, Deserialize)]
struct ReadingFile {
    #[serde(default)]
    records: Vec<Record>,
}

fn path() -> PathBuf {
    library_dir().join("reading.json")
}

pub fn list() -> Vec<Record> {
    read_json::<ReadingFile>(&path()).records
}

fn save(records: Vec<Record>) -> anyhow::Result<()> {
    write_json(&path(), &ReadingFile { records })
}

fn change(f: impl FnOnce(Vec<Record>) -> Vec<Record>) -> anyhow::Result<()> {
    let _guard = LOCK.lock();
    save(f(list()))
}

/// Anota um capítulo como lido ou como o ponto da leitura. Nunca volta atrás: o que foi lido continua
/// lido e a posição só avança. Abrir um capítulo quer dizer que o anterior foi terminado.
pub fn upsert(mut records: Vec<Record>, next: Record) -> Vec<Record> {
    if let Some(old) = records
        .iter_mut()
        .find(|r| r.work_id == next.work_id && r.chapter == next.chapter)
    {
        let status = if old.status == Status::Read || next.status == Status::Read {
            Status::Read
        } else {
            Status::Reading
        };
        let progress = match (old.progress, next.progress) {
            (None, p) | (p, None) => p,
            (Some(a), Some(b)) => Some(a.max(b)),
        };
        // O lugar mais recente onde foi lido; o histórico nunca substitui o que a extensão viu.
        if next.updated_at >= old.updated_at
            && (next.source != Source::History || old.source == Source::History)
        {
            if !next.url.is_empty() {
                old.url = next.url.clone();
            }
            if !next.title.is_empty() {
                old.title = next.title.clone();
            }
            old.source = next.source;
            old.updated_at = next.updated_at;
        }
        old.status = status;
        old.progress = progress;
    } else {
        records.push(next.clone());
    }
    // Em qualquer ordem que cheguem (o histórico pode trazer um capítulo antigo depois de um novo).
    let chapters: Vec<f64> = records
        .iter()
        .filter(|r| r.work_id == next.work_id)
        .map(|r| r.chapter)
        .collect();
    for r in records
        .iter_mut()
        .filter(|r| r.work_id == next.work_id && r.status == Status::Reading)
    {
        if chapters
            .iter()
            .any(|&c| c > r.chapter && c <= r.chapter + 1.0)
        {
            r.status = Status::Read;
            r.progress = Some(1.0);
        }
    }
    records
}

/// Uma página de capítulo aberta no navegador; `None` quando a página não nomeia capítulo de nada.
pub fn report(report: &Report) -> anyhow::Result<Option<(Record, String)>> {
    let parsed = parse_chapter_name(&report.title, Some(&report.url));
    let (Some(chapter), false) = (parsed.chapter, parsed.work.is_empty()) else {
        return Ok(None);
    };
    let format = if is_novel_url(&report.url) {
        Format::Novel
    } else {
        Format::Comic
    };
    let work_id = library::index_work(&parsed.work, format, false)?;
    let record = Record {
        work_id: work_id.clone(),
        chapter,
        status: if report.finished {
            Status::Read
        } else {
            Status::Reading
        },
        progress: report.progress.map(|p| p.clamp(0.0, 1.0)),
        url: report.url.clone(),
        title: report.title.clone(),
        source: Source::Browser,
        updated_at: report.at.unwrap_or_else(now_ms),
    };
    change(|records| upsert(records, record))?;
    library::started_reading(&work_id);
    if let Some(work_url) = &report.work_url
        && same_site(work_url, &report.url)
        && crate::names::chapter_in_url(work_url).is_none()
    {
        library::add_work_source_to(&work_id, work_url)?;
    }
    let saved = list()
        .into_iter()
        .find(|r| r.work_id == work_id && r.chapter == chapter);
    let name = library::list_works()
        .into_iter()
        .find(|w| w.id == work_id)
        .map(|w| w.name().to_string());
    Ok(saved.map(|r| (r, name.unwrap_or(parsed.work))))
}

fn same_site(a: &str, b: &str) -> bool {
    match (url::Url::parse(a), url::Url::parse(b)) {
        (Ok(a), Ok(b)) => a.host_str() == b.host_str() && matches!(a.scheme(), "http" | "https"),
        _ => false,
    }
}

/// Até onde um capítulo da biblioteca foi lido no app (no PC ou no celular, que pode mandar depois);
/// a última página conta como lido.
pub fn read_in_app(entry_id: &str, progress: f64, at: Option<i64>) -> anyhow::Result<()> {
    let meta = library::read_meta(entry_id)?;
    let Some(chapter) = meta.chapter else {
        return Ok(());
    };
    let p = progress.clamp(0.0, 1.0);
    let record = Record {
        work_id: meta.work_id.clone(),
        chapter,
        status: if p >= 1.0 {
            Status::Read
        } else {
            Status::Reading
        },
        progress: Some(p),
        url: meta.source.clone().unwrap_or_default(),
        title: meta.title.clone(),
        source: Source::App,
        updated_at: at.unwrap_or_else(now_ms),
    };
    change(|records| upsert(records, record))?;
    library::started_reading(&meta.work_id);
    Ok(())
}

/// Leituras vindas de outra cópia dos dados (um backup, o celular), juntadas como qualquer leitura.
pub fn merge_records(incoming: Vec<Record>) -> anyhow::Result<()> {
    if incoming.is_empty() {
        return Ok(());
    }
    let works: HashSet<String> = incoming.iter().map(|r| r.work_id.clone()).collect();
    change(|records| incoming.into_iter().fold(records, upsert))?;
    for w in works {
        library::started_reading(&w);
    }
    Ok(())
}

/// Capítulos marcados como lidos à mão (lidos onde o app não via).
pub fn mark_read(work_id: &str, chapters: &[f64]) -> anyhow::Result<()> {
    let at = now_ms();
    change(|records| {
        chapters.iter().fold(records, |all, &chapter| {
            upsert(
                all,
                Record {
                    work_id: work_id.to_string(),
                    chapter,
                    status: Status::Read,
                    progress: Some(1.0),
                    url: String::new(),
                    title: String::new(),
                    source: Source::Manual,
                    updated_at: at,
                },
            )
        })
    })
}

/// Capítulos marcados como não lidos: a leitura deles some (ou de todos, com `None`).
pub fn forget(work_id: &str, chapters: Option<&[f64]>) -> anyhow::Result<()> {
    change(|mut records| {
        records.retain(|r| {
            r.work_id != work_id || chapters.is_some_and(|list| !list.contains(&r.chapter))
        });
        records
    })
}

/// Os capítulos de `from_id` vão para `into_id` quando duas obras viram uma.
pub fn move_reading(from_id: &str, into_id: &str) -> anyhow::Result<()> {
    let records = list();
    if !records.iter().any(|r| r.work_id == from_id) {
        return Ok(());
    }
    let (moving, staying): (Vec<Record>, Vec<Record>) =
        records.into_iter().partition(|r| r.work_id == from_id);
    let merged = moving.into_iter().fold(staying, |all, mut r| {
        r.work_id = into_id.to_string();
        upsert(all, r)
    });
    save(merged)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(chapter: f64, status: Status) -> Record {
        Record {
            work_id: "w".into(),
            chapter,
            status,
            progress: None,
            url: String::new(),
            title: String::new(),
            source: Source::Browser,
            updated_at: 1,
        }
    }

    #[test]
    fn opening_next_chapter_finishes_the_one_before() {
        let records = upsert(vec![rec(10.0, Status::Reading)], rec(11.0, Status::Reading));
        assert_eq!(records[0].status, Status::Read);
        assert_eq!(records[1].status, Status::Reading);
    }

    #[test]
    fn read_stays_read() {
        let records = upsert(vec![rec(3.0, Status::Read)], rec(3.0, Status::Reading));
        assert_eq!(records[0].status, Status::Read);
    }
}
