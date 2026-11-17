use std::path::PathBuf;
use std::sync::OnceLock;

static ROOT: OnceLock<PathBuf> = OnceLock::new();

/// A pasta de dados: `%APPDATA%\Manga Index`, o nome que o app tinha quando nasceu.
/// `TOON_DATA_DIR` aponta para outra (testes, uma cópia da biblioteca).
pub fn data_dir() -> PathBuf {
    ROOT.get_or_init(|| {
        std::env::var_os("TOON_DATA_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                dirs::config_dir()
                    .unwrap_or_else(|| PathBuf::from("."))
                    .join("Manga Index")
            })
    })
    .clone()
}

/// Usa outra pasta de dados nesta execução; precisa vir antes de qualquer leitura.
pub fn set_data_dir(dir: PathBuf) {
    let _ = ROOT.set(dir);
}

pub fn library_dir() -> PathBuf {
    data_dir().join("library")
}

pub fn settings_file() -> PathBuf {
    data_dir().join("settings.json")
}

pub fn layers_dir() -> PathBuf {
    data_dir().join("translation-layers")
}

pub fn translation_cache_dir() -> PathBuf {
    data_dir().join("translation-cache")
}

pub fn dataset_dir() -> PathBuf {
    std::env::var_os("MI_DATASET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| data_dir().join("training-dataset"))
}

/// Perfil do navegador que o app controla para ler os sites (cookies, verificações já passadas).
pub fn browser_profile_dir() -> PathBuf {
    data_dir().join("browser-profile")
}

/// Contas dos sites, `SITE_USER`/`SITE_PASS` por site: só o app lê, nunca vai para a tela nem para logs.
pub fn site_logins_file() -> PathBuf {
    data_dir().join("site-logins.env")
}

/// Um id gerado pelo app (uuid): impede que um id vindo de fora aponte para fora da pasta.
pub fn checked_id(id: &str) -> anyhow::Result<&str> {
    if !id.is_empty() && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
        Ok(id)
    } else {
        anyhow::bail!("ID inválido")
    }
}
