//! Celulares pareados, em `devices.json`. O celular recebe um token na hora do pareamento; o PC só
//! guarda o hash dele.

use std::net::IpAddr;
use std::path::PathBuf;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::paths::data_dir;
use crate::store::{read_json, write_json};
use crate::now_ms;

const PAIRING_MINUTES: i64 = 10;
const MAX_FAILURES: u32 = 5;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub id: String,
    pub name: String,
    pub paired_at: i64,
    pub last_seen: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredDevice {
    #[serde(flatten)]
    device: Device,
    token_hash: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Stored {
    #[serde(default)]
    enabled: bool,
    #[serde(default)]
    devices: Vec<StoredDevice>,
}

struct Pairing {
    code: String,
    expires_at: i64,
    failures: u32,
}

static PAIRING: Mutex<Option<Pairing>> = Mutex::new(None);
static LOCK: Mutex<()> = Mutex::new(());

fn path() -> PathBuf {
    data_dir().join("devices.json")
}

fn load() -> Stored {
    read_json(&path())
}

fn hash(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

fn random_hex(bytes: usize) -> String {
    (0..bytes.div_ceil(16)).flat_map(|_| *uuid::Uuid::new_v4().as_bytes()).take(bytes).map(|b| format!("{b:02x}")).collect()
}

/// Se o app atende celulares na rede (desligado: só este PC, para a extensão).
pub fn phones_enabled() -> bool {
    load().enabled
}

pub fn set_phones_enabled(enabled: bool) -> anyhow::Result<()> {
    let _g = LOCK.lock();
    let mut s = load();
    s.enabled = enabled;
    write_json(&path(), &s)
}

pub fn list() -> Vec<Device> {
    load().devices.into_iter().map(|d| d.device).collect()
}

#[derive(Debug, Clone, Serialize)]
pub struct Address {
    pub address: String,
    pub kind: &'static str,
}

/// Os endereços em que o celular acha o PC: rede de casa e Tailscale.
pub fn addresses() -> Vec<Address> {
    let mut found = Vec::new();
    for iface in local_ips() {
        let IpAddr::V4(ip) = iface else { continue };
        let [x, y, ..] = ip.octets();
        let tailscale = x == 100 && (64..128).contains(&y);
        if tailscale || x == 192 || x == 10 || (x == 172 && (16..32).contains(&y)) {
            found.push(Address { address: ip.to_string(), kind: if tailscale { "tailscale" } else { "lan" } });
        }
    }
    found.sort_by_key(|a| a.kind == "tailscale");
    found
}

/// Os IPs locais, pelo truque de abrir um socket UDP para fora (nada é enviado) e pelos nomes do PC.
fn local_ips() -> Vec<IpAddr> {
    let mut ips = Vec::new();
    for target in ["192.168.0.1:9", "10.0.0.1:9", "100.100.100.100:9", "8.8.8.8:9"] {
        if let Ok(s) = std::net::UdpSocket::bind("0.0.0.0:0") {
            if s.connect(target).is_ok() {
                if let Ok(a) = s.local_addr() {
                    if !ips.contains(&a.ip()) && !a.ip().is_unspecified() {
                        ips.push(a.ip());
                    }
                }
            }
        }
    }
    ips
}

pub struct PairingCode {
    pub code: String,
    pub expires_at: i64,
    /// O texto do QR: endereços, porta e código, para o celular ler.
    pub qr_text: String,
}

pub fn new_pairing_code(port: u16) -> PairingCode {
    let n = u32::from_le_bytes(uuid::Uuid::new_v4().as_bytes()[..4].try_into().unwrap()) % 1_000_000;
    let code = format!("{n:06}");
    let expires_at = now_ms() + PAIRING_MINUTES * 60_000;
    *PAIRING.lock() = Some(Pairing { code: code.clone(), expires_at, failures: 0 });
    let hosts: Vec<String> = addresses().into_iter().map(|a| a.address).collect();
    let qr_text = serde_json::json!({ "app": "manga-index", "port": port, "code": code, "hosts": hosts }).to_string();
    PairingCode { code, expires_at, qr_text }
}

/// Compara sem parar no primeiro caractere diferente, para o tempo de resposta não entregar o código.
fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// O celular manda o código mostrado no PC; recebe o token dele.
pub fn pair(code: &str, name: &str) -> Option<(String, Device)> {
    let mut slot = PAIRING.lock();
    let current = slot.as_mut()?;
    if now_ms() > current.expires_at {
        return None;
    }
    if !same(code, &current.code) {
        current.failures += 1;
        if current.failures >= MAX_FAILURES {
            *slot = None;
        }
        return None;
    }
    *slot = None;
    drop(slot);
    let token = random_hex(32);
    let name: String = name.trim().chars().take(60).collect();
    let device = Device { id: uuid::Uuid::new_v4().to_string(), name: if name.is_empty() { "Celular".into() } else { name }, paired_at: now_ms(), last_seen: None };
    let _g = LOCK.lock();
    let mut s = load();
    s.devices.push(StoredDevice { device: device.clone(), token_hash: hash(&token) });
    write_json(&path(), &s).ok()?;
    Some((token, device))
}

/// O aparelho dono do token, com o "visto por último" atualizado de minuto em minuto.
pub fn device_for(token: &str) -> Option<Device> {
    let h = hash(token);
    let _g = LOCK.lock();
    let mut s = load();
    let d = s.devices.iter_mut().find(|d| same(&d.token_hash, &h))?;
    if d.device.last_seen.is_none_or(|seen| now_ms() - seen > 60_000) {
        d.device.last_seen = Some(now_ms());
        let device = d.device.clone();
        let _ = write_json(&path(), &s);
        return Some(device);
    }
    Some(d.device.clone())
}

pub fn revoke(id: &str) -> anyhow::Result<()> {
    let _g = LOCK.lock();
    let mut s = load();
    s.devices.retain(|d| d.device.id != id);
    write_json(&path(), &s)
}
