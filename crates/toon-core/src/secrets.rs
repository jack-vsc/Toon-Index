//! Chaves de API guardadas criptografadas. O formato é o do `safeStorage` do Electron, para as chaves
//! que já estavam salvas continuarem valendo: `v10` + nonce de 12 bytes + AES-256-GCM, com a chave AES
//! protegida pelo DPAPI do Windows no arquivo `Local State` (`os_crypt.encrypted_key`). Nada aqui
//! escreve uma chave em log ou na tela.

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use anyhow::{Context, anyhow, bail};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use serde_json::Value;

use crate::paths::data_dir;

const PREFIX: &[u8] = b"v10";

/// A chave AES do `Local State`, criada na primeira vez que alguma chave é guardada.
fn master_key() -> anyhow::Result<[u8; 32]> {
    let path = data_dir().join("Local State");
    let mut state: Value = std::fs::read(&path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    if let Some(encoded) = state.pointer("/os_crypt/encrypted_key").and_then(Value::as_str) {
        let blob = B64.decode(encoded).context("Local State com chave ilegível")?;
        let protected = blob.strip_prefix(b"DPAPI").ok_or_else(|| anyhow!("Local State sem o prefixo DPAPI"))?;
        let key = dpapi::unprotect(protected)?;
        return key.try_into().map_err(|_| anyhow!("chave mestra com tamanho errado"));
    }
    let mut key = [0u8; 32];
    getrandom(&mut key)?;
    let mut blob = b"DPAPI".to_vec();
    blob.extend(dpapi::protect(&key)?);
    let obj = state.as_object_mut().ok_or_else(|| anyhow!("Local State não é um objeto"))?;
    obj.entry("os_crypt").or_insert_with(|| serde_json::json!({}))["encrypted_key"] = Value::String(B64.encode(blob));
    crate::store::write_json(&path, &state)?;
    Ok(key)
}

fn getrandom(buf: &mut [u8]) -> anyhow::Result<()> {
    // Dois uuid v4 dão 32 bytes do gerador do sistema, sem outra dependência.
    let a = uuid::Uuid::new_v4();
    let b = uuid::Uuid::new_v4();
    let bytes: Vec<u8> = a.as_bytes().iter().chain(b.as_bytes()).copied().collect();
    buf.copy_from_slice(&bytes[..buf.len()]);
    Ok(())
}

pub fn encrypt(plain: &str) -> anyhow::Result<String> {
    let key = master_key()?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| anyhow!("chave mestra inválida"))?;
    let mut nonce = [0u8; 12];
    getrandom(&mut nonce)?;
    let sealed = cipher.encrypt(Nonce::from_slice(&nonce), plain.as_bytes()).map_err(|_| anyhow!("falha ao criptografar"))?;
    let mut out = PREFIX.to_vec();
    out.extend(nonce);
    out.extend(sealed);
    Ok(B64.encode(out))
}

pub fn decrypt(encoded: &str) -> anyhow::Result<String> {
    let blob = B64.decode(encoded.trim())?;
    let Some(rest) = blob.strip_prefix(PREFIX) else {
        // Guardada pelo DPAPI direto, sem a chave mestra.
        return Ok(String::from_utf8(dpapi::unprotect(&blob)?)?);
    };
    if rest.len() < 12 + 16 {
        bail!("chave guardada curta demais");
    }
    let key = master_key()?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| anyhow!("chave mestra inválida"))?;
    let (nonce, sealed) = rest.split_at(12);
    let plain = cipher.decrypt(Nonce::from_slice(nonce), sealed).map_err(|_| anyhow!("não deu para abrir a chave guardada"))?;
    Ok(String::from_utf8(plain)?)
}

#[cfg(windows)]
mod dpapi {
    use anyhow::bail;
    use windows::Win32::Foundation::{HLOCAL, LocalFree};
    use windows::Win32::Security::Cryptography::{CRYPT_INTEGER_BLOB, CryptProtectData, CryptUnprotectData};

    fn run(input: &[u8], protect: bool) -> anyhow::Result<Vec<u8>> {
        let blob_in = CRYPT_INTEGER_BLOB { cbData: input.len() as u32, pbData: input.as_ptr() as *mut u8 };
        let mut out = CRYPT_INTEGER_BLOB::default();
        // SAFETY: as estruturas vivem durante a chamada; a saída é liberada com LocalFree logo depois de copiada.
        unsafe {
            let ok = if protect {
                CryptProtectData(&blob_in, None, None, None, None, 0, &mut out)
            } else {
                CryptUnprotectData(&blob_in, None, None, None, None, 0, &mut out)
            };
            if ok.is_err() {
                bail!("o Windows recusou abrir a chave (DPAPI)");
            }
            let bytes = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
            let _ = LocalFree(Some(HLOCAL(out.pbData as _)));
            Ok(bytes)
        }
    }

    pub fn protect(data: &[u8]) -> anyhow::Result<Vec<u8>> {
        run(data, true)
    }

    pub fn unprotect(data: &[u8]) -> anyhow::Result<Vec<u8>> {
        run(data, false)
    }
}

#[cfg(not(windows))]
mod dpapi {
    // Fora do Windows não há DPAPI: as chaves ficam com a proteção do próprio arquivo de dados.
    pub fn protect(data: &[u8]) -> anyhow::Result<Vec<u8>> {
        Ok(data.to_vec())
    }

    pub fn unprotect(data: &[u8]) -> anyhow::Result<Vec<u8>> {
        Ok(data.to_vec())
    }
}
