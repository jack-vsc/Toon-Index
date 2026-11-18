#![windows_subsystem = "windows"]
//! Toon Index: traduz capítulos de mangá e webtoon com IA, guarda na biblioteca e acompanha a leitura,
//! no PC, no celular (pelo app Flutter em `mobile/`) e no navegador (pela extensão em `extension/`).

mod cloud;
mod engine;
mod notify;
mod tasks;
mod tray;
mod ui;

use std::sync::Arc;

fn main() -> eframe::Result {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();
    // Uma cópia só: com o app já aberto (talvez escondido na bandeja), o atalho traz a janela dele.
    // As capturas de tela dos testes rodam ao lado do app aberto, com outra pasta de dados.
    let screenshot = std::env::args().any(|a| a == "--screenshot");
    if !screenshot && tray::focus_running_copy() {
        return Ok(());
    }
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("runtime");
    let engine = Arc::new(engine::Engine::default());
    engine::start(engine.clone(), &runtime);
    // Aberto com o Windows (--minimized): começa escondido na bandeja, como a versão em Electron.
    let hidden = tray::starts_hidden();
    let mut viewport = eframe::egui::ViewportBuilder::default()
        .with_title(tray::TITLE)
        .with_inner_size([1280.0, 820.0])
        .with_min_inner_size([900.0, 600.0])
        .with_visible(!hidden);
    if let Some(icon) = tray::window_icon() {
        viewport = viewport.with_icon(std::sync::Arc::new(icon));
    }
    let options = eframe::NativeOptions {
        viewport,
        // Escondida na bandeja, a janela tem tamanho zero: guardar isso a faria abrir minúscula.
        persist_window: false,
        ..Default::default()
    };
    let result = eframe::run_native(
        "Toon Index",
        options,
        Box::new(move |cc| Ok(Box::new(ui::App::new(cc, engine, runtime)))),
    );
    // O modelo local não fica ocupando a placa de vídeo depois que a janela fecha.
    toon_ai::local::stop();
    toon_page::vision::stop();
    result
}
