use std::fs;
use std::io::Write;
use std::path::Path;

use anyhow::Context;
use serde::Serialize;
use serde::de::DeserializeOwned;

/// Lê um JSON; arquivo ausente ou estragado vira o valor padrão, como o app sempre fez.
pub fn read_json<T: DeserializeOwned + Default>(path: &Path) -> T {
    fs::read(path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

/// Grava num arquivo ao lado e troca pelo de verdade: um app fechado no meio não deixa JSON pela metade.
pub fn write_json<T: Serialize>(path: &Path, value: &T) -> anyhow::Result<()> {
    let text = serde_json::to_vec_pretty(value)?;
    write_atomic(path, &text)
}

pub fn write_atomic(path: &Path, bytes: &[u8]) -> anyhow::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension(format!(
        "{}.tmp",
        path.extension().and_then(|e| e.to_str()).unwrap_or("")
    ));
    {
        let mut file =
            fs::File::create(&tmp).with_context(|| format!("criando {}", tmp.display()))?;
        file.write_all(bytes)?;
        file.sync_all()?;
    }
    fs::rename(&tmp, path).with_context(|| format!("gravando {}", path.display()))?;
    Ok(())
}
