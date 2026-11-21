//! Verificações de robô que precisam da pessoa ("não sou um robô", segurar o botão).
//!
//! O cookie que libera o site vale só para o navegador que passou pela verificação, então ela é feita
//! no próprio navegador do app, que continua fora da tela. O app avisa (no Windows e no celular) e a
//! pessoa resolve de onde estiver: no celular, que recebe a imagem da página e manda os toques como
//! cliques; ou no PC, que traz a janela para a tela só quando ela pede.

use std::sync::OnceLock;

use anyhow::{Context, anyhow};
use chromiumoxide::Page;
use chromiumoxide::cdp::browser_protocol::input::{
    DispatchMouseEventParams, DispatchMouseEventType, MouseButton,
};
use chromiumoxide::cdp::browser_protocol::page::CaptureScreenshotFormat;
use parking_lot::Mutex;
use serde::Serialize;

/// Uma verificação esperando a pessoa.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Info {
    pub id: String,
    /// O site, como "mangalivre.tv".
    pub site: String,
    pub url: String,
    pub since: i64,
    /// A janela foi trazida para a tela do PC.
    pub on_screen: bool,
}

struct Pending {
    info: Info,
    page: Page,
}

static PENDING: Mutex<Vec<Pending>> = Mutex::new(Vec::new());
type Hook = Box<dyn Fn(&Info) + Send + Sync>;
static ON_NEW: OnceLock<Hook> = OnceLock::new();
static ON_CHANGE: OnceLock<Box<dyn Fn() + Send + Sync>> = OnceLock::new();

/// O que o app faz quando uma verificação começa a esperar a pessoa (avisar no Windows e no
/// celular).
pub fn on_new(hook: impl Fn(&Info) + Send + Sync + 'static) {
    let _ = ON_NEW.set(Box::new(hook));
}

/// Chamado quando a lista muda (a janela do app redesenha a faixa).
pub fn on_change(hook: impl Fn() + Send + Sync + 'static) {
    let _ = ON_CHANGE.set(Box::new(hook));
}

fn changed() {
    if let Some(hook) = ON_CHANGE.get() {
        hook();
    }
}

pub fn list() -> Vec<Info> {
    PENDING.lock().iter().map(|p| p.info.clone()).collect()
}

pub(crate) fn add(page: Page, url: &str) -> String {
    let site = url::Url::parse(url)
        .ok()
        .and_then(|u| {
            u.host_str()
                .map(|h| h.trim_start_matches("www.").to_string())
        })
        .unwrap_or_default();
    let info = Info {
        id: format!("{:x}", toon_core::now_ms()),
        site,
        url: url.to_string(),
        since: toon_core::now_ms(),
        on_screen: false,
    };
    let id = info.id.clone();
    PENDING.lock().push(Pending {
        info: info.clone(),
        page,
    });
    if let Some(hook) = ON_NEW.get() {
        hook(&info);
    }
    changed();
    id
}

/// Tira da lista; `true` quando a janela estava na tela do PC (e precisa voltar para fora dela).
pub(crate) fn finish(id: &str) -> bool {
    let mut list = PENDING.lock();
    let on_screen = list
        .iter()
        .find(|p| p.info.id == id)
        .is_some_and(|p| p.info.on_screen);
    list.retain(|p| p.info.id != id);
    drop(list);
    changed();
    on_screen
}

fn page_of(id: &str) -> anyhow::Result<Page> {
    PENDING
        .lock()
        .iter()
        .find(|p| p.info.id == id)
        .map(|p| p.page.clone())
        .ok_or_else(|| anyhow!("Essa verificação já terminou."))
}

/// A página como está agora, em JPEG, para o celular mostrar.
pub async fn frame(id: &str) -> anyhow::Result<Vec<u8>> {
    let page = page_of(id)?;
    let params = chromiumoxide::page::ScreenshotParams::builder()
        .format(CaptureScreenshotFormat::Jpeg)
        .quality(70)
        .build();
    tokio::time::timeout(std::time::Duration::from_secs(15), page.screenshot(params))
        .await
        .context("a página não respondeu")?
        .context("captura da página")
}

/// Um toque do celular vira o mouse na página: `x` e `y` de 0 a 1 sobre a imagem. `action` é
/// "tap" (clicar), "down" (apertar e segurar) ou "up" (soltar).
pub async fn press(id: &str, x: f64, y: f64, action: &str) -> anyhow::Result<()> {
    let page = page_of(id)?;
    let size = page
        .evaluate("[window.innerWidth, window.innerHeight]")
        .await?
        .into_value::<(f64, f64)>()?;
    let (px, py) = (x.clamp(0.0, 1.0) * size.0, y.clamp(0.0, 1.0) * size.1);
    let event = |kind: DispatchMouseEventType| {
        DispatchMouseEventParams::builder()
            .r#type(kind)
            .x(px)
            .y(py)
            .button(MouseButton::Left)
            .click_count(1)
            .build()
            .map_err(|e| anyhow!(e))
    };
    // O mouse chega até o ponto antes do clique, como uma pessoa faria.
    page.execute(
        DispatchMouseEventParams::builder()
            .r#type(DispatchMouseEventType::MouseMoved)
            .x(px)
            .y(py)
            .build()
            .map_err(|e| anyhow!(e))?,
    )
    .await?;
    if matches!(action, "tap" | "down") {
        page.execute(event(DispatchMouseEventType::MousePressed)?)
            .await?;
    }
    if matches!(action, "tap" | "up") {
        if action == "tap" {
            tokio::time::sleep(std::time::Duration::from_millis(90)).await;
        }
        page.execute(event(DispatchMouseEventType::MouseReleased)?)
            .await?;
    }
    Ok(())
}

/// Traz a janela do navegador para a tela do PC, para resolver ali.
pub async fn show_on_pc(id: &str) -> anyhow::Result<()> {
    let page = page_of(id)?;
    crate::browser::place(&page, 120, 80).await?;
    let _ = page.bring_to_front().await;
    if let Some(p) = PENDING.lock().iter_mut().find(|p| p.info.id == id) {
        p.info.on_screen = true;
    }
    changed();
    Ok(())
}
