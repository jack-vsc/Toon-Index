//! Quanto espaço o app ocupa, por área, e limpar o que dá para refazer.

use std::path::Path;

use serde::Serialize;

use crate::paths::{data_dir, layers_dir, library_dir, translation_cache_dir};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    /// Capítulos da biblioteca (PDFs e capas).
    pub library: u64,
    /// Páginas traduzidas guardadas para refazer um capítulo em segundos.
    pub layers: u64,
    /// Respostas dos modelos guardadas.
    pub ai_cache: u64,
    /// Exemplos de treino.
    pub dataset: u64,
    /// O navegador que o app controla (cookies, cache).
    pub app_cache: u64,
}

fn size_of(path: &Path) -> u64 {
    let Ok(meta) = std::fs::symlink_metadata(path) else { return 0 };
    if meta.is_file() {
        return meta.len();
    }
    std::fs::read_dir(path).map(|dirs| dirs.flatten().map(|d| size_of(&d.path())).sum()).unwrap_or(0)
}

pub fn usage() -> Usage {
    let data = data_dir();
    Usage {
        library: size_of(&library_dir()),
        layers: size_of(&layers_dir()),
        ai_cache: size_of(&translation_cache_dir()),
        dataset: size_of(&crate::paths::dataset_dir()),
        app_cache: size_of(&data.join("browser-profile")) + size_of(&data.join("Cache")),
    }
}

/// Limpa uma área que o app refaz sozinho quando precisa. A biblioteca nunca é limpa por aqui.
pub fn clear(area: &str) -> anyhow::Result<Usage> {
    let dir = match area {
        "layers" => layers_dir(),
        "aiCache" => translation_cache_dir(),
        "appCache" => data_dir().join("browser-profile").join("Default").join("Cache"),
        _ => anyhow::bail!("Área desconhecida."),
    };
    if dir.exists() {
        std::fs::remove_dir_all(&dir)?;
    }
    Ok(usage())
}

/// "1,2 GB".
pub fn human(bytes: u64) -> String {
    let units = ["B", "KB", "MB", "GB", "TB"];
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit < units.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 { format!("{bytes} B") } else { format!("{value:.1} {}", units[unit]).replace('.', ",") }
}
