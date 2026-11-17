//! O navegador que o app controla para ler os sites: o Edge (ou o Chrome) do próprio PC, com um perfil
//! só do app, onde ficam os cookies e as verificações já passadas. A janela fica fora da tela e só
//! aparece quando o site pede uma verificação que a pessoa precisa fazer.

use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context, anyhow, bail};
use chromiumoxide::cdp::browser_protocol::browser::{Bounds, GetWindowForTargetParams, SetWindowBoundsParams, WindowState};
use chromiumoxide::cdp::js_protocol::runtime::EvaluateParams;
use chromiumoxide::{Browser, Page};
use futures::StreamExt;
use serde::de::DeserializeOwned;
use tokio::sync::Mutex;
use toon_core::paths::browser_profile_dir;

const LOAD_TIMEOUT: Duration = Duration::from_secs(60);
/// Uma verificação que ainda está na tela depois disso precisa da pessoa.
pub const CHALLENGE_SHOW_AFTER: Duration = Duration::from_secs(6);
pub const CHALLENGE_TIMEOUT: Duration = Duration::from_secs(120);
const OFF_SCREEN: i64 = -32_000;

/// O navegador conectado; refeito quando a pessoa fecha o navegador ou ele cai.
static BROWSER: Mutex<Option<std::sync::Arc<Browser>>> = Mutex::const_new(None);
/// Nenhum comando ao navegador espera mais que isso.
const COMMAND_TIMEOUT: Duration = Duration::from_secs(90);

fn executable() -> anyhow::Result<PathBuf> {
    let candidates = [
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    ];
    candidates.iter().map(PathBuf::from).find(|p| p.exists()).ok_or_else(|| anyhow!("Não achei o Edge nem o Chrome neste PC."))
}

async fn browser() -> anyhow::Result<std::sync::Arc<Browser>> {
    let mut slot = BROWSER.lock().await;
    if let Some(b) = slot.as_ref() {
        if tokio::time::timeout(Duration::from_secs(3), b.version()).await.is_ok_and(|r| r.is_ok()) {
            return Ok(b.clone());
        }
    }
    let b = std::sync::Arc::new(connect().await?);
    *slot = Some(b.clone());
    Ok(b)
}

/// O endereço de depuração que o navegador anota no perfil quando está aberto.
fn active_port(profile: &std::path::Path) -> Option<String> {
    let text = std::fs::read_to_string(profile.join("DevToolsActivePort")).ok()?;
    let mut lines = text.lines();
    let port = lines.next()?.trim();
    let path = lines.next()?.trim();
    Some(format!("ws://127.0.0.1:{port}{path}"))
}

async fn attach(ws: &str) -> anyhow::Result<Browser> {
    let (browser, mut handler) = Browser::connect(ws).await?;
    tokio::spawn(async move { while handler.next().await.is_some() {} });
    Ok(browser)
}

/// Abre o navegador do app (ou usa o que já está aberto com o mesmo perfil) e conecta nele.
async fn connect() -> anyhow::Result<Browser> {
    let profile = browser_profile_dir();
    std::fs::create_dir_all(&profile)?;
    if let Some(ws) = active_port(&profile) {
        if let Ok(browser) = attach(&ws).await {
            return Ok(browser);
        }
    }
    let _ = std::fs::remove_file(profile.join("DevToolsActivePort"));
    std::process::Command::new(executable()?)
        .args([
            "--remote-debugging-port=0".to_string(),
            format!("--user-data-dir={}", profile.display()),
            format!("--window-position={OFF_SCREEN},{OFF_SCREEN}"),
            "--window-size=1100,900".into(),
            // Janela fora da tela conta como coberta; sem isso os leitores param de carregar páginas.
            "--disable-backgrounding-occluded-windows".into(),
            "--disable-renderer-backgrounding".into(),
            "--disable-background-timer-throttling".into(),
            "--mute-audio".into(),
            "--no-first-run".into(),
            "--no-default-browser-check".into(),
            "about:blank".into(),
        ])
        .spawn()
        .context("abrindo o navegador")?;
    for _ in 0..100 {
        tokio::time::sleep(Duration::from_millis(200)).await;
        if let Some(ws) = active_port(&profile) {
            if let Ok(browser) = attach(&ws).await {
                return Ok(browser);
            }
        }
    }
    bail!("O navegador não abriu a porta de controle.")
}

/// Uma aba do navegador do app, fechada ao sair de escopo.
pub struct Tab {
    pub page: Page,
    shown: bool,
}

impl Tab {
    pub async fn new() -> anyhow::Result<Tab> {
        let page = tokio::time::timeout(COMMAND_TIMEOUT, browser().await?.new_page("about:blank"))
            .await
            .map_err(|_| anyhow!("O navegador não respondeu."))??;
        Ok(Tab { page, shown: false })
    }

    /// Abre o endereço e espera a página carregar (até um minuto; páginas que nunca terminam de
    /// carregar anúncios seguem do jeito que estiverem).
    pub async fn open(&self, url: &str) -> anyhow::Result<()> {
        match tokio::time::timeout(LOAD_TIMEOUT, self.page.goto(url)).await {
            Ok(Ok(_)) => Ok(()),
            Ok(Err(err)) => bail!("Não foi possível abrir o link ({err})."),
            Err(_) => {
                if self.eval::<bool>("document.readyState !== 'loading'").await.unwrap_or(false) {
                    Ok(())
                } else {
                    bail!("O site demorou demais para abrir.")
                }
            }
        }
    }

    /// Roda JavaScript na página e devolve o valor (promessas são esperadas).
    pub async fn eval<T: DeserializeOwned>(&self, js: &str) -> anyhow::Result<T> {
        let params = EvaluateParams::builder().expression(js).await_promise(true).return_by_value(true).build().map_err(|e| anyhow!(e))?;
        let result = tokio::time::timeout(COMMAND_TIMEOUT, self.page.evaluate(params))
            .await
            .map_err(|_| anyhow!("A página não respondeu."))??;
        Ok(result.into_value()?)
    }

    pub async fn url(&self) -> String {
        self.page.url().await.ok().flatten().unwrap_or_default()
    }

    /// Se a página é uma verificação de robô ("Just a moment…", "Um momento…") em vez do site.
    pub async fn is_challenged(&self) -> bool {
        self.eval::<bool>(
            r"/just a moment|um momento|attention required|verify you are human|checking your browser|verificação de segurança/i.test(document.title + ' ' + (document.body?.innerText ?? '').slice(0, 400))",
        )
        .await
        .unwrap_or(false)
    }

    async fn place(&self, left: i64, top: i64) -> anyhow::Result<()> {
        let window = self.page.execute(GetWindowForTargetParams::default()).await?.result.window_id;
        let bounds = Bounds::builder().left(left).top(top).window_state(WindowState::Normal).build();
        self.page.execute(SetWindowBoundsParams::new(window, bounds)).await?;
        Ok(())
    }

    /// Traz a janela para a tela, para a pessoa passar uma verificação ou entrar na conta.
    pub async fn show(&mut self) {
        if !self.shown && self.place(120, 80).await.is_ok() {
            self.shown = true;
            let _ = self.page.bring_to_front().await;
        }
    }

    pub async fn hide(&mut self) {
        if self.shown && self.place(OFF_SCREEN, OFF_SCREEN).await.is_ok() {
            self.shown = false;
        }
    }

    /// Espera a verificação do site passar. As que passam sozinhas somem em segundos; as outras (a
    /// caixa do Cloudflare) aparecem na tela para a pessoa, por até dois minutos.
    pub async fn pass_challenge(&mut self, on_shown: impl Fn()) -> anyhow::Result<()> {
        let started = std::time::Instant::now();
        let mut waited = false;
        while self.is_challenged().await {
            waited = true;
            if !self.shown && started.elapsed() > CHALLENGE_SHOW_AFTER {
                self.show().await;
                on_shown();
            }
            if started.elapsed() > CHALLENGE_TIMEOUT {
                bail!("O site pediu uma verificação que não foi concluída.");
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
        if self.shown {
            self.hide().await;
        }
        // A página do site carrega depois da verificação.
        if waited {
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
        Ok(())
    }

    /// Os cookies que o site tem nesta aba, como um cabeçalho `Cookie` para o endereço.
    pub async fn cookie_header(&self, url: &str) -> String {
        let Ok(target) = url::Url::parse(url) else { return String::new() };
        let host = target.host_str().unwrap_or("").to_string();
        let cookies = self.page.get_cookies().await.unwrap_or_default();
        cookies
            .iter()
            .filter(|c| {
                let domain = c.domain.trim_start_matches('.');
                host == domain || host.ends_with(&format!(".{domain}"))
            })
            .map(|c| format!("{}={}", c.name, c.value))
            .collect::<Vec<_>>()
            .join("; ")
    }

    pub async fn user_agent(&self) -> String {
        self.eval::<String>("navigator.userAgent").await.unwrap_or_default()
    }

    /// Força o desenho de um quadro: leitores que carregam imagens ao aparecer na tela esperam um.
    pub async fn frame(&self) {
        let _ = self.page.screenshot(chromiumoxide::page::ScreenshotParams::builder().build()).await;
    }

    /// Mostra o site para a pessoa entrar na conta; volta quando ela fecha a aba ou passa o tempo.
    pub async fn login_window(url: &str) -> anyhow::Result<()> {
        let mut tab = Tab::new().await?;
        tab.open(url).await?;
        tab.show().await;
        let deadline = std::time::Instant::now() + Duration::from_secs(600);
        while std::time::Instant::now() < deadline {
            if tab.page.url().await.is_err() {
                break;
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
        tab.hide().await;
        Ok(())
    }
}

impl Drop for Tab {
    fn drop(&mut self) {
        let page = self.page.clone();
        tokio::spawn(async move {
            let _ = page.close().await;
        });
    }
}
