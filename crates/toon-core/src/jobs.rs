//! A fila de capítulos para traduzir ou baixar, pedidos no PC ou no celular, em
//! `remote-jobs/jobs.json`. Os de uma mesma obra ficam juntos e na ordem dos capítulos.

use std::path::PathBuf;

use anyhow::bail;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::names::parse_chapter_name;
use crate::paths::data_dir;
use crate::store::{read_json, write_atomic, write_json};
use crate::now_ms;

/// Pedidos terminados ficam na lista por uma semana.
const KEEP_DONE_DAYS: i64 = 7;

static LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Queued,
    Running,
    Done,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Link,
    Pdf,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Progress {
    pub done: u32,
    pub total: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Batch {
    pub work: String,
    pub chapter: f64,
    pub site: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub download: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: String,
    pub kind: Kind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    pub name: String,
    pub device: String,
    pub created_at: i64,
    pub status: Status,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub progress: Option<Progress>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entry_id: Option<String>,
    pub updated_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub batch: Option<Batch>,
    /// As opções de tradução escolhidas para este pedido (as do `settings.json` quando não há).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<Map<String, Value>>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Queue {
    #[serde(default)]
    pub jobs: Vec<Job>,
    #[serde(default)]
    pub paused: bool,
}

fn dir() -> PathBuf {
    data_dir().join("remote-jobs")
}

fn list_path() -> PathBuf {
    dir().join("jobs.json")
}

pub fn pdf_path(id: &str) -> PathBuf {
    dir().join(format!("{id}.pdf"))
}

/// A fila, sem os terminados há mais de uma semana. Um PDF com nome de capítulo ganha a obra e o número.
pub fn queue() -> Queue {
    let stored: Queue = read_json(&list_path());
    let old = now_ms() - KEEP_DONE_DAYS * 86_400_000;
    let jobs = stored
        .jobs
        .into_iter()
        .filter(|j| matches!(j.status, Status::Queued | Status::Running) || j.updated_at > old)
        .map(with_work)
        .collect();
    Queue { jobs, paused: stored.paused }
}

fn with_work(mut job: Job) -> Job {
    if job.kind == Kind::Pdf && job.batch.is_none() {
        let parsed = parse_chapter_name(&job.name, None);
        if let (false, Some(chapter)) = (parsed.work.is_empty(), parsed.chapter) {
            job.batch = Some(Batch { work: parsed.work, chapter, site: "pdf".into(), download: false });
        }
    }
    job
}

fn save(queue: &Queue) -> anyhow::Result<()> {
    write_json(&list_path(), queue)
}

fn change(f: impl FnOnce(&mut Queue) -> anyhow::Result<()>) -> anyhow::Result<Queue> {
    let _guard = LOCK.lock();
    let mut q = queue();
    f(&mut q)?;
    save(&q)?;
    Ok(q)
}

pub fn pause(paused: bool) -> anyhow::Result<Queue> {
    change(|q| {
        q.paused = paused;
        Ok(())
    })
}

/// Opções de tradução vindas de fora (o celular): só os campos conhecidos, nos limites de sempre.
pub fn clean_options(raw: &Value) -> Option<Map<String, Value>> {
    let r = raw.as_object()?;
    let mut out = Map::new();
    for key in ["activeProfileId", "sourceLanguage", "targetLanguage"] {
        if let Some(v) = r.get(key).filter(|v| v.is_string()) {
            out.insert(key.into(), v.clone());
        }
    }
    let number = |k: &str, lo: f64, hi: f64| r.get(k).and_then(Value::as_f64).map(|n| Value::from(n.round().clamp(lo, hi) as i64));
    for (k, lo, hi) in [("concurrency", 1.0, 8.0), ("skipStart", 0.0, 50.0), ("skipEnd", 0.0, 50.0)] {
        if let Some(v) = number(k, lo, hi) {
            out.insert(k.into(), v);
        }
    }
    let choice = |k: &str, allowed: &[&str]| r.get(k).and_then(Value::as_str).filter(|v| allowed.contains(v)).map(|v| Value::from(v));
    for (k, allowed) in [
        ("speed", &["fast", "balanced", "quality"][..]),
        ("contentType", &["auto", "comic", "novel"][..]),
        ("gpuSharing", &["auto", "phased", "together"][..]),
        ("aiDevice", &["gpu", "cpu"][..]),
        ("visionDevice", &["gpu", "cpu"][..]),
    ] {
        if let Some(v) = choice(k, allowed) {
            out.insert(k.into(), v);
        }
    }
    for k in ["translateSfx", "reuseLayers"] {
        if let Some(v) = r.get(k).filter(|v| v.is_boolean()) {
            out.insert(k.into(), v.clone());
        }
    }
    (!out.is_empty()).then_some(out)
}

pub struct BatchChapter {
    pub chapter: f64,
    pub url: String,
}

/// Uma faixa de capítulos de uma obra, na fila na ordem dos números.
pub fn add_batch(
    work: &str,
    site: &str,
    chapters: &[BatchChapter],
    download: bool,
    device: &str,
    options: Option<Map<String, Value>>,
) -> anyhow::Result<Queue> {
    let clean = work.trim();
    if clean.is_empty() {
        bail!("Informe o nome da obra.");
    }
    if chapters.is_empty() {
        bail!("Nenhum capítulo nessa faixa.");
    }
    let now = now_ms();
    change(|q| {
        for (i, c) in chapters.iter().enumerate() {
            q.jobs.push(Job {
                id: uuid::Uuid::new_v4().to_string(),
                kind: Kind::Link,
                url: Some(c.url.clone()),
                name: format!("{clean} Chapter {}", number_text(c.chapter)),
                device: device.into(),
                created_at: now + i as i64,
                updated_at: now + i as i64,
                status: Status::Queued,
                message: None,
                progress: None,
                entry_id: None,
                batch: Some(Batch { work: clean.into(), chapter: c.chapter, site: site.into(), download }),
                options: if download { None } else { options.clone() },
            });
        }
        q.jobs = in_chapter_order(std::mem::take(&mut q.jobs), clean);
        Ok(())
    })
}

/// 79 → "79", 340.5 → "340.5".
pub fn number_text(n: f64) -> String {
    if n.fract() == 0.0 { format!("{}", n as i64) } else { format!("{n}") }
}

pub fn set_options(options: Option<Map<String, Value>>, ids: Option<&[String]>) -> anyhow::Result<Queue> {
    change(|q| {
        for j in q.jobs.iter_mut().filter(|j| j.status == Status::Queued && ids.is_none_or(|ids| ids.contains(&j.id))) {
            j.options = options.clone();
        }
        Ok(())
    })
}

/// Tira da fila as faixas ainda não começadas.
pub fn clear_batch() -> anyhow::Result<Queue> {
    change(|q| {
        for j in q.jobs.iter().filter(|j| j.batch.is_some() && j.status == Status::Queued && j.kind == Kind::Pdf) {
            let _ = std::fs::remove_file(pdf_path(&j.id));
        }
        q.jobs.retain(|j| !(j.batch.is_some() && j.status == Status::Queued));
        Ok(())
    })
}

/// Os que falharam voltam para a fila (esses, ou todos os das faixas).
pub fn retry(ids: Option<&[String]>) -> anyhow::Result<Queue> {
    change(|q| {
        let again = |j: &Job| j.status == Status::Failed && j.kind == Kind::Link && ids.map_or(j.batch.is_some(), |ids| ids.contains(&j.id));
        let works: Vec<String> = q.jobs.iter().filter(|j| again(j)).filter_map(|j| j.batch.as_ref().map(|b| b.work.clone())).collect();
        let now = now_ms();
        for j in q.jobs.iter_mut().filter(|j| again(j)) {
            j.status = Status::Queued;
            j.message = None;
            j.progress = None;
            j.updated_at = now;
        }
        for w in works {
            q.jobs = in_chapter_order(std::mem::take(&mut q.jobs), &w);
        }
        Ok(())
    })
}

/// Os capítulos na fila de uma obra ficam juntos, na ordem dos números, onde estava o primeiro deles.
fn in_chapter_order(jobs: Vec<Job>, work: &str) -> Vec<Job> {
    let key = work.to_lowercase();
    let of_work = |j: &Job| j.batch.as_ref().is_some_and(|b| b.work.to_lowercase() == key);
    let queued: Vec<&Job> = jobs.iter().filter(|j| j.status == Status::Queued).collect();
    let Some(first) = queued.iter().position(|j| of_work(j)) else { return jobs };
    let mut block: Vec<Job> = queued.iter().filter(|j| of_work(j)).map(|j| (*j).clone()).collect();
    block.sort_by(|a, b| a.batch.as_ref().unwrap().chapter.total_cmp(&b.batch.as_ref().unwrap().chapter));
    let rest: Vec<Job> = queued.iter().filter(|j| !of_work(j)).map(|j| (*j).clone()).collect();
    let before = queued[..first].iter().filter(|j| !of_work(j)).count();
    let mut order = rest[..before].to_vec();
    order.extend(block);
    order.extend(rest[before..].iter().cloned());
    with_queued(jobs, order)
}

fn with_queued(jobs: Vec<Job>, queued: Vec<Job>) -> Vec<Job> {
    let mut next = queued.into_iter();
    jobs.into_iter().map(|j| if j.status == Status::Queued { next.next().unwrap_or(j) } else { j }).collect()
}

pub fn reorder(ids: &[String]) -> anyhow::Result<Queue> {
    change(|q| {
        let queued: Vec<Job> = q.jobs.iter().filter(|j| j.status == Status::Queued).cloned().collect();
        let mut order: Vec<Job> = ids.iter().filter_map(|id| queued.iter().find(|j| &j.id == id).cloned()).collect();
        order.extend(queued.into_iter().filter(|j| !ids.contains(&j.id)));
        q.jobs = with_queued(std::mem::take(&mut q.jobs), order);
        Ok(())
    })
}

pub fn sort() -> anyhow::Result<Queue> {
    change(|q| {
        let works: Vec<String> = q.jobs.iter().filter(|j| j.status == Status::Queued).filter_map(|j| j.batch.as_ref().map(|b| b.work.clone())).collect();
        for w in works {
            q.jobs = in_chapter_order(std::mem::take(&mut q.jobs), &w);
        }
        Ok(())
    })
}

fn add(mut job: Job) -> anyhow::Result<Job> {
    let now = now_ms();
    job.created_at = now;
    job.updated_at = now;
    let added = job.clone();
    change(|q| {
        q.jobs.push(job);
        Ok(())
    })?;
    Ok(added)
}

fn new_job(kind: Kind, name: String, device: &str, options: Option<Map<String, Value>>) -> Job {
    Job {
        id: uuid::Uuid::new_v4().to_string(),
        kind,
        url: None,
        name,
        device: device.into(),
        created_at: 0,
        status: Status::Queued,
        message: None,
        progress: None,
        entry_id: None,
        updated_at: 0,
        batch: None,
        options,
    }
}

pub fn add_link(url: &str, device: &str, options: Option<Map<String, Value>>) -> anyhow::Result<Job> {
    let parsed = url::Url::parse(url)?;
    if !matches!(parsed.scheme(), "http" | "https") {
        bail!("Só links http ou https.");
    }
    let mut job = new_job(Kind::Link, format!("{}{}", parsed.host_str().unwrap_or(""), parsed.path()), device, options);
    job.url = Some(url.into());
    add(job)
}

pub fn add_pdf(name: &str, pdf: &[u8], device: &str, options: Option<Map<String, Value>>) -> anyhow::Result<Job> {
    if !pdf.starts_with(b"%PDF-") {
        bail!("O arquivo enviado não é um PDF.");
    }
    let clean: String = name.trim().chars().map(|c| if "\\/:*?\"<>|".contains(c) { ' ' } else { c }).collect();
    let clean = if clean.is_empty() { "capitulo.pdf".to_string() } else { clean };
    let name = if clean.to_lowercase().ends_with(".pdf") { clean } else { format!("{clean}.pdf") };
    let job = with_work(new_job(Kind::Pdf, name, device, options));
    std::fs::create_dir_all(dir())?;
    write_atomic(&pdf_path(&job.id), pdf)?;
    add(job)
}

/// O próximo da fila, marcado como em andamento; `None` quando a fila está pausada ou vazia.
pub fn take() -> Option<(Job, Option<Vec<u8>>)> {
    let _guard = LOCK.lock();
    let mut q = queue();
    if q.paused {
        return None;
    }
    let at = q.jobs.iter().position(|j| j.status == Status::Queued)?;
    let job = &mut q.jobs[at];
    job.status = Status::Running;
    job.message = Some("Começando".into());
    job.updated_at = now_ms();
    let job = job.clone();
    save(&q).ok()?;
    drop(_guard);
    if job.kind == Kind::Pdf {
        match std::fs::read(pdf_path(&job.id)) {
            Ok(pdf) => return Some((job, Some(pdf))),
            Err(_) => {
                let _ = update(&job.id, Update { status: Some(Status::Failed), message: Some("O PDF enviado sumiu do PC.".into()), ..Default::default() });
                return None;
            }
        }
    }
    Some((job, None))
}

#[derive(Default)]
pub struct Update {
    pub status: Option<Status>,
    pub message: Option<String>,
    pub entry_id: Option<String>,
    pub progress: Option<Progress>,
}

pub fn update(id: &str, patch: Update) -> anyhow::Result<Queue> {
    change(|q| {
        if let Some(j) = q.jobs.iter_mut().find(|j| j.id == id) {
            if let Some(s) = patch.status {
                j.status = s;
                if s != Status::Running {
                    j.progress = None;
                }
                if s == Status::Done {
                    let _ = std::fs::remove_file(pdf_path(&j.id));
                }
            }
            if patch.message.is_some() {
                j.message = patch.message;
            }
            if patch.entry_id.is_some() {
                j.entry_id = patch.entry_id;
            }
            if patch.progress.is_some() {
                j.progress = patch.progress;
            }
            j.updated_at = now_ms();
        }
        Ok(())
    })
}

/// Um pedido ainda na fila sai dela (um em andamento é parado por quem roda a fila).
pub fn cancel(id: &str) -> anyhow::Result<Queue> {
    change(|q| {
        q.jobs.retain(|j| !(j.id == id && j.status == Status::Queued));
        let _ = std::fs::remove_file(pdf_path(id));
        Ok(())
    })
}

/// Pedidos que ficaram "em andamento" quando o app fechou voltam para a fila.
pub fn requeue_interrupted() -> anyhow::Result<Queue> {
    change(|q| {
        for j in q.jobs.iter_mut().filter(|j| j.status == Status::Running) {
            j.status = Status::Queued;
            j.progress = None;
            j.message = None;
        }
        Ok(())
    })
}
