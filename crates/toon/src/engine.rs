//! O que roda por trás da janela: a fila de capítulos, a verificação de capítulos novos e o servidor
//! do celular e da extensão.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use parking_lot::Mutex;
use serde_json::{Value, json};
use toon_ai::Cancel;
use toon_core::jobs::{self, Job, Kind, Progress, Status, Update};
use toon_core::library::{self, SaveInput};
use toon_core::settings;
use toon_core::updates::{self, SourceCheck};
use toon_page::chapter::{self, Options};
use toon_web::catalog::{self, Site};

/// De quanto em quanto tempo os sites das obras são verificados.
const CHECK_EVERY: Duration = Duration::from_secs(3 * 60 * 60);
const BETWEEN_SITES: Duration = Duration::from_secs(4);

/// O estado compartilhado entre a janela, a fila e o servidor.
#[derive(Default)]
pub struct Engine {
    /// O pedido em andamento e como pará-lo.
    running: Mutex<Option<(String, Cancel)>>,
    checking: Mutex<bool>,
    /// Algo mudou por fora (fila, biblioteca): a janela lê de novo.
    pub dirty: Mutex<bool>,
    /// O que aconteceu por último, para a barra de status.
    pub status: Mutex<String>,
    /// Quando cada obra sem capa foi procurada por uma (nesta abertura do app).
    pub covers_tried: Mutex<HashMap<String, i64>>,
}

impl Engine {
    pub fn touch(&self) {
        *self.dirty.lock() = true;
    }

    pub fn say(&self, text: impl Into<String>) {
        *self.status.lock() = text.into();
        self.touch();
    }

    pub fn is_checking(&self) -> bool {
        *self.checking.lock()
    }

    pub fn cancel(&self, id: &str) {
        if let Some((running, cancel)) = self.running.lock().as_ref()
            && running == id
        {
            cancel.cancel();
        }
    }
}

/// Liga tudo: a fila, a verificação periódica e o servidor.
pub fn start(engine: Arc<Engine>, runtime: &tokio::runtime::Runtime) {
    let _ = jobs::requeue_interrupted();
    // Uma verificação de robô vira aviso, no Windows e no celular, em vez de a janela do navegador
    // pular na frente do que a pessoa está fazendo.
    let handle = runtime.handle().clone();
    toon_web::challenge::on_new(move |info| {
        crate::notify::challenge(info, &handle);
    });
    runtime.spawn(run_queue(engine.clone()));
    runtime.spawn(check_loop(engine.clone()));
    runtime.spawn(crate::cloud::run(
        toon_core::devices::internal_token().to_string(),
    ));
    let app: Arc<dyn toon_server::App> = Arc::new(ServerHooks { engine });
    runtime.spawn(async move {
        if let Err(e) = toon_server::serve(app).await {
            tracing::error!("servidor parou: {e}");
        }
    });
}

async fn run_queue(engine: Arc<Engine>) {
    loop {
        let Some((job, pdf)) = tokio::task::spawn_blocking(jobs::take).await.ok().flatten() else {
            tokio::time::sleep(Duration::from_secs(2)).await;
            continue;
        };
        engine.touch();
        let cancel = Cancel::default();
        *engine.running.lock() = Some((job.id.clone(), cancel.clone()));
        let result = run_job(&engine, &job, pdf, &cancel).await;
        *engine.running.lock() = None;
        let update = match result {
            Ok(entry_id) => {
                engine.say(format!("Pronto: {}", job.name));
                Update {
                    status: Some(Status::Done),
                    message: None,
                    entry_id: Some(entry_id),
                    progress: None,
                }
            }
            Err(e) if cancel.is_cancelled() => {
                engine.say(format!("Cancelado: {}", job.name));
                let _ = jobs::cancel(&job.id);
                Update {
                    status: Some(Status::Failed),
                    message: Some(format!("{e}")),
                    ..Default::default()
                }
            }
            Err(e) => {
                engine.say(format!("Falhou: {} ({e})", job.name));
                Update {
                    status: Some(Status::Failed),
                    message: Some(e.to_string()),
                    ..Default::default()
                }
            }
        };
        let _ = jobs::update(&job.id, update);
        engine.touch();
    }
}

fn progress(id: &str, message: &str, done: usize, total: usize) {
    let _ = jobs::update(
        id,
        Update {
            message: Some(message.into()),
            progress: Some(Progress {
                done: done as u32,
                total: total as u32,
            }),
            ..Default::default()
        },
    );
}

/// As configurações do pedido: as do PC com o que o pedido escolheu por cima.
fn settings_for(job: &Job) -> anyhow::Result<settings::Settings> {
    let mut s = serde_json::to_value(settings::load())?;
    for (k, v) in job.options.clone().unwrap_or_default() {
        s[k] = v;
    }
    Ok(serde_json::from_value(s)?)
}

/// Baixa (ou lê o PDF enviado), traduz quando é para traduzir e salva na biblioteca.
async fn run_job(
    engine: &Engine,
    job: &Job,
    pdf: Option<Vec<u8>>,
    cancel: &Cancel,
) -> anyhow::Result<String> {
    let settings = settings_for(job)?;
    let (pages, name, source) = match job.kind {
        Kind::Pdf => {
            let bytes = pdf.ok_or_else(|| anyhow::anyhow!("O PDF enviado sumiu do PC."))?;
            // Uma novel (PDF com texto) vai pela camada de texto, não pelas imagens.
            let novel = match settings.content_type {
                settings::ContentType::Novel => true,
                settings::ContentType::Comic => false,
                settings::ContentType::Auto => {
                    let probe = bytes.clone();
                    tokio::task::spawn_blocking(move || {
                        toon_page::novel::looks_like_novel(&toon_page::novel::page_texts(&probe))
                    })
                    .await
                    .unwrap_or(false)
                }
            };
            let name = job.name.trim_end_matches(".pdf").to_string();
            if novel {
                return translate_novel_job(engine, job, &settings, bytes, &name, cancel).await;
            }
            let pages =
                tokio::task::spawn_blocking(move || toon_page::pdf::read_pages(&bytes)).await??;
            (pages, name, None)
        }
        Kind::Link => {
            let url = job.url.clone().unwrap_or_default();
            let id = job.id.clone();
            let fetched = toon_web::download::fetch_chapter(&url, move |stage| {
                use toon_web::download::Stage;
                match stage {
                    Stage::Loading => progress(&id, "Abrindo o site", 0, 1),
                    Stage::Challenge => progress(
                        &id,
                        "O site pediu uma verificação: confirme na janela do navegador",
                        0,
                        1,
                    ),
                    Stage::Scrolling => progress(&id, "Lendo as páginas", 0, 1),
                    Stage::Downloading { done, total } => progress(&id, "Baixando", done, total),
                }
            })
            .await?;
            let images = fetched.images;
            let pages =
                tokio::task::spawn_blocking(move || chapter::pages_from_images(&images)).await??;
            // O nome da faixa ("Obra Chapter 12") é mais confiável que o título da página.
            let name = if job.batch.is_some() {
                job.name.clone()
            } else {
                fetched.title
            };
            (pages, name, Some(url))
        }
    };
    if pages.is_empty() {
        anyhow::bail!("O capítulo veio sem páginas.");
    }
    let download = job.batch.as_ref().is_some_and(|b| b.download);
    let file_name = format!("{name}.pdf");
    if download {
        let pages_count = pages.len();
        let saved = tokio::task::spawn_blocking(move || -> anyhow::Result<String> {
            let pdf = chapter::original_pdf(&pages, &name)?;
            let cover = chapter::cover_of(&pages[0])?;
            let target = settings.target_language.clone();
            let e = library::save_to_library(SaveInput {
                file_name: &file_name,
                source: source.as_deref(),
                page_count: pages_count as u32,
                translated_pages: pages_count as u32,
                original: &pdf,
                translated: &pdf,
                cover_jpeg: &cover,
                downloaded: true,
                novel: false,
                source_language: &target,
                target_language: &target,
                model: "",
            })?;
            Ok(e.id)
        })
        .await??;
        engine.touch();
        return Ok(saved);
    }
    let ready = Arc::new(toon_ai::ready(settings.clone())?);
    let pages = Arc::new(pages);
    let id = job.id.clone();
    let options = Options {
        skip_start: settings.skip_start as usize,
        skip_end: settings.skip_end as usize,
        // O modelo deste PC atende uma página por vez (--parallel 1): mais páginas abertas ao mesmo
        // tempo só esperam na fila dele, cada uma segurando centenas de MB de imagem (uma tira de
        // webtoon tem até 32 mil pixels de altura). Com oito, a memória acabava e o app fechava.
        concurrency: if ready.profile.id == toon_core::settings::LOCAL_AI_PROFILE_ID {
            (settings.concurrency as usize).min(2)
        } else {
            settings.concurrency as usize
        },
        chapter: name.clone(),
        layers: Some(format!(
            "{}|sfx:{}",
            settings.target_language, settings.translate_sfx
        )),
        reuse_layers: settings.reuse_layers,
    };
    let out = chapter::translate_chapter(
        ready.clone(),
        pages.clone(),
        options,
        cancel.clone(),
        move |p| {
            progress(&id, "Traduzindo", p.done, p.total);
        },
    )
    .await?;
    let model = ready.profile.model.clone();
    let count = pages.len() as u32;
    let saved = tokio::task::spawn_blocking(move || -> anyhow::Result<String> {
        let e = library::save_to_library(SaveInput {
            file_name: &file_name,
            source: source.as_deref(),
            page_count: count,
            translated_pages: out.translated_pages as u32,
            original: &out.original_pdf,
            translated: &out.translated_pdf,
            cover_jpeg: &out.cover_jpeg,
            downloaded: false,
            novel: false,
            source_language: &settings.source_language,
            target_language: &settings.target_language,
            model: &model,
        })?;
        Ok(e.id)
    })
    .await??;
    engine.touch();
    Ok(saved)
}

/// Uma novel: o texto traduzido em lotes e composto de novo, salvo numa obra de novel.
async fn translate_novel_job(
    engine: &Engine,
    job: &Job,
    settings: &settings::Settings,
    bytes: Vec<u8>,
    name: &str,
    cancel: &Cancel,
) -> anyhow::Result<String> {
    let ready = toon_ai::ready(settings.clone())?;
    let id = job.id.clone();
    let out = toon_page::novel::translate_novel(&ready, bytes, name, cancel, move |p| {
        progress(&id, "Traduzindo o texto", p.done, p.total)
    })
    .await?;
    let model = ready.profile.model.clone();
    let (file_name, settings) = (format!("{name}.pdf"), settings.clone());
    let saved = tokio::task::spawn_blocking(move || -> anyhow::Result<String> {
        let e = library::save_to_library(SaveInput {
            file_name: &file_name,
            source: None,
            page_count: out.translated_pages as u32,
            translated_pages: out.translated_pages as u32,
            original: &out.original_pdf,
            translated: &out.translated_pdf,
            cover_jpeg: &out.cover_jpeg,
            downloaded: false,
            novel: true,
            source_language: &settings.source_language,
            target_language: &settings.target_language,
            model: &model,
        })?;
        Ok(e.id)
    })
    .await??;
    engine.touch();
    Ok(saved)
}

async fn check_loop(engine: Arc<Engine>) {
    tokio::spawn(async {
        loop {
            tokio::time::sleep(Duration::from_secs(30)).await;
            toon_ai::local::stop_if_idle();
            toon_page::vision::stop_if_idle();
        }
    });
    // Espera a janela abrir antes da primeira rodada.
    tokio::time::sleep(Duration::from_secs(60)).await;
    loop {
        let due = updates::load()
            .last_run
            .is_none_or(|t| toon_core::now_ms() - t >= CHECK_EVERY.as_millis() as i64);
        if due {
            check_now(&engine).await;
        }
        tokio::time::sleep(Duration::from_secs(10 * 60)).await;
    }
}

/// Procura capítulos novos em todas as páginas de obra conhecidas, um site depois do outro.
pub async fn check_now(engine: &Engine) {
    {
        let mut checking = engine.checking.lock();
        if *checking {
            return;
        }
        *checking = true;
    }
    engine.say("Procurando capítulos novos");
    // Antes, as obras ainda não procuradas nos sites e as capas que faltam.
    toon_web::details::auto_link().await;
    let covers = toon_web::details::auto_covers(&engine.covers_tried).await;
    if covers > 0 {
        engine.touch();
    }
    let mut sources: Vec<String> = library::list_works()
        .into_iter()
        .flat_map(|w| w.sources.unwrap_or_default())
        .collect();
    sources.sort();
    sources.dedup();
    for (i, source) in sources.iter().enumerate() {
        if i > 0 {
            tokio::time::sleep(BETWEEN_SITES).await;
        }
        let check = match catalog::chapter_list(Site::of_url(source), source).await {
            Ok(list) => match list.chapters.last() {
                Some(last) => SourceCheck {
                    checked_at: toon_core::now_ms(),
                    latest: Some(last.chapter),
                    latest_url: Some(last.url.clone()),
                    ..Default::default()
                },
                None => SourceCheck {
                    checked_at: toon_core::now_ms(),
                    error: Some("Nenhum capítulo encontrado nesta página. Use a página da obra, a que lista os capítulos.".into()),
                    ..Default::default()
                },
            },
            Err(e) => SourceCheck { checked_at: toon_core::now_ms(), error: Some(e.to_string()), ..Default::default() },
        };
        let _ = updates::record_check(source, check);
    }
    let _ = updates::change(|s| s.last_run = Some(toon_core::now_ms()));
    crate::notify::announce().await;
    *engine.checking.lock() = false;
    let fresh = updates::unread().iter().filter(|u| u.is_recent()).count();
    engine.say(if fresh > 0 {
        format!("{fresh} obras com capítulo novo")
    } else {
        "Nenhum capítulo novo".to_string()
    });
}

/// Procura nos sites e devolve no formato que o celular espera.
pub async fn search_json(query: &str) -> Value {
    let results = catalog::search(query).await;
    serde_json::to_value(results).unwrap_or(json!([]))
}

struct ServerHooks {
    engine: Arc<Engine>,
}

#[async_trait]
impl toon_server::App for ServerHooks {
    async fn search(&self, query: &str, _own: bool) -> Value {
        search_json(query).await
    }

    async fn chapter_list(&self, site: &str, url: &str) -> anyhow::Result<Value> {
        let site: Site = serde_json::from_value(Value::String(site.into())).unwrap_or(Site::Link);
        Ok(serde_json::to_value(
            catalog::chapter_list(site, url).await?,
        )?)
    }

    async fn link_work(&self, work_id: &str, matches: Value) -> anyhow::Result<()> {
        let matches: Vec<catalog::Match> = serde_json::from_value(matches)?;
        toon_web::details::link_work(work_id, &matches).await?;
        self.engine.touch();
        Ok(())
    }

    async fn refresh_work(&self, work_id: &str) -> anyhow::Result<()> {
        toon_web::details::refresh_work(work_id).await?;
        self.engine.touch();
        Ok(())
    }

    fn cloud_for_phone(&self) -> Value {
        crate::cloud::for_phone()
    }

    async fn join_cloud(&self, uid: &str) -> anyhow::Result<()> {
        crate::cloud::join(uid).await
    }

    fn challenges(&self) -> Value {
        serde_json::to_value(toon_web::challenge::list()).unwrap_or(Value::Null)
    }

    async fn challenge_frame(&self, id: &str) -> anyhow::Result<Vec<u8>> {
        toon_web::challenge::frame(id).await
    }

    async fn challenge_press(&self, id: &str, x: f64, y: f64, action: &str) -> anyhow::Result<()> {
        toon_web::challenge::press(id, x, y, action).await
    }

    fn check_updates(&self) {
        let engine = self.engine.clone();
        tokio::spawn(async move { check_now(&engine).await });
    }

    fn cancel_job(&self, id: &str) {
        self.engine.cancel(id);
    }

    fn library_changed(&self) {
        self.engine.touch();
    }

    fn checking(&self) -> bool {
        self.engine.is_checking()
    }

    fn phone_release(&self) -> Option<(String, u32, std::path::PathBuf)> {
        // Ao lado do executável (instalado) ou em mobile/build (rodando do repositório).
        let exe = std::env::current_exe().ok()?;
        let dir = exe.parent()?;
        let candidates = [
            dir.join("phone"),
            dir.join("../../mobile/build"),
            std::env::current_dir().ok()?.join("mobile/build"),
        ];
        let folder = candidates
            .into_iter()
            .find(|f| f.join("MangaIndex.json").exists())?;
        let info: HashMap<String, Value> =
            serde_json::from_slice(&std::fs::read(folder.join("MangaIndex.json")).ok()?).ok()?;
        let apk = folder.join("MangaIndex.apk");
        if !apk.exists() {
            return None;
        }
        Some((
            info.get("version")?.as_str()?.to_string(),
            info.get("build")?.as_u64()? as u32,
            apk,
        ))
    }
}
