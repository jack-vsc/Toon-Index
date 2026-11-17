//! O modelo de tradução próprio do app ("Neste PC"): o servidor do llama.cpp com um modelo de visão
//! em GGUF, nos arquivos que a versão em Electron já baixou em `local-ai`. Liga antes de uma página ir
//! para ele e desliga sozinho depois de alguns minutos sem uso, para liberar a placa de vídeo.

use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use anyhow::{Context, bail};
use parking_lot::Mutex;
use serde::Deserialize;
use toon_core::paths::data_dir;

const PORT: u16 = 47380;
const IDLE: Duration = Duration::from_secs(5 * 60);

struct Server {
    model: String,
    child: Child,
    used: Instant,
}

static SERVER: Mutex<Option<Server>> = Mutex::new(None);

fn root() -> PathBuf {
    data_dir().join("local-ai")
}

#[derive(Deserialize)]
struct Source {
    model: String,
    mmproj: String,
}

/// Os modelos baixados (ou apontados para os arquivos do Ollama): `local-ai/models/<id>/source.json`.
pub fn installed_models() -> Vec<String> {
    std::fs::read_dir(root().join("models"))
        .map(|d| {
            d.flatten()
                .filter(|e| model_files(&e.file_name().to_string_lossy()).is_some())
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default()
}

fn model_files(id: &str) -> Option<Source> {
    let source: Source = serde_json::from_slice(
        &std::fs::read(root().join("models").join(id).join("source.json")).ok()?,
    )
    .ok()?;
    (std::path::Path::new(&source.model).exists() && std::path::Path::new(&source.mmproj).exists())
        .then_some(source)
}

/// O contexto de uma página e da resposta; o Qwen lê a imagem em mais tokens que o Gemma.
fn context_size(id: &str) -> u32 {
    if id.starts_with("qwen") { 16384 } else { 8192 }
}

fn engine_exe() -> Option<PathBuf> {
    let nvidia = Command::new("nvidia-smi")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|s| s.success());
    let order: &[&str] = if nvidia {
        &["cuda", "vulkan"]
    } else {
        &["vulkan", "cuda"]
    };
    order
        .iter()
        .map(|e| root().join("engine").join(e).join("llama-server.exe"))
        .find(|p| p.exists())
}

/// Liga o servidor com o modelo `id` (ou troca para ele) e espera ficar pronto.
pub async fn ensure(id: &str, cpu: bool) -> anyhow::Result<()> {
    {
        let mut slot = SERVER.lock();
        if let Some(s) = slot.as_mut() {
            if s.model == id && s.child.try_wait().ok().flatten().is_none() {
                s.used = Instant::now();
                return Ok(());
            }
        }
        if let Some(mut old) = slot.take() {
            let _ = old.child.kill();
        }
        let files = model_files(id).context(
            "O modelo escolhido não está baixado. Baixe-o em Configurações › IA neste PC.",
        )?;
        let exe = engine_exe().context(
            "O motor da IA local não está baixado. Baixe-o em Configurações › IA neste PC.",
        )?;
        let mut args: Vec<String> = vec![
            "-m".into(),
            files.model,
            "--mmproj".into(),
            files.mmproj,
            "--host".into(),
            "127.0.0.1".into(),
            "--port".into(),
            PORT.to_string(),
            // Uma página por vez, com espaço para ela; o contexto em 8 bits ocupa metade da memória.
            "--parallel".into(),
            "1".into(),
            "--ctx-size".into(),
            context_size(id).to_string(),
            "--cache-type-k".into(),
            "q8_0".into(),
            "--cache-type-v".into(),
            "q8_0".into(),
        ];
        if cpu {
            args.extend(["--n-gpu-layers", "0", "--no-mmproj-offload"].map(String::from));
        } else {
            args.extend(["--fit", "on"].map(String::from));
        }
        // Responde direto: pensar antes leva minutos numa placa pequena e não muda nada aqui.
        args.extend(["--reasoning-budget", "0", "--no-webui"].map(String::from));
        let mut command = Command::new(&exe);
        command
            .args(&args)
            .current_dir(exe.parent().unwrap())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000);
        }
        let child = command
            .spawn()
            .context("não deu para abrir o llama-server")?;
        *slot = Some(Server {
            model: id.to_string(),
            child,
            used: Instant::now(),
        });
    }
    wait_ready().await
}

/// O servidor responde em /health quando o modelo terminou de carregar (segundos a um minuto).
async fn wait_ready() -> anyhow::Result<()> {
    let started = Instant::now();
    let client = reqwest::Client::new();
    loop {
        if SERVER
            .lock()
            .as_mut()
            .is_none_or(|s| s.child.try_wait().ok().flatten().is_some())
        {
            bail!("A IA local não abriu (o llama-server fechou).");
        }
        if client
            .get(format!("http://127.0.0.1:{PORT}/health"))
            .timeout(Duration::from_secs(2))
            .send()
            .await
            .is_ok_and(|r| r.status().is_success())
        {
            return Ok(());
        }
        if started.elapsed() > Duration::from_secs(300) {
            stop();
            bail!("A IA local demorou demais para carregar o modelo.");
        }
        tokio::time::sleep(Duration::from_millis(700)).await;
    }
}

/// Libera a placa de vídeo.
pub fn stop() {
    if let Some(mut s) = SERVER.lock().take() {
        let _ = s.child.kill();
    }
}

/// Desliga o servidor parado há mais de alguns minutos; chamado de tempos em tempos.
pub fn stop_if_idle() {
    let idle = SERVER
        .lock()
        .as_ref()
        .is_some_and(|s| s.used.elapsed() > IDLE);
    if idle {
        stop();
    }
}
