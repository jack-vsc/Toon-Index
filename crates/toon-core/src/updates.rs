//! Capítulos novos: o que cada página de obra nos sites tinha na última verificação, em `updates.json`.

use std::collections::BTreeMap;
use std::path::PathBuf;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::library::list_works;
use crate::paths::data_dir;
use crate::reading::{self, Status};
use crate::store::{read_json, write_json};
use crate::works::Work;
use crate::now_ms;

/// Um capítulo conta como novo por uma semana depois de sair.
pub const NEW_FOR_MS: i64 = 7 * 24 * 60 * 60_000;

static LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceCheck {
    pub checked_at: i64,
    /// O maior capítulo listado e o link dele; `None` quando nenhum foi achado.
    pub latest: Option<f64>,
    pub latest_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Por número de capítulo, quando cada um saiu, onde o site diz.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub dates: BTreeMap<String, i64>,
    /// Quando a verificação achou `latest` pela primeira vez: para sites que não dão data.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latest_since: Option<i64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stored {
    #[serde(default)]
    pub checks: BTreeMap<String, SourceCheck>,
    #[serde(default)]
    pub announced: BTreeMap<String, f64>,
    #[serde(default)]
    pub last_run: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ntfy_topic: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkUpdate {
    pub work_id: String,
    pub latest: f64,
    pub url: String,
    pub site: String,
    pub checked_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub date: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub since: Option<i64>,
}

impl WorkUpdate {
    pub fn is_recent(&self) -> bool {
        self.date.or(self.since).is_some_and(|out| now_ms() - out <= NEW_FOR_MS)
    }

    /// Quando o capítulo saiu, até onde se sabe, para pôr o histórico em ordem.
    pub fn out_at(&self) -> i64 {
        self.date.or(self.since).unwrap_or(self.checked_at)
    }
}

fn path() -> PathBuf {
    data_dir().join("updates.json")
}

pub fn load() -> Stored {
    read_json(&path())
}

pub fn change(f: impl FnOnce(&mut Stored)) -> anyhow::Result<Stored> {
    let _guard = LOCK.lock();
    let mut s = load();
    f(&mut s);
    write_json(&path(), &s)?;
    Ok(s)
}

/// As datas dos capítulos de uma obra em todos os sites: a mais antiga em que cada um foi visto.
pub fn work_dates(sources: &[String], checks: &BTreeMap<String, SourceCheck>) -> BTreeMap<String, i64> {
    let mut dates: BTreeMap<String, i64> = BTreeMap::new();
    for check in sources.iter().filter_map(|s| checks.get(s)) {
        for (chapter, date) in &check.dates {
            dates.entry(chapter.clone()).and_modify(|d| *d = (*d).min(*date)).or_insert(*date);
        }
    }
    dates
}

fn number_key(n: f64) -> String {
    if n.fract() == 0.0 { format!("{}", n as i64) } else { format!("{n}") }
}

/// O capítulo mais novo de cada obra em qualquer um dos sites dela.
pub fn work_updates(works: &[Work], checks: &BTreeMap<String, SourceCheck>) -> BTreeMap<String, WorkUpdate> {
    let mut updates: BTreeMap<String, WorkUpdate> = BTreeMap::new();
    for work in works {
        for source in work.sources() {
            let Some(check) = checks.get(source) else { continue };
            let (Some(latest), Some(url)) = (check.latest, check.latest_url.clone()) else { continue };
            if updates.get(&work.id).is_some_and(|u| u.latest >= latest) {
                continue;
            }
            let date = work_dates(work.sources(), checks).get(&number_key(latest)).copied();
            let site = url::Url::parse(source).ok().and_then(|u| u.host_str().map(|h| h.trim_start_matches("www.").to_string())).unwrap_or_default();
            updates.insert(
                work.id.clone(),
                WorkUpdate { work_id: work.id.clone(), latest, url, site, checked_at: check.checked_at, date, since: check.latest_since },
            );
        }
    }
    updates
}

/// As novidades depois do último capítulo lido de cada obra.
pub fn unread() -> Vec<WorkUpdate> {
    let records = reading::list();
    work_updates(&list_works(), &load().checks)
        .into_values()
        .filter(|u| {
            let read = records.iter().filter(|r| r.work_id == u.work_id && r.status == Status::Read).map(|r| r.chapter).fold(f64::MIN, f64::max);
            read == f64::MIN || u.latest > read
        })
        .collect()
}

/// Grava o resultado de uma verificação, guardando as datas já vistas e quando o capítulo apareceu.
pub fn record_check(source: &str, mut check: SourceCheck) -> anyhow::Result<()> {
    change(|s| {
        if let Some(before) = s.checks.get(source) {
            for (k, v) in &before.dates {
                check.dates.insert(k.clone(), *v);
            }
            check.latest_since = match (check.latest, before.latest) {
                (Some(now), Some(then)) if now > then => Some(now_ms()),
                (Some(now), Some(then)) if now == then => before.latest_since,
                _ => None,
            };
        }
        s.checks.insert(source.to_string(), check);
    })?;
    Ok(())
}
