#![windows_subsystem = "windows"]
//! Toon Index: traduz capítulos de mangá e webtoon com IA, guarda na biblioteca e acompanha a leitura,
//! no PC, no celular (pelo app Flutter em `mobile/`) e no navegador (pela extensão em `extension/`).

mod cloud;
mod engine;
mod notify;
mod tasks;
mod ui;

use std::sync::Arc;

fn main() -> eframe::Result {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("runtime");
    let engine = Arc::new(engine::Engine::default());
    engine::start(engine.clone(), &runtime);
    let options = eframe::NativeOptions {
        viewport: eframe::egui::ViewportBuilder::default()
            .with_title("Toon Index")
            .with_inner_size([1280.0, 820.0])
            .with_min_inner_size([900.0, 600.0]),
        ..Default::default()
    };
    let result = eframe::run_native(
        "Toon Index",
        options,
        Box::new(move |cc| Ok(Box::new(ui::App::new(cc, engine, runtime)))),
    );
    // O modelo local não fica ocupando a placa de vídeo depois que a janela fecha.
    toon_ai::local::stop();
    result
}
