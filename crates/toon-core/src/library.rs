//! A biblioteca em disco: `library/works.json` com as obras e uma pasta por capítulo, com `meta.json`,
//! `original.pdf`, `translated.pdf` e `cover.jpg`.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

use anyhow::{Context, bail};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::names::{clean_work_name, normalize_name, parse_chapter_name, same_name, source_key};
use crate::paths::{checked_id, library_dir};
use crate::store::{read_json, write_atomic, write_json};
use crate::works::{
    Auto, CatalogCheck, Format, MAX_SOURCES, Shelf, Work, WorkInfo, find_work, with_name,
};
use crate::{now_ms, reading};

/// O modelo anotado num capítulo salvo como o site tinha (já no idioma lido).
pub const DOWNLOADED_MODEL: &str = "baixado sem tradução";

/// Uma escrita por vez em `works.json` e nos `meta.json`: a janela, o servidor do celular e a fila
/// mexem nos mesmos arquivos.
pub(crate) static LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: String,
    pub title: String,
    pub file_name: String,
    pub created_at: i64,
    pub page_count: u32,
    pub translated_pages: u32,
    pub source_language: String,
    pub target_language: String,
    pub model: String,
    #[serde(default)]
    pub work_id: String,
    #[serde(default)]
    pub chapter: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Entry {
    pub fn downloaded(&self) -> bool {
        self.model == DOWNLOADED_MODEL
    }

    pub fn dir(&self) -> PathBuf {
        library_dir().join(&self.id)
    }

    pub fn pdf(&self, translated: bool) -> PathBuf {
        self.dir().join(if translated {
            "translated.pdf"
        } else {
            "original.pdf"
        })
    }
}

#[derive(Default, Serialize, Deserialize)]
struct WorksFile {
    #[serde(default)]
    works: Vec<Work>,
}

fn works_path() -> PathBuf {
    library_dir().join("works.json")
}

pub fn list_works() -> Vec<Work> {
    read_json::<WorksFile>(&works_path()).works
}

fn save_works(works: &[Work]) -> anyhow::Result<()> {
    #[derive(Serialize)]
    struct Out<'a> {
        works: &'a [Work],
    }
    write_json(&works_path(), &Out { works })
}

/// Muda as obras dentro da trava e grava.
fn change_works(f: impl FnOnce(&mut Vec<Work>) -> anyhow::Result<()>) -> anyhow::Result<Vec<Work>> {
    let _guard = LOCK.lock();
    let mut works = list_works();
    f(&mut works)?;
    save_works(&works)?;
    Ok(works)
}

/// A obra de um capítulo chamado `name`, criada se nenhum nome conhecido bate; aprende o nome.
pub fn index_work(name: &str, format: Format, volumes: bool) -> anyhow::Result<String> {
    let clean = match clean_work_name(name) {
        n if n.is_empty() => "Sem nome".to_string(),
        n => n,
    };
    let mut id = String::new();
    change_works(|works| {
        if let Some(found) = find_work(works, &clean, format) {
            id = found.id.clone();
            let at = works.iter().position(|w| w.id == id).unwrap();
            works[at] = with_name(works[at].clone(), &clean);
        } else {
            id = uuid::Uuid::new_v4().to_string();
            works.push(Work {
                id: id.clone(),
                names: vec![clean.clone()],
                created_at: now_ms(),
                format: (format == Format::Novel).then(|| "novel".into()),
                unit: volumes.then(|| "volume".into()),
                ..Default::default()
            });
        }
        Ok(())
    })?;
    Ok(id)
}

pub fn read_meta(id: &str) -> anyhow::Result<Entry> {
    let path = library_dir().join(checked_id(id)?).join("meta.json");
    let bytes = fs::read(&path).with_context(|| format!("lendo {}", path.display()))?;
    Ok(serde_json::from_slice(&bytes)?)
}

fn write_meta(meta: &Entry) -> anyhow::Result<()> {
    write_json(
        &library_dir().join(checked_id(&meta.id)?).join("meta.json"),
        meta,
    )
}

/// Os capítulos da biblioteca, os mais novos primeiro. Capítulos antigos sem obra ou sem número são
/// completados na primeira vez que aparecem.
pub fn list_library() -> Vec<Entry> {
    let Ok(dirs) = fs::read_dir(library_dir()) else {
        return Vec::new();
    };
    let mut entries = Vec::new();
    for dir in dirs.flatten() {
        let id = dir.file_name().to_string_lossy().into_owned();
        if !dir.path().join("meta.json").exists() {
            continue;
        }
        // Um capítulo salvo pela metade (app fechado no meio) fica de fora.
        let Ok(mut meta) = read_meta(&id) else {
            continue;
        };
        let parsed = || parse_chapter_name(&meta.file_name, meta.source.as_deref());
        if meta.work_id.is_empty() {
            let p = parsed();
            if let Ok(work_id) = index_work(&p.work, Format::Comic, false) {
                meta.work_id = work_id;
                meta.chapter = p.chapter;
                let _ = write_meta(&meta);
            }
        } else if meta.chapter.is_none()
            && let Some(n) = parsed().chapter
        {
            meta.chapter = Some(n);
            let _ = write_meta(&meta);
        }
        entries.push(meta);
    }
    entries.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    entries
}

pub fn cover_of(id: &str) -> Option<Vec<u8>> {
    fs::read(library_dir().join(checked_id(id).ok()?).join("cover.jpg")).ok()
}

pub struct SaveInput<'a> {
    pub file_name: &'a str,
    pub source: Option<&'a str>,
    pub page_count: u32,
    pub translated_pages: u32,
    pub original: &'a [u8],
    pub translated: &'a [u8],
    pub cover_jpeg: &'a [u8],
    /// Baixado como estava, já no idioma lido.
    pub downloaded: bool,
    /// Uma novel traduzida do texto: fica numa obra de novel, longe do mangá de mesmo nome.
    pub novel: bool,
    pub source_language: &'a str,
    pub target_language: &'a str,
    pub model: &'a str,
}

/// Salva um capítulo. O mesmo capítulo baixado de novo do mesmo site substitui o antigo, a não ser
/// que venha com bem menos páginas (um leitor que abriu no fim): aí os dois ficam.
pub fn save_to_library(input: SaveInput) -> anyhow::Result<Entry> {
    let id = uuid::Uuid::new_v4().to_string();
    let dir = library_dir().join(&id);
    fs::create_dir_all(&dir)?;
    fs::write(dir.join("original.pdf"), input.original)?;
    fs::write(dir.join("translated.pdf"), input.translated)?;
    fs::write(dir.join("cover.jpg"), input.cover_jpeg)?;
    let parsed = parse_chapter_name(input.file_name, input.source);
    let format = if input.novel {
        Format::Novel
    } else {
        Format::Comic
    };
    let volumes = input.novel && crate::names::is_volume_name(input.file_name);
    let meta = Entry {
        id: id.clone(),
        title: input
            .file_name
            .trim_end_matches(".pdf")
            .trim_end_matches(".PDF")
            .to_string(),
        file_name: input.file_name.to_string(),
        created_at: now_ms(),
        page_count: input.page_count,
        translated_pages: input.translated_pages,
        source_language: if input.downloaded {
            input.target_language
        } else {
            input.source_language
        }
        .to_string(),
        target_language: input.target_language.to_string(),
        model: if input.downloaded {
            DOWNLOADED_MODEL
        } else {
            input.model
        }
        .to_string(),
        work_id: index_work(&parsed.work, format, volumes)?,
        chapter: parsed.chapter,
        source: input.source.map(str::to_string),
        extra: Map::new(),
    };
    // O meta.json vai por último: um capítulo salvo pela metade nunca aparece na lista.
    write_meta(&meta)?;
    let site = host_of(meta.source.as_deref());
    if !site.is_empty() && meta.chapter.is_some() {
        for old in list_library() {
            let shorter =
                old.page_count > 0 && (meta.page_count as f64) < old.page_count as f64 * 0.6;
            if old.id != id
                && old.work_id == meta.work_id
                && old.chapter == meta.chapter
                && host_of(old.source.as_deref()) == site
                && !shorter
            {
                delete_from_library(&old.id)?;
            }
        }
    }
    Ok(meta)
}

pub fn delete_from_library(id: &str) -> anyhow::Result<()> {
    let dir = library_dir().join(checked_id(id)?);
    if dir.exists() {
        fs::remove_dir_all(dir)?;
    }
    Ok(())
}

fn host_of(url: Option<&str>) -> String {
    url.and_then(|u| url::Url::parse(u).ok())
        .and_then(|u| {
            u.host_str()
                .map(|h| h.trim_start_matches("www.").to_string())
        })
        .unwrap_or_default()
}

// --- Obras ------------------------------------------------------------------------------------------

fn work_cover_path(work_id: &str) -> anyhow::Result<PathBuf> {
    Ok(library_dir()
        .join("work-covers")
        .join(format!("{}.jpg", checked_id(work_id)?)))
}

pub fn work_cover(work_id: &str) -> Option<Vec<u8>> {
    fs::read(work_cover_path(work_id).ok()?).ok()
}

pub fn save_work_cover(work_id: &str, jpeg: &[u8]) -> anyhow::Result<()> {
    write_atomic(&work_cover_path(work_id)?, jpeg)
}

/// Troca os nomes da obra (o primeiro aparece); um nome que outra obra do mesmo formato tinha passa
/// para esta.
pub fn set_work_names(work_id: &str, names: &[String], by_hand: bool) -> anyhow::Result<Vec<Work>> {
    let mut clean: Vec<String> = Vec::new();
    for n in names.iter().map(|n| n.trim()).filter(|n| !n.is_empty()) {
        if !clean.iter().any(|c| normalize_name(c) == normalize_name(n)) {
            clean.push(n.to_string());
        }
    }
    if clean.is_empty() {
        bail!("A obra precisa de pelo menos um nome.");
    }
    let keys: Vec<String> = clean.iter().map(|n| normalize_name(n)).collect();
    change_works(|works| {
        let format = works
            .iter()
            .find(|w| w.id == work_id)
            .map(Work::format)
            .unwrap_or_default();
        for w in works.iter_mut() {
            if w.id == work_id {
                w.names = clean.clone();
                w.named_by_hand |= by_hand;
            } else if w.format() == format {
                w.names.retain(|n| !keys.contains(&normalize_name(n)));
            }
        }
        Ok(())
    })
}

pub fn set_work_shelf(
    work_id: &str,
    shelf: Option<Option<Shelf>>,
    favorite: Option<bool>,
) -> anyhow::Result<Vec<Work>> {
    change_works(|works| {
        if let Some(w) = works.iter_mut().find(|w| w.id == work_id) {
            if let Some(shelf) = shelf {
                w.shelf = shelf;
            }
            if let Some(favorite) = favorite {
                w.favorite = favorite;
            }
        }
        Ok(())
    })
}

pub fn set_work_auto(work_id: &str, auto: Option<Auto>) -> anyhow::Result<Vec<Work>> {
    change_works(|works| {
        if let Some(w) = works.iter_mut().find(|w| w.id == work_id) {
            w.auto = auto;
        }
        Ok(())
    })
}

pub fn set_work_volumes(work_id: &str, volumes: bool) -> anyhow::Result<Vec<Work>> {
    change_works(|works| {
        if let Some(w) = works.iter_mut().find(|w| w.id == work_id) {
            w.unit = volumes.then(|| "volume".into());
        }
        Ok(())
    })
}

/// Uma obra esperando ("Quero ler", "Pausado") que voltou a ser lida volta para "Lendo".
pub fn started_reading(work_id: &str) {
    let waiting = list_works()
        .iter()
        .any(|w| w.id == work_id && matches!(w.shelf, Some(Shelf::Plan | Shelf::Paused)));
    if waiting {
        let _ = set_work_shelf(work_id, Some(Some(Shelf::Reading)), None);
    }
}

/// As páginas da obra nos sites, onde se procuram capítulos novos.
pub fn save_work_sources(work_id: &str, sources: Vec<String>) -> anyhow::Result<Vec<Work>> {
    change_works(|works| {
        if let Some(w) = works.iter_mut().find(|w| w.id == work_id) {
            w.sources = (!sources.is_empty()).then_some(sources);
        }
        Ok(())
    })?;
    merge_duplicate_works()
}

/// A obra recebe a página `source` de um site, a não ser que já tenha uma lá (ou já tenha o máximo).
pub fn add_work_source_to(work_id: &str, source: &str) -> anyhow::Result<()> {
    let site = host_of(Some(source));
    change_works(|works| {
        if let Some(w) = works.iter_mut().find(|w| w.id == work_id) {
            let list = w.sources.get_or_insert_with(Vec::new);
            if !list.iter().any(|s| host_of(Some(s)) == site) && list.len() < MAX_SOURCES {
                list.push(source.to_string());
            }
        }
        Ok(())
    })?;
    merge_duplicate_works()?;
    Ok(())
}

/// A obra chamada `name` (criada se for nova) recebe `source` na frente das páginas que já tinha.
pub fn add_work_source(name: &str, source: &str) -> anyhow::Result<()> {
    let id = index_work(name, Format::Comic, false)?;
    change_works(|works| {
        if let Some(w) = works.iter_mut().find(|w| w.id == id) {
            let list = w.sources.get_or_insert_with(Vec::new);
            if !list.iter().any(|s| s == source) {
                list.insert(0, source.to_string());
                list.truncate(MAX_SOURCES);
            }
        }
        Ok(())
    })?;
    merge_duplicate_works()?;
    Ok(())
}

pub struct CatalogFound {
    pub title: Option<String>,
    pub names: Vec<String>,
    pub sources: Vec<String>,
    pub sites: Vec<String>,
    pub cover: Option<Vec<u8>>,
    pub info: Option<WorkInfo>,
}

/// O que os sites de catálogo sabem da obra: nomes que nenhuma outra obra do mesmo tipo tem, as
/// páginas dela (depois das escolhidas à mão, até o limite), capa e, quando vem, a ficha do site.
pub fn apply_catalog(work_id: &str, found: CatalogFound) -> anyhow::Result<Vec<Work>> {
    if let Some(cover) = &found.cover {
        save_work_cover(work_id, cover)?;
    }
    change_works(|works| {
        let Some(at) = works.iter().position(|w| w.id == work_id) else {
            bail!("Obra não encontrada.")
        };
        let format = works[at].format();
        let taken: Vec<String> = works
            .iter()
            .filter(|w| w.id != work_id && w.format() == format)
            .flat_map(|w| w.names.iter().map(|n| normalize_name(n)))
            .collect();
        // Nomes muito curtos ("Item") pegariam capítulos de outras obras.
        let mut work = works[at].clone();
        for n in found.names.iter().filter(|n| {
            let k = normalize_name(n);
            k.chars().count() >= 4 && !taken.contains(&k)
        }) {
            work = with_name(work, n);
        }
        let mut sources = work.sources.clone().unwrap_or_default();
        for s in &found.sources {
            if !sources.contains(s) {
                sources.push(s.clone());
            }
        }
        sources.truncate(MAX_SOURCES);
        work.sources = (!sources.is_empty()).then_some(sources);
        let mut sites = work
            .catalog
            .as_ref()
            .map(|c| c.sites.clone())
            .unwrap_or_default();
        for s in &found.sites {
            if !sites.contains(s) {
                sites.push(s.clone());
            }
        }
        work.catalog = Some(CatalogCheck {
            checked_at: now_ms(),
            sites,
        });
        if let Some(info) = &found.info {
            // O nome do site vai na frente quando é um dos nomes da obra e ninguém escolheu outro.
            if let Some(title) = found.title.as_deref().filter(|_| !work.named_by_hand)
                && let Some(i) = work.names.iter().position(|n| same_name(n, title))
            {
                work.names.remove(i);
                work.names.insert(0, title.to_string());
            }
            work.info = Some(info.clone());
        }
        works[at] = work;
        Ok(())
    })?;
    merge_duplicate_works()
}

/// Obras salvas duas vezes (mesmo tipo, uma página em comum) viram uma: a que está numa lista ou é
/// favorita recebe os capítulos, nomes, páginas e leituras da outra; senão, a mais antiga.
pub fn merge_duplicate_works() -> anyhow::Result<Vec<Work>> {
    for _ in 0..50 {
        let works = list_works();
        let mut ranked: Vec<&Work> = works.iter().collect();
        ranked.sort_by(|a, b| {
            let listed = |w: &Work| (w.shelf.is_some() || w.favorite) as u8;
            listed(b)
                .cmp(&listed(a))
                .then(a.created_at.cmp(&b.created_at))
        });
        let mut owner: HashMap<String, &Work> = HashMap::new();
        let mut pair = None;
        'find: for w in &ranked {
            for s in w.sources() {
                let key = format!("{:?}|{}", w.format(), source_key(s));
                match owner.get(&key) {
                    Some(into) if into.id != w.id => {
                        pair = Some((into.id.clone(), w.id.clone()));
                        break 'find;
                    }
                    _ => {
                        owner.insert(key, w);
                    }
                }
            }
        }
        let Some((into, from)) = pair else {
            return Ok(works);
        };
        merge_works(&into, &from)?;
    }
    Ok(list_works())
}

/// Passa todos os capítulos de `from_id` para `into_id`, que fica também com os nomes e as páginas.
pub fn merge_works(into_id: &str, from_id: &str) -> anyhow::Result<Vec<Work>> {
    if into_id == from_id {
        return Ok(list_works());
    }
    for mut entry in list_library().into_iter().filter(|e| e.work_id == from_id) {
        entry.work_id = into_id.to_string();
        write_meta(&entry)?;
    }
    let works = change_works(|works| {
        let Some(from) = works
            .iter()
            .position(|w| w.id == from_id)
            .map(|i| works.remove(i))
        else {
            return Ok(());
        };
        if let Some(w) = works.iter_mut().find(|w| w.id == into_id) {
            let mut merged = w.clone();
            for n in &from.names {
                merged = with_name(merged, n);
            }
            let mut sources = merged.sources.clone().unwrap_or_default();
            for s in from.sources() {
                if !sources.contains(s) {
                    sources.push(s.clone());
                }
            }
            sources.truncate(MAX_SOURCES);
            merged.sources = (!sources.is_empty()).then_some(sources);
            merged.shelf = merged.shelf.or(from.shelf);
            merged.favorite |= from.favorite;
            *w = merged;
        }
        Ok(())
    })?;
    reading::move_reading(from_id, into_id)?;
    if let (Some(cover), None) = (work_cover(from_id), work_cover(into_id)) {
        save_work_cover(into_id, &cover)?;
    }
    Ok(works)
}

pub enum MoveTarget {
    Work(String),
    New(String),
}

/// Põe um capítulo em outra obra (ou numa nova); a obra de destino aprende o nome em que o capítulo
/// foi encontrado, e o próximo capítulo com esse nome cai lá sozinho.
pub fn move_to_work(entry_id: &str, target: MoveTarget) -> anyhow::Result<Vec<Work>> {
    let mut meta = read_meta(entry_id)?;
    let found = parse_chapter_name(&meta.file_name, meta.source.as_deref()).work;
    let key = normalize_name(&found);
    let mut work_id = String::new();
    let works = change_works(|works| {
        work_id = match &target {
            MoveTarget::Work(id) => id.clone(),
            MoveTarget::New(name) => {
                let id = uuid::Uuid::new_v4().to_string();
                let name = if name.trim().is_empty() {
                    found.clone()
                } else {
                    name.trim().to_string()
                };
                works.push(Work {
                    id: id.clone(),
                    names: vec![name],
                    created_at: now_ms(),
                    ..Default::default()
                });
                id
            }
        };
        for w in works.iter_mut() {
            if w.id == work_id {
                *w = with_name(w.clone(), &found);
            } else if w.format() == Format::Comic && w.names.len() > 1 {
                w.names.retain(|n| normalize_name(n) != key);
            }
        }
        Ok(())
    })?;
    meta.work_id = work_id;
    write_meta(&meta)?;
    Ok(works)
}

/// A obra apagada de vez: capítulos, leitura, capa e a própria obra.
pub fn delete_work(work_id: &str) -> anyhow::Result<Vec<Work>> {
    for entry in list_library().into_iter().filter(|e| e.work_id == work_id) {
        delete_from_library(&entry.id)?;
    }
    reading::forget(work_id, None)?;
    let _ = fs::remove_file(work_cover_path(work_id)?);
    change_works(|works| {
        works.retain(|w| w.id != work_id);
        Ok(())
    })
}
