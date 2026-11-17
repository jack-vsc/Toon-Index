//! Sincronização pela internet sem Tailscale, pelo projeto Firebase da própria pessoa (Firestore no
//! plano grátis). Só vai informação, nunca PDF nem imagem:
//!
//! - o PC mantém dois documentos atualizados, a biblioteca e a fila, para o celular ler quando não
//!   alcança o PC;
//! - o celular deixa os pedidos (os mesmos que faz ao PC em casa) como documentos em `ops`; o PC roda
//!   cada um na própria API do celular e escreve a resposta de volta.
//!
//! Tudo fica num "espaço" cujos membros são a conta do PC e a de cada celular pareado, e as regras de
//! segurança só deixam membros entrarem. `cloud.json` é o mesmo da versão em Electron.

use std::time::Duration;

use anyhow::{Context, anyhow, bail};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use toon_core::paths::data_dir;
use toon_core::secrets;
use toon_core::store::{read_json, write_json};

const POLL: Duration = Duration::from_secs(6);
const PUBLISH_EVERY: Duration = Duration::from_secs(20);

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stored {
    #[serde(default)]
    pub config: Option<Map<String, Value>>,
    #[serde(default)]
    pub android_app_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub space_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    /// Criptografada como as chaves de API.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
    /// A chave da conta de serviço do projeto (JSON criptografado): manda as notificações.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service_key: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct Status {
    pub configured: bool,
    pub connected: bool,
    pub error: Option<String>,
    pub members: usize,
    pub push: bool,
}

pub static STATUS: Mutex<Status> = Mutex::new(Status {
    configured: false,
    connected: false,
    error: None,
    members: 0,
    push: false,
});

fn file() -> std::path::PathBuf {
    data_dir().join("cloud.json")
}

pub fn load() -> Stored {
    read_json(&file())
}

fn save(s: &Stored) -> anyhow::Result<()> {
    write_json(&file(), s)
}

fn seal(text: &str) -> anyhow::Result<String> {
    secrets::encrypt(text)
}

fn unseal(text: &str) -> anyhow::Result<String> {
    match text.strip_prefix("plain:") {
        Some(plain) => Ok(plain.to_string()),
        None => secrets::decrypt(text),
    }
}

fn config_field<'a>(s: &'a Stored, key: &str) -> Option<&'a str> {
    s.config.as_ref()?.get(key)?.as_str()
}

/// O que um celular pareado em casa precisa para chegar ao mesmo espaço sozinho.
pub fn for_phone() -> Value {
    let s = load();
    match (&s.config, &s.space_id) {
        (Some(web), Some(space)) if STATUS.lock().connected => {
            json!({ "web": web, "androidAppId": s.android_app_id, "spaceId": space })
        }
        _ => Value::Null,
    }
}

struct Session {
    http: reqwest::Client,
    api_key: String,
    project: String,
    id_token: String,
    refresh: String,
    until: std::time::Instant,
    space: String,
}

impl Session {
    fn base(&self) -> String {
        format!(
            "https://firestore.googleapis.com/v1/projects/{}/databases/(default)/documents",
            self.project
        )
    }

    async fn token(&mut self) -> anyhow::Result<String> {
        if std::time::Instant::now() + Duration::from_secs(120) > self.until {
            let r: Value = self
                .http
                .post(format!(
                    "https://securetoken.googleapis.com/v1/token?key={}",
                    self.api_key
                ))
                .form(&[
                    ("grant_type", "refresh_token"),
                    ("refresh_token", &self.refresh),
                ])
                .send()
                .await?
                .json()
                .await?;
            self.id_token = r["id_token"]
                .as_str()
                .ok_or_else(|| anyhow!("o Firebase não renovou o acesso"))?
                .to_string();
            self.refresh = r["refresh_token"]
                .as_str()
                .unwrap_or(&self.refresh)
                .to_string();
            self.until = std::time::Instant::now()
                + Duration::from_secs(
                    r["expires_in"]
                        .as_str()
                        .and_then(|s| s.parse().ok())
                        .unwrap_or(3600),
                );
        }
        Ok(self.id_token.clone())
    }

    async fn request(
        &mut self,
        method: reqwest::Method,
        path: &str,
        body: Option<Value>,
    ) -> anyhow::Result<Value> {
        let token = self.token().await?;
        let mut req = self
            .http
            .request(method, format!("{}/{path}", self.base()))
            .bearer_auth(token);
        if let Some(b) = body {
            req = req.json(&b);
        }
        let r = req.send().await?;
        let status = r.status();
        let text = r.text().await?;
        if !status.is_success() {
            bail!(
                "Firestore {}: {}",
                status.as_u16(),
                text.chars().take(200).collect::<String>()
            );
        }
        Ok(serde_json::from_str(&text).unwrap_or(Value::Null))
    }
}

/// Valores do Firestore (REST) para JSON comum e de volta, só nos tipos que o app usa.
fn from_firestore(v: &Value) -> Value {
    if let Some(s) = v.get("stringValue") {
        return s.clone();
    }
    if let Some(n) = v.get("integerValue").and_then(Value::as_str) {
        return n.parse::<i64>().map(Value::from).unwrap_or(Value::Null);
    }
    if let Some(n) = v.get("doubleValue") {
        return n.clone();
    }
    if let Some(b) = v.get("booleanValue") {
        return b.clone();
    }
    if let Some(a) = v.get("arrayValue") {
        return Value::Array(
            a["values"]
                .as_array()
                .into_iter()
                .flatten()
                .map(from_firestore)
                .collect(),
        );
    }
    if let Some(m) = v.get("mapValue") {
        return Value::Object(
            m["fields"]
                .as_object()
                .into_iter()
                .flatten()
                .map(|(k, v)| (k.clone(), from_firestore(v)))
                .collect(),
        );
    }
    Value::Null
}

fn now_timestamp() -> Value {
    let ms = toon_core::now_ms();
    let secs = ms / 1000;
    json!({ "timestampValue": format!("{}", chrono_like(secs, ms % 1000)) })
}

/// Data em RFC 3339, como o Firestore pede.
fn chrono_like(secs: i64, ms: i64) -> String {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{ms:03}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

async fn sign_in(
    http: &reqwest::Client,
    stored: &mut Stored,
) -> anyhow::Result<(String, String, String)> {
    let api_key = config_field(stored, "apiKey")
        .ok_or_else(|| anyhow!("cloud.json sem apiKey"))?
        .to_string();
    let (email, password) = match (&stored.email, &stored.password) {
        (Some(e), Some(p)) => (
            e.clone(),
            unseal(p).context("não deu para abrir a senha da conta do PC")?,
        ),
        _ => {
            // A conta do PC no projeto, criada na primeira vez (o celular usa uma anônima).
            let email = format!("pc-{}@manga-index.app", &uuid_hex()[..12]);
            let password = uuid_hex();
            let r: Value = http
                .post(format!(
                    "https://identitytoolkit.googleapis.com/v1/accounts:signUp?key={api_key}"
                ))
                .json(&json!({ "email": email, "password": password, "returnSecureToken": true }))
                .send()
                .await?
                .json()
                .await?;
            if r.get("error").is_some() {
                bail!(
                    "O Firebase recusou criar a conta do PC: ative \"E-mail/senha\" em Authentication."
                );
            }
            stored.email = Some(email.clone());
            stored.password = Some(seal(&password)?);
            save(stored)?;
            (email, password)
        }
    };
    let r: Value = http
        .post(format!(
            "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key={api_key}"
        ))
        .json(&json!({ "email": email, "password": password, "returnSecureToken": true }))
        .send()
        .await?
        .json()
        .await?;
    let id = r["idToken"].as_str().ok_or_else(|| {
        anyhow!(
            "O Firebase recusou a conta do PC ({})",
            r["error"]["message"]
        )
    })?;
    Ok((
        id.to_string(),
        r["refreshToken"].as_str().unwrap_or("").to_string(),
        r["localId"].as_str().unwrap_or("").to_string(),
    ))
}

fn uuid_hex() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

/// Liga a sincronização e fica nela: publica a biblioteca e a fila e atende os pedidos do celular.
pub async fn run(internal_token: String) {
    loop {
        let mut stored = load();
        let Some(project) = config_field(&stored, "projectId").map(str::to_string) else {
            *STATUS.lock() = Status::default();
            tokio::time::sleep(Duration::from_secs(60)).await;
            continue;
        };
        let push = stored.service_key.is_some();
        *STATUS.lock() = Status {
            configured: true,
            push,
            ..Default::default()
        };
        match session(&mut stored, project).await {
            Ok(mut s) => {
                if let Err(e) = serve(&mut s, &internal_token).await {
                    STATUS.lock().error = Some(e.to_string());
                }
            }
            Err(e) => STATUS.lock().error = Some(e.to_string()),
        }
        STATUS.lock().connected = false;
        tokio::time::sleep(Duration::from_secs(60)).await;
    }
}

async fn session(stored: &mut Stored, project: String) -> anyhow::Result<Session> {
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()?;
    let (id, refresh, uid) = sign_in(&http, stored).await?;
    let api_key = config_field(stored, "apiKey")
        .unwrap_or_default()
        .to_string();
    let mut s = Session {
        http,
        api_key,
        project,
        id_token: id,
        refresh,
        until: std::time::Instant::now() + Duration::from_secs(3500),
        space: String::new(),
    };
    match stored.space_id.clone() {
        Some(space) => {
            s.space = space.clone();
            let doc = s
                .request(reqwest::Method::GET, &format!("spaces/{space}"), None)
                .await?;
            let members = from_firestore(&doc["fields"]["members"])
                .as_array()
                .map(|a| a.len())
                .unwrap_or(1);
            STATUS.lock().members = members.saturating_sub(1);
        }
        None => {
            // Um espaço novo é escrito sem ler antes: as regras só deixam membros lerem.
            let space = uuid::Uuid::new_v4().simple().to_string()[..20].to_string();
            s.space = space.clone();
            let body = json!({ "fields": { "members": { "arrayValue": { "values": [{ "stringValue": uid }] } }, "createdAt": now_timestamp() } });
            s.request(
                reqwest::Method::PATCH,
                &format!("spaces/{space}"),
                Some(body),
            )
            .await?;
            stored.space_id = Some(space);
            save(stored)?;
        }
    }
    STATUS.lock().connected = true;
    STATUS.lock().error = None;
    Ok(s)
}

async fn local(method: &str, path: &str, body: Option<&str>, token: &str) -> (u16, String) {
    let client = reqwest::Client::new();
    let url = format!("http://127.0.0.1:{}{path}", toon_server::PORT);
    let mut req = if method == "GET" {
        client.get(url)
    } else {
        client.post(url)
    }
    .bearer_auth(token);
    if let Some(b) = body {
        req = req
            .header("Content-Type", "application/json")
            .body(b.to_string());
    }
    match req.send().await {
        Ok(r) => (r.status().as_u16(), r.text().await.unwrap_or_default()),
        Err(e) => (500, json!({ "error": e.to_string() }).to_string()),
    }
}

async fn publish(s: &mut Session, token: &str) -> anyhow::Result<()> {
    for (name, path) in [("library", "/api/library"), ("queue", "/api/queue")] {
        let (_, text) = local("GET", path, None, token).await;
        let body = json!({ "fields": { "json": { "stringValue": text }, "at": now_timestamp() } });
        s.request(
            reqwest::Method::PATCH,
            &format!("spaces/{}/state/{name}", s.space),
            Some(body),
        )
        .await?;
    }
    Ok(())
}

async fn serve(s: &mut Session, token: &str) -> anyhow::Result<()> {
    let mut last_publish = std::time::Instant::now() - PUBLISH_EVERY;
    loop {
        if last_publish.elapsed() >= PUBLISH_EVERY {
            publish(s, token).await?;
            last_publish = std::time::Instant::now();
        }
        let list = s
            .request(
                reqwest::Method::GET,
                &format!("spaces/{}/ops?pageSize=50", s.space),
                None,
            )
            .await?;
        for d in list["documents"].as_array().cloned().unwrap_or_default() {
            let fields = d["fields"].as_object().cloned().unwrap_or_default();
            let name = d["name"]
                .as_str()
                .unwrap_or("")
                .rsplit('/')
                .next()
                .unwrap_or("")
                .to_string();
            if fields.contains_key("status") {
                // Respostas que ninguém veio buscar somem depois de um tempo.
                if fields.get("doneAt").is_some()
                    && d["updateTime"].as_str().is_some_and(older_than_ten_minutes)
                {
                    let _ = s
                        .request(
                            reqwest::Method::DELETE,
                            &format!("spaces/{}/ops/{name}", s.space),
                            None,
                        )
                        .await;
                }
                continue;
            }
            let method = if fields.get("method").map(from_firestore) == Some(Value::from("GET")) {
                "GET"
            } else {
                "POST"
            };
            let path = fields
                .get("path")
                .map(from_firestore)
                .and_then(|p| p.as_str().map(str::to_string))
                .filter(|p| p.starts_with("/api/"));
            let body = fields
                .get("body")
                .map(from_firestore)
                .and_then(|b| b.as_str().map(str::to_string));
            let (status, text) = match path {
                Some(p) => local(method, &p, body.as_deref(), token).await,
                None => (400, r#"{"error":"Pedido inválido."}"#.to_string()),
            };
            // O Firestore guarda documentos de até 1 MB.
            let text = if text.len() > 900_000 {
                r#"{"error":"A resposta do PC é grande demais para a internet."}"#.to_string()
            } else {
                text
            };
            let update = json!({ "fields": { "status": { "integerValue": status.to_string() }, "response": { "stringValue": text }, "doneAt": now_timestamp() } });
            s.request(reqwest::Method::PATCH, &format!("spaces/{}/ops/{name}?updateMask.fieldPaths=status&updateMask.fieldPaths=response&updateMask.fieldPaths=doneAt", s.space), Some(update))
                .await?;
            last_publish = std::time::Instant::now() - PUBLISH_EVERY + Duration::from_secs(3);
        }
        tokio::time::sleep(POLL).await;
    }
}

fn older_than_ten_minutes(rfc3339: &str) -> bool {
    // "2026-11-17T20:10:05.123Z": comparado como texto com a hora de dez minutos atrás.
    let ms = toon_core::now_ms() - 10 * 60_000;
    rfc3339 < chrono_like(ms / 1000, ms % 1000).as_str()
}

/// Um celular pareado em casa entra no espaço com a conta (anônima) dele.
pub async fn join(uid: &str) -> anyhow::Result<()> {
    if uid.len() < 10 || uid.len() > 128 || !uid.chars().all(|c| c.is_ascii_alphanumeric()) {
        bail!("uid inválido.");
    }
    let mut stored = load();
    let project = config_field(&stored, "projectId")
        .ok_or_else(|| anyhow!("A sincronização pela internet está desligada."))?
        .to_string();
    let mut s = session(&mut stored, project).await?;
    let doc = s
        .request(reqwest::Method::GET, &format!("spaces/{}", s.space), None)
        .await?;
    let mut members: Vec<String> = from_firestore(&doc["fields"]["members"])
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|v| v.as_str().map(str::to_string))
        .collect();
    if !members.iter().any(|m| m == uid) {
        members.push(uid.to_string());
    }
    let values: Vec<Value> = members
        .iter()
        .map(|m| json!({ "stringValue": m }))
        .collect();
    let body = json!({ "fields": { "members": { "arrayValue": { "values": values } } } });
    s.request(
        reqwest::Method::PATCH,
        &format!("spaces/{}?updateMask.fieldPaths=members", s.space),
        Some(body),
    )
    .await?;
    STATUS.lock().members = members.len().saturating_sub(1);
    Ok(())
}

#[derive(Deserialize)]
struct ServiceKey {
    project_id: String,
    client_email: String,
    private_key: String,
}

#[derive(Serialize)]
struct Claims<'a> {
    iss: &'a str,
    scope: &'a str,
    aud: &'a str,
    iat: i64,
    exp: i64,
}

/// Uma notificação em todos os celulares do espaço (os endereços ficam em `devices`); tocar abre a obra.
/// `false` quando não deu (sem chave, sincronização desligada, nenhum celular).
pub async fn send_push(title: &str, body: &str, work_id: &str, url: &str) -> bool {
    match try_push(title, body, work_id, url).await {
        Ok(sent) => sent,
        Err(e) => {
            tracing::warn!("push falhou: {e}");
            false
        }
    }
}

async fn try_push(title: &str, body: &str, work_id: &str, url: &str) -> anyhow::Result<bool> {
    let mut stored = load();
    let Some(sealed) = stored.service_key.clone() else {
        return Ok(false);
    };
    let key: ServiceKey = serde_json::from_str(&unseal(&sealed)?)?;
    let now = toon_core::now_ms() / 1000;
    let claims = Claims {
        iss: &key.client_email,
        scope: "https://www.googleapis.com/auth/firebase.messaging",
        aud: "https://oauth2.googleapis.com/token",
        iat: now,
        exp: now + 3600,
    };
    let jwt = jsonwebtoken::encode(
        &jsonwebtoken::Header::new(jsonwebtoken::Algorithm::RS256),
        &claims,
        &jsonwebtoken::EncodingKey::from_rsa_pem(key.private_key.as_bytes())?,
    )?;
    let http = reqwest::Client::new();
    let token: Value = http
        .post("https://oauth2.googleapis.com/token")
        .form(&[
            ("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer"),
            ("assertion", &jwt),
        ])
        .send()
        .await?
        .json()
        .await?;
    let access = token["access_token"]
        .as_str()
        .ok_or_else(|| anyhow!("o Google recusou a chave"))?
        .to_string();
    let project = config_field(&stored, "projectId")
        .unwrap_or(&key.project_id)
        .to_string();
    let mut s = session(&mut stored, project).await?;
    let devices = s
        .request(
            reqwest::Method::GET,
            &format!("spaces/{}/devices", s.space),
            None,
        )
        .await?;
    let mut sent = 0;
    for d in devices["documents"].as_array().cloned().unwrap_or_default() {
        let Some(device_token) = d["fields"]["token"]["stringValue"].as_str() else {
            continue;
        };
        let message = json!({ "message": {
            "token": device_token,
            "notification": { "title": title, "body": body },
            "data": { "workId": work_id, "url": url },
            // Uma notificação por obra: um capítulo mais novo substitui o anterior.
            "android": { "priority": "high", "notification": { "channel_id": "chapters", "tag": work_id } },
        }});
        let r = http
            .post(format!(
                "https://fcm.googleapis.com/v1/projects/{}/messages:send",
                key.project_id
            ))
            .bearer_auth(&access)
            .json(&message)
            .send()
            .await?;
        if r.status().is_success() {
            sent += 1;
        } else if r.status().as_u16() == 404 {
            // O app foi desinstalado ou trocou de endereço: esse endereço sai.
            let name = d["name"]
                .as_str()
                .unwrap_or("")
                .rsplit('/')
                .next()
                .unwrap_or("")
                .to_string();
            let _ = s
                .request(
                    reqwest::Method::DELETE,
                    &format!("spaces/{}/devices/{name}", s.space),
                    None,
                )
                .await;
        }
    }
    Ok(sent > 0)
}

/// Guarda (ou esquece, com `None`) a chave da conta de serviço que manda as notificações.
pub fn set_push_key(pasted: Option<&str>) -> anyhow::Result<()> {
    let mut stored = load();
    match pasted {
        None => stored.service_key = None,
        Some(text) => {
            let key: ServiceKey = serde_json::from_str(text).map_err(|_| anyhow!("Cole o conteúdo inteiro do arquivo .json baixado (começa com {{ e termina com }})."))?;
            if config_field(&stored, "projectId").is_some_and(|p| p != key.project_id) {
                bail!("Essa chave é de outro projeto do Firebase.");
            }
            let clean = json!({ "project_id": key.project_id, "client_email": key.client_email, "private_key": key.private_key });
            stored.service_key = Some(seal(&clean.to_string())?);
        }
    }
    save(&stored)?;
    STATUS.lock().push = stored.service_key.is_some();
    Ok(())
}
