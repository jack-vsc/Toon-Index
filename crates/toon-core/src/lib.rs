//! Os dados do Toon Index, no mesmo formato que a versão em Electron gravava em
//! `%APPDATA%\Manga Index`: quem já usava o app abre a biblioteca como estava.

pub mod library;
pub mod names;
pub mod paths;
pub mod reading;
pub mod secrets;
pub mod settings;
pub mod store;
pub mod works;

/// Milissegundos desde 1970, como o `Date.now()` que gravou os arquivos.
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
