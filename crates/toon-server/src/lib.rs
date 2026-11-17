//! O servidor local na porta 47321. Dois tipos de cliente:
//!
//! - a extensão do navegador, só deste PC: uma página da web não consegue mandar pedido com a origem
//!   de uma extensão, então nenhum site consegue marcar capítulos como lidos;
//! - celulares pareados, na rede de casa ou no Tailscale quando ligados no app, cada um com o seu token.
//!
//! As rotas e as respostas são as mesmas da versão em Electron: o app do celular e a extensão
//! continuam como estão.

use std::net::SocketAddr;
use std::sync::Arc;

use async_trait::async_trait;
use axum::Router;
use axum::body::Bytes;
use axum::extract::{ConnectInfo, Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::any;
use serde_json::{Value, json};
use toon_core::browsing::{self, Bookmark};
use toon_core::devices::{self, Device};
use toon_core::library::{self, MoveTarget};
use toon_core::names::display_name;
use toon_core::reading::{self, Report};
use toon_core::settings::{self, AUTO_LANGUAGE, LANGUAGES};
use toon_core::works::{Auto, Format, Shelf, find_work};
use toon_core::{jobs, updates};

pub const PORT: u16 = 47321;
/// O PDF de um capítulo vindo do celular; scans de um capítulo longo passam de dezenas de megabytes.
const MAX_PDF: usize = 300 * 1024 * 1024;

/// O que só o app rodando sabe fazer: procurar nos sites, verificar capítulos novos, parar a fila…
#[async_trait]
pub trait App: Send + Sync + 'static {
    async fn search(&self, query: &str, own: bool) -> Value;
    async fn chapter_list(&self, site: &str, url: &str) -> anyhow::Result<Value>;
    async fn refresh_work(&self, work_id: &str) -> anyhow::Result<()>;
    async fn link_work(&self, work_id: &str, matches: Value) -> anyhow::Result<()>;
    fn check_updates(&self);
    fn cancel_job(&self, id: &str);
    /// A biblioteca mudou por fora (o celular): a janela lista de novo.
    fn library_changed(&self);
    fn checking(&self) -> bool;
    /// O APK mais novo do celular, quando foi gerado neste PC: versão, build e arquivo.
    fn phone_release(&self) -> Option<(String, u32, std::path::PathBuf)>;
}

type Shared = Arc<dyn App>;

fn ok(body: impl serde::Serialize) -> Response {
    (StatusCode::OK, axum::Json(body)).into_response()
}

fn err(status: StatusCode, message: impl Into<String>) -> Response {
    (status, axum::Json(json!({ "error": message.into() }))).into_response()
}

fn bad(message: impl Into<String>) -> Response {
    err(StatusCode::BAD_REQUEST, message)
}

fn bytes(kind: &'static str, data: Vec<u8>) -> Response {
    ([(header::CONTENT_TYPE, kind)], data).into_response()
}

fn body_json(body: &Bytes) -> Value {
    if body.is_empty() {
        json!({})
    } else {
        serde_json::from_slice(body).unwrap_or(Value::Null)
    }
}

fn string_list(v: &Value) -> Option<Vec<String>> {
    v.as_array()?
        .iter()
        .map(|s| s.as_str().map(str::to_string))
        .collect()
}

fn number_list(v: &Value) -> Option<Vec<f64>> {
    v.as_array()?.iter().map(Value::as_f64).collect()
}

/// Ouve na rede (celulares ligados) ou só neste PC (só a extensão).
pub async fn serve(app: Shared) -> anyhow::Result<()> {
    let host = if devices::phones_enabled() {
        [0, 0, 0, 0]
    } else {
        [127, 0, 0, 1]
    };
    let router = Router::new()
        .route("/api/{*rest}", any(phone))
        .route("/status", any(extension))
        .route("/updates", any(extension))
        .route("/reading", any(extension))
        .route("/continue", any(extension))
        .route("/page", any(extension))
        .route("/bookmark", any(extension))
        .route("/read-up-to", any(extension))
        .with_state(app)
        .layer(axum::extract::DefaultBodyLimit::max(MAX_PDF));
    // A porta pode estar presa por um instante pela cópia do app que acabou de fechar: tenta de novo.
    let listener = loop {
        match tokio::net::TcpListener::bind(SocketAddr::from((host, PORT))).await {
            Ok(l) => break l,
            Err(e) => {
                tracing::warn!("porta {PORT} ocupada ({e}); tentando de novo");
                tokio::time::sleep(std::time::Duration::from_secs(3)).await;
            }
        }
    };
    axum::serve(
        listener,
        router.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await?;
    Ok(())
}

fn report(body: &Value) -> Value {
    let list = match body {
        Value::Array(a) => a.clone(),
        other => vec![other.clone()],
    };
    let mut last = Value::Null;
    for item in list {
        if let Ok(r) = serde_json::from_value::<Report>(item)
            && let Ok(Some((record, work))) = reading::report(&r)
        {
            let mut v = serde_json::to_value(record).unwrap_or(Value::Null);
            v["work"] = Value::String(work);
            last = v;
        }
    }
    last
}

/// As novidades depois do último capítulo lido, com o nome da obra.
fn new_chapters() -> Vec<Value> {
    let works = library::list_works();
    updates::unread()
        .into_iter()
        .map(|u| {
            let name = works
                .iter()
                .find(|w| w.id == u.work_id)
                .map(|w| display_name(w.name()))
                .unwrap_or_default();
            let mut v = serde_json::to_value(&u).unwrap_or(Value::Null);
            v["recent"] = Value::Bool(u.is_recent());
            v["work"] = Value::String(name);
            v
        })
        .collect()
}

async fn extension(
    method: Method,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    uri: axum::http::Uri,
    body: Bytes,
) -> Response {
    let origin = headers
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let extension =
        origin.starts_with("chrome-extension://") || origin.starts_with("moz-extension://");
    if !peer.ip().is_loopback() || !extension {
        return err(StatusCode::FORBIDDEN, "Somente a extensão do Toon Index.");
    }
    let mut response = route_extension(&method, uri.path(), &body).await;
    let h = response.headers_mut();
    if let Ok(v) = HeaderValue::from_str(&origin) {
        h.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, v);
    }
    h.insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static("Content-Type"),
    );
    h.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("GET, POST"),
    );
    response
}

async fn route_extension(method: &Method, path: &str, body: &Bytes) -> Response {
    if method == Method::OPTIONS {
        return StatusCode::NO_CONTENT.into_response();
    }
    match (method.as_str(), path) {
        ("GET", "/status") => ok(json!({ "app": "Toon Index" })),
        ("GET", "/updates") => ok(new_chapters()
            .into_iter()
            .filter(|u| u["recent"] == true)
            .collect::<Vec<_>>()),
        ("POST", "/reading") => ok(report(&body_json(body))),
        ("GET", "/continue") => ok(browsing::continue_list(15)),
        ("POST", "/page" | "/bookmark" | "/read-up-to") => {
            let b = body_json(body);
            let (Some(url), Some(title)) = (b["url"].as_str(), b["title"].as_str()) else {
                return bad("url e title.");
            };
            let work_url = b["workUrl"].as_str().filter(|w| w.starts_with("http"));
            let result = match path {
                "/page" => Ok(browsing::page_info(url, title, work_url)),
                "/bookmark" => {
                    let patch: Bookmark = serde_json::from_value(b.clone()).unwrap_or_default();
                    browsing::bookmark_page(url, title, &patch, work_url)
                }
                _ => browsing::read_up_to_page(url, title, work_url),
            };
            match result {
                Ok(info) => ok(info),
                Err(e) => bad(e.to_string()),
            }
        }
        _ => err(StatusCode::NOT_FOUND, "Não encontrado."),
    }
}

fn resolve_work(work_id: &Value, name: &Value) -> Option<String> {
    let works = library::list_works();
    if let Some(id) = work_id
        .as_str()
        .filter(|id| works.iter().any(|w| &w.id == id))
    {
        return Some(id.to_string());
    }
    let name = name.as_str()?.trim();
    if name.is_empty() {
        return None;
    }
    library::index_work(name, Format::Comic, false).ok()
}

/// A API do app do celular. Tudo menos o pareamento precisa do token que o celular ganhou ao parear.
async fn phone(
    State(app): State<Shared>,
    method: Method,
    Path(rest): Path<String>,
    Query(query): Query<std::collections::HashMap<String, String>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let path = format!("/api/{rest}");
    if method == Method::POST && path == "/api/pair" {
        let b = body_json(&body);
        return match b["code"]
            .as_str()
            .and_then(|c| devices::pair(c, b["name"].as_str().unwrap_or("")))
        {
            Some((token, device)) => ok(json!({ "token": token, "device": device })),
            None => err(
                StatusCode::UNAUTHORIZED,
                "Código errado ou vencido. Gere outro no app do PC.",
            ),
        };
    }
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::trim);
    let Some(device) = token.and_then(devices::device_for) else {
        return err(
            StatusCode::UNAUTHORIZED,
            "Este celular não está pareado (ou foi removido no app do PC).",
        );
    };
    match handle(&app, &method, &path, &query, &body, &device).await {
        Ok(r) => r,
        Err(e) => bad(e.to_string()),
    }
}

async fn handle(
    app: &Shared,
    method: &Method,
    path: &str,
    query: &std::collections::HashMap<String, String>,
    body: &Bytes,
    device: &Device,
) -> anyhow::Result<Response> {
    let b = || body_json(body);
    let id_in = |prefix: &str| {
        path.strip_prefix(prefix)
            .filter(|id| !id.is_empty() && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-'))
    };
    Ok(match (method.as_str(), path) {
        ("GET", "/api/status") => ok(json!({ "app": "Toon Index", "device": device })),
        ("GET", "/api/cloud") => ok(json!({ "configured": false })),
        ("POST", "/api/cloud/join") => {
            bad("A sincronização pela internet ainda não existe nesta versão.")
        }
        ("GET", "/api/library") => {
            let chapters: Vec<Value> = library::list_library()
                .into_iter()
                .map(|e| {
                    let has = library::cover_of(&e.id).is_some();
                    let mut v = serde_json::to_value(e).unwrap_or(Value::Null);
                    v["hasCover"] = Value::Bool(has);
                    v
                })
                .collect();
            let stored = updates::load();
            let all = updates::work_updates(&library::list_works(), &stored.checks);
            let works: Vec<Value> = library::list_works()
                .into_iter()
                .map(|w| {
                    let has = library::work_cover(&w.id).is_some();
                    let latest = all.get(&w.id).map(|u| u.latest);
                    let dates = updates::work_dates(w.sources(), &stored.checks);
                    let mut v = serde_json::to_value(&w).unwrap_or(Value::Null);
                    v["hasCover"] = Value::Bool(has);
                    v["latest"] = json!(latest);
                    v["dates"] = json!(dates);
                    v
                })
                .collect();
            ok(json!({
                "works": works,
                "reading": reading::list(),
                "chapters": chapters,
                "updates": new_chapters(),
                "ntfyTopic": stored.ntfy_topic,
                "lastCheck": stored.last_run,
                "checking": app.checking(),
            }))
        }
        ("POST", "/api/updates/check") => {
            app.check_updates();
            ok(json!({ "ok": true }))
        }
        ("GET", "/api/app") => match app.phone_release() {
            Some((version, build, _)) => ok(json!({ "version": version, "build": build })),
            None => err(StatusCode::NOT_FOUND, "Nenhum APK no PC."),
        },
        ("GET", "/api/app/apk") => match app
            .phone_release()
            .and_then(|(_, _, f)| std::fs::read(f).ok())
        {
            Some(apk) => bytes("application/vnd.android.package-archive", apk),
            None => err(StatusCode::NOT_FOUND, "Nenhum APK no PC."),
        },
        ("GET", _) if id_in("/api/cover/").is_some() => {
            match library::cover_of(id_in("/api/cover/").unwrap()) {
                Some(j) => bytes("image/jpeg", j),
                None => err(StatusCode::NOT_FOUND, "Sem capa."),
            }
        }
        ("GET", _) if id_in("/api/work-cover/").is_some() => {
            match library::work_cover(id_in("/api/work-cover/").unwrap()) {
                Some(j) => bytes("image/jpeg", j),
                None => err(StatusCode::NOT_FOUND, "Sem capa."),
            }
        }
        ("GET", p) if p.starts_with("/api/pdf/") => {
            let parts: Vec<&str> = p.trim_start_matches("/api/pdf/").split('/').collect();
            let which = parts.get(1).copied().unwrap_or("");
            let found = parts
                .first()
                .filter(|_| which == "original" || which == "translated")
                .and_then(|id| library::read_meta(id).ok());
            match found.and_then(|e| std::fs::read(e.pdf(which == "translated")).ok()) {
                Some(pdf) => bytes("application/pdf", pdf),
                None => err(StatusCode::NOT_FOUND, "Capítulo não encontrado no PC."),
            }
        }
        ("GET", "/api/translate") => ok(jobs::queue().jobs),
        ("GET", "/api/queue") => ok(jobs::queue()),
        ("POST", p) if p.starts_with("/api/queue/") => {
            let b = b();
            let list = string_list(&b["ids"]);
            match p {
                "/api/queue/reorder" if list.is_some() => {
                    ok(jobs::reorder(list.as_deref().unwrap())?)
                }
                "/api/queue/options" => ok(jobs::set_options(
                    jobs::clean_options(&b["options"]),
                    list.as_deref(),
                )?),
                "/api/queue/sort" => ok(jobs::sort()?),
                "/api/queue/retry" => ok(jobs::retry(list.as_deref())?),
                "/api/queue/pause" if b["paused"].is_boolean() => {
                    ok(jobs::pause(b["paused"].as_bool().unwrap())?)
                }
                _ => bad("Pedido da fila inválido."),
            }
        }
        ("GET", "/api/translate/options") => {
            let s = settings::load();
            let hints = settings::key_hints();
            let defaults = serde_json::to_value(&s)?;
            let keys = [
                "activeProfileId",
                "sourceLanguage",
                "targetLanguage",
                "concurrency",
                "speed",
                "translateSfx",
                "reuseLayers",
                "contentType",
                "skipStart",
                "skipEnd",
                "gpuSharing",
                "aiDevice",
                "visionDevice",
            ];
            let defaults: serde_json::Map<String, Value> = keys
                .iter()
                .map(|k| (k.to_string(), defaults[*k].clone()))
                .collect();
            let profiles: Vec<Value> = s
                .profiles
                .iter()
                .map(|p| {
                    let ready = !p.model.is_empty() && (hints.contains_key(&p.id) || p.is_local());
                    json!({ "id": p.id, "name": p.name, "model": p.model, "ready": ready, "local": p.is_local() })
                })
                .collect();
            let languages: Vec<Value> = LANGUAGES
                .iter()
                .map(|(v, l)| json!({ "value": v, "label": l }))
                .collect();
            ok(
                json!({ "defaults": defaults, "profiles": profiles, "languages": languages, "auto": AUTO_LANGUAGE }),
            )
        }
        ("POST", "/api/translate/options") => {
            if let Some(options) = jobs::clean_options(&b()["options"]) {
                let mut current = serde_json::to_value(settings::load())?;
                for (k, v) in options {
                    current[k] = v;
                }
                settings::save(serde_json::from_value(current)?, &Default::default())?;
            }
            ok(json!({ "ok": true }))
        }
        ("POST", "/api/translate") => {
            let b = b();
            let Some(link) = b["url"].as_str() else {
                return Ok(bad("Falta o link."));
            };
            ok(jobs::add_link(
                link.trim(),
                &device.name,
                jobs::clean_options(&b["options"]),
            )
            .map_err(|_| anyhow::anyhow!("Link inválido."))?)
        }
        ("POST", "/api/download") => {
            let b = b();
            let (Some(link), Some(work), Some(chapter)) =
                (b["url"].as_str(), b["work"].as_str(), b["chapter"].as_f64())
            else {
                return Ok(bad("Falta o link, a obra ou o capítulo."));
            };
            let host = b["site"]
                .as_str()
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| {
                    link.split("//")
                        .nth(1)
                        .and_then(|r| r.split('/').next())
                        .unwrap_or("")
                        .to_string()
                });
            ok(jobs::add_batch(
                work,
                &host,
                &[jobs::BatchChapter {
                    chapter,
                    url: link.trim().into(),
                }],
                true,
                &device.name,
                None,
            )?)
        }
        ("POST", "/api/works/search") => {
            let b = b();
            match b["query"].as_str().map(str::trim).filter(|q| !q.is_empty()) {
                Some(q) => ok(app.search(q, b["own"] == true).await),
                None => bad("Falta o nome da obra."),
            }
        }
        ("POST", "/api/works/chapters") => {
            let b = b();
            let (Some(site), Some(page)) = (b["site"].as_str(), b["url"].as_str()) else {
                return Ok(bad("Falta o site ou o link da obra."));
            };
            let found = app.chapter_list(site, page).await?;
            // Celulares antes da 1.5 recebem só a lista.
            ok(if b["withTitle"] == true {
                found
            } else {
                found["chapters"].clone()
            })
        }
        ("POST", "/api/batch") => {
            let b = b();
            let chapters: Option<Vec<jobs::BatchChapter>> = b["chapters"].as_array().map(|a| {
                a.iter()
                    .filter_map(|c| {
                        Some(jobs::BatchChapter {
                            chapter: c["chapter"].as_f64()?,
                            url: c["url"].as_str()?.to_string(),
                        })
                    })
                    .collect()
            });
            let (Some(work), Some(site), Some(chapters)) = (
                b["work"].as_str().filter(|w| !w.trim().is_empty()),
                b["site"].as_str(),
                chapters,
            ) else {
                return Ok(bad("Falta a obra, o site ou os capítulos."));
            };
            let queue = jobs::add_batch(
                work,
                site,
                &chapters,
                b["download"] == true,
                &device.name,
                jobs::clean_options(&b["options"]),
            )?;
            if let Some(source) = b["source"].as_str() {
                library::add_work_source(work, source)?;
            }
            ok(queue)
        }
        ("POST", "/api/translate/pdf") => {
            let options = query
                .get("options")
                .and_then(|o| serde_json::from_str::<Value>(o).ok())
                .unwrap_or(Value::Null);
            let name = query.get("name").cloned().unwrap_or_default();
            ok(jobs::add_pdf(
                &name,
                body,
                &device.name,
                jobs::clean_options(&options),
            )?)
        }
        ("POST", "/api/translate/cancel") => {
            if let Some(id) = b()["id"].as_str() {
                app.cancel_job(id);
                jobs::cancel(id)?;
            }
            ok(json!({ "ok": true }))
        }
        ("POST", "/api/translate/retry") => {
            if let Some(id) = b()["id"].as_str() {
                jobs::retry(Some(&[id.to_string()]))?;
            }
            ok(json!({ "ok": true }))
        }
        ("POST", "/api/reading") => ok(report(&b())),
        ("POST", "/api/reading/finished") => {
            if let Some(id) = b()["entryId"].as_str() {
                reading::read_in_app(id, 1.0, None)?;
            }
            ok(json!({ "ok": true }))
        }
        ("POST", "/api/reading/app") => {
            let body = b();
            let list = if let Value::Array(a) = body {
                a
            } else {
                vec![body]
            };
            for r in list {
                if let (Some(id), Some(progress)) = (r["entryId"].as_str(), r["progress"].as_f64())
                {
                    // O capítulo pode ter sido apagado da biblioteca nesse meio tempo.
                    let _ = reading::read_in_app(id, progress, r["at"].as_i64());
                }
            }
            ok(json!({ "ok": true }))
        }
        ("POST", "/api/reading/mark") => {
            let b = b();
            let list =
                number_list(&b["chapters"]).or_else(|| b["chapter"].as_f64().map(|c| vec![c]));
            match (resolve_work(&b["workId"], &b["name"]), list) {
                (Some(id), Some(list)) => {
                    reading::mark_read(&id, &list)?;
                    ok(json!({ "ok": true }))
                }
                _ => bad("workId e chapter."),
            }
        }
        ("POST", "/api/reading/forget") => {
            let b = b();
            let works = library::list_works();
            let id = b["workId"]
                .as_str()
                .filter(|id| works.iter().any(|w| &w.id == id))
                .map(str::to_string)
                .or_else(|| {
                    b["name"]
                        .as_str()
                        .and_then(|n| find_work(&works, n, Format::Comic))
                        .map(|w| w.id.clone())
                });
            let list =
                number_list(&b["chapters"]).or_else(|| b["chapter"].as_f64().map(|c| vec![c]));
            if let Some(id) = id {
                reading::forget(&id, list.as_deref())?;
            }
            ok(json!({ "ok": true }))
        }
        ("POST", "/api/merge") => {
            let b = b();
            let records: Vec<reading::Record> =
                serde_json::from_value(b["reading"].clone()).unwrap_or_default();
            reading::merge_records(records)?;
            app.library_changed();
            ok(json!({ "ok": true }))
        }
        ("POST", "/api/works/shelf") => {
            let b = b();
            let shelf: Option<Option<Shelf>> = if b["shelf"].is_null() {
                Some(None)
            } else {
                serde_json::from_value(b["shelf"].clone()).ok().map(Some)
            };
            match (resolve_work(&b["workId"], &b["name"]), shelf) {
                (Some(id), Some(shelf)) => {
                    library::set_work_shelf(&id, Some(shelf), Some(b["favorite"] == true))?;
                    ok(json!({ "ok": true }))
                }
                _ => bad("workId e shelf."),
            }
        }
        ("POST", "/api/works/edit") => {
            let b = b();
            let works = library::list_works();
            let Some(work) = b["workId"]
                .as_str()
                .and_then(|id| works.iter().find(|w| w.id == id))
            else {
                return Ok(err(
                    StatusCode::NOT_FOUND,
                    "Essa obra não está mais na biblioteca do PC.",
                ));
            };
            if let Some(names) = string_list(&b["names"]) {
                library::set_work_names(&work.id, &names, true)?;
            } else if let Some(sources) = string_list(&b["sources"]) {
                library::save_work_sources(&work.id, sources)?;
            } else if let Some(from) = b["fromId"]
                .as_str()
                .filter(|f| works.iter().any(|w| &w.id == f))
            {
                library::merge_works(&work.id, from)?;
            } else if b
                .get("auto")
                .is_some_and(|a| a.is_null() || a == "translate" || a == "download")
            {
                let auto: Option<Auto> = serde_json::from_value(b["auto"].clone()).ok();
                library::set_work_auto(&work.id, auto)?;
            } else if b["unit"] == "chapter" || b["unit"] == "volume" {
                library::set_work_volumes(&work.id, b["unit"] == "volume")?;
            } else if b["refresh"] == true {
                app.refresh_work(&work.id).await?;
            } else if b["matches"].is_array() {
                app.link_work(&work.id, b["matches"].clone()).await?;
            } else {
                return Ok(bad("Nada para mudar."));
            }
            app.library_changed();
            ok(json!({ "ok": true }))
        }
        ("POST", "/api/library/delete") => {
            let Some(id) = b()["id"].as_str().map(str::to_string) else {
                return Ok(bad("id."));
            };
            library::delete_from_library(&id)?;
            app.library_changed();
            ok(json!({ "ok": true }))
        }
        ("POST", "/api/library/move") => {
            let b = b();
            let (Some(entry), Some(target)) = (b["entryId"].as_str(), b["workId"].as_str()) else {
                return Ok(bad("entryId e workId."));
            };
            ok(library::move_to_work(
                entry,
                MoveTarget::Work(target.into()),
            )?)
        }
        ("POST", "/api/works/page" | "/api/works/bookmark") => {
            let b = b();
            let (Some(url), Some(title)) = (b["url"].as_str(), b["title"].as_str()) else {
                return Ok(bad("url e title."));
            };
            if path == "/api/works/page" {
                ok(browsing::page_info(url, title, None))
            } else {
                let patch: Bookmark = serde_json::from_value(b.clone()).unwrap_or_default();
                let info = browsing::bookmark_page(url, title, &patch, None)?;
                app.library_changed();
                ok(info)
            }
        }
        ("POST", "/api/works/delete") => {
            let Some(id) = b()["workId"].as_str().map(str::to_string) else {
                return Ok(bad("Obra não encontrada no PC."));
            };
            library::delete_work(&id)?;
            app.library_changed();
            ok(json!({ "ok": true }))
        }
        _ => err(StatusCode::NOT_FOUND, "Não encontrado."),
    })
}
