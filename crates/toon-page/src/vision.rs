//! O servidor de visão em Python (`vision/manga_vision.py`): acha os blocos de texto, os balões e o
//! desenho das letras com redes treinadas em mangá, e repinta o que fica embaixo do texto com o LaMa.
//! O Python faz isso melhor que qualquer coisa escrita à mão; o app o abre como programa à parte, na
//! pasta escolhida nas configurações (com o `.venv` e os modelos), e conversa por uma linha de JSON por
//! pedido. Sem a pasta, sem o Python ou com o servidor caído, a página segue pelo detector e pelo
//! apagador próprios.

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, channel};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Context, anyhow, bail};
use image::{GrayImage, RgbImage};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::detect::{IBox, TextRegion};

/// O script vai junto do programa e é escrito na pasta de dados ao abrir o servidor.
const SCRIPT: &str = include_str!("../../../vision/manga_vision.py");
/// Os modelos sem os quais o servidor não abre (o detector de tipos de texto é opcional).
const REQUIRED: [&str; 3] = [
    "comictextdetector.pt.onnx",
    "bubble-seg.pt",
    "anime-manga-big-lama.pt",
];
/// Parado esse tempo, o servidor fecha e libera a placa de vídeo.
const IDLE: Duration = Duration::from_secs(5 * 60);
/// Um servidor que não abriu não é tentado de novo a cada página.
const RETRY_AFTER: Duration = Duration::from_secs(2 * 60);
/// Carregar os modelos no processador leva minutos; uma página, segundos na placa e minutos sem ela.
const LOAD_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const CALL_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// Fração da caixa que as letras de uma onomatopeia precisam cobrir para ela ser apagada e reescrita:
/// abaixo disso os modelos veem pouco letreiro ali, e o modelo de tradução pode ter lido um rosto
/// como uma (no capítulo 53, efeitos de verdade cobriam 18 a 68% da caixa; um rosto, 10%).
pub const SFX_MIN_COVERAGE: f32 = 0.15;

/// Um bloco de texto achado pelos modelos, em pixels da página.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VisionBlock {
    #[serde(rename = "box")]
    pub bbox: [f32; 4],
    pub letter_height: f32,
    pub glyphs: usize,
    /// O balão em que o bloco está, -1 fora de um.
    #[serde(default)]
    pub bubble: i32,
}

#[derive(Deserialize)]
struct RawBubble {
    #[serde(rename = "box")]
    bbox: [f32; 4],
    polygon: Vec<[f32; 2]>,
    #[serde(default)]
    frame: bool,
}

/// O interior de um balão, rasterizado sobre a caixa dele.
#[derive(Debug, Clone)]
pub struct Bubble {
    pub bbox: IBox,
    pub w: usize,
    pub h: usize,
    /// 1 = dentro do balão, em coordenadas da caixa.
    pub mask: Vec<u8>,
    pub area: usize,
    /// Uma janela de sistema ou caixa de narração, não um balão de fala.
    pub frame: bool,
}

/// O que os modelos acharam numa página.
#[derive(Debug, Clone)]
pub struct Scene {
    pub width: usize,
    pub height: usize,
    pub blocks: Vec<VisionBlock>,
    pub bubbles: Vec<Bubble>,
    /// 1 = letreiro, largura × altura.
    pub text_mask: Vec<u8>,
}

/// As letras que o overlay achou num bloco: janela na página, tamanho e máscara (1 = letra).
pub struct GlyphMask<'a> {
    pub win: IBox,
    pub ww: usize,
    pub wh: usize,
    pub mask: &'a [u8],
}

// ---------------------------------------------------------------------------------------------------
// O processo
// ---------------------------------------------------------------------------------------------------

struct Config {
    dir: String,
    python: PathBuf,
    models: PathBuf,
    device: String,
}

struct Server {
    child: Child,
    stdin: ChildStdin,
    lines: Receiver<String>,
    stderr: Arc<Mutex<String>>,
    next_id: u64,
    used: Instant,
    dir: String,
    device: String,
}

static SERVER: Mutex<Option<Server>> = Mutex::new(None);
/// A pasta cujo servidor não abriu, e quando.
static FAILED: Mutex<Option<(String, Instant)>> = Mutex::new(None);
static NEXT_DIR: AtomicU64 = AtomicU64::new(1);

fn config() -> Result<Config, String> {
    let settings = toon_core::settings::load();
    let dir = std::env::var("TOON_VISION_DIR")
        .ok()
        .filter(|d| !d.trim().is_empty())
        .unwrap_or(settings.vision_dir)
        .trim()
        .to_string();
    if dir.is_empty() {
        return Err("Servidor de visão desligado (escolha a pasta dele).".into());
    }
    let root = Path::new(&dir);
    if !root.is_dir() {
        return Err(format!("A pasta {dir} não existe."));
    }
    let models = root.join("models").join("pretrained");
    let missing: Vec<&str> = REQUIRED
        .iter()
        .copied()
        .filter(|m| !models.join(m).exists())
        .collect();
    if !missing.is_empty() {
        return Err(format!(
            "Faltam modelos em {}: {}.",
            models.display(),
            missing.join(", ")
        ));
    }
    let python = [
        root.join(".venv").join("Scripts").join("python.exe"),
        root.join(".venv").join("bin").join("python"),
    ]
    .into_iter()
    .find(|p| p.exists())
    .unwrap_or_else(|| PathBuf::from("python"));
    Ok(Config {
        dir,
        python,
        models,
        device: if settings.vision_device == "cpu" {
            "cpu".into()
        } else {
            "gpu".into()
        },
    })
}

/// Se o servidor está pronto para usar, ou o que falta; não abre nada.
pub fn status() -> Result<String, String> {
    let c = config()?;
    if let Some((dir, at)) = FAILED.lock().unwrap().as_ref() {
        if *dir == c.dir && at.elapsed() < RETRY_AFTER {
            return Err(
                "O servidor de visão não abriu da última vez; o app tenta de novo em instantes."
                    .into(),
            );
        }
    }
    let running = SERVER.lock().unwrap().is_some();
    Ok(format!(
        "{} com {} ({}).",
        if running {
            "Ligado"
        } else {
            "Pronto para ligar"
        },
        c.python.display(),
        if c.device == "cpu" {
            "processador"
        } else {
            "placa de vídeo"
        }
    ))
}

fn write_script() -> anyhow::Result<PathBuf> {
    let path = toon_core::paths::data_dir()
        .join("vision")
        .join("manga_vision.py");
    if std::fs::read_to_string(&path).ok().as_deref() != Some(SCRIPT) {
        std::fs::create_dir_all(path.parent().unwrap())?;
        std::fs::write(&path, SCRIPT)?;
    }
    Ok(path)
}

fn start(c: &Config) -> anyhow::Result<Server> {
    let script = write_script()?;
    let mut command = Command::new(&c.python);
    command
        .arg("-u")
        .arg(&script)
        .current_dir(&c.dir)
        .env("MI_VISION_DEVICE", &c.device)
        .env("MI_VISION_MODELS", &c.models)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let mut child = command
        .spawn()
        .with_context(|| format!("não deu para abrir o Python ({})", c.python.display()))?;
    let stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    let stderr_pipe = child.stderr.take().unwrap();
    let (send, lines) = channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if send.send(line).is_err() {
                break;
            }
        }
    });
    let stderr = Arc::new(Mutex::new(String::new()));
    let tail = stderr.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stderr_pipe).lines().map_while(Result::ok) {
            if line.contains("[vision]") {
                tracing::info!("{line}");
            }
            let mut t = tail.lock().unwrap();
            t.push_str(&line);
            t.push('\n');
            if t.len() > 4000 {
                let cut = t.len() - 4000;
                let cut = (cut..t.len()).find(|i| t.is_char_boundary(*i)).unwrap_or(0);
                t.drain(..cut);
            }
        }
    });
    let mut server = Server {
        child,
        stdin,
        lines,
        stderr,
        next_id: 1,
        used: Instant::now(),
        dir: c.dir.clone(),
        device: c.device.clone(),
    };
    let started = Instant::now();
    loop {
        let left = LOAD_TIMEOUT.saturating_sub(started.elapsed());
        match server.lines.recv_timeout(left) {
            Ok(line) if line.contains("\"ready\"") => return Ok(server),
            Ok(_) => continue,
            Err(e) => {
                let _ = server.child.kill();
                let why = server.last_error();
                bail!(
                    "o servidor de visão {} ({why})",
                    if e == RecvTimeoutError::Timeout {
                        "demorou demais para carregar os modelos"
                    } else {
                        "fechou ao abrir"
                    }
                );
            }
        }
    }
}

impl Server {
    fn last_error(&self) -> String {
        let t = self.stderr.lock().unwrap();
        let lines: Vec<&str> = t.trim().lines().collect();
        lines[lines.len().saturating_sub(2)..].join(" ")
    }

    fn call(&mut self, request: Value) -> anyhow::Result<Value> {
        let id = self.next_id;
        self.next_id += 1;
        let mut request = request;
        request["id"] = json!(id);
        writeln!(self.stdin, "{request}")?;
        self.stdin.flush()?;
        let started = Instant::now();
        loop {
            let left = CALL_TIMEOUT.saturating_sub(started.elapsed());
            let line = self.lines.recv_timeout(left).map_err(|e| match e {
                RecvTimeoutError::Timeout => anyhow!("o servidor de visão não respondeu"),
                RecvTimeoutError::Disconnected => {
                    anyhow!("o servidor de visão fechou ({})", self.last_error())
                }
            })?;
            let Ok(answer) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if answer["id"] != json!(id) {
                continue;
            }
            if let Some(err) = answer["error"].as_str() {
                bail!("servidor de visão: {err}");
            }
            return Ok(answer);
        }
    }
}

/// Um pedido ao servidor, abrindo-o antes se preciso. Um pedido por vez: o Python responde em ordem.
fn call(request: Value) -> anyhow::Result<Value> {
    let c = config().map_err(|e| anyhow!(e))?;
    let mut slot = SERVER.lock().unwrap();
    // Trocou a pasta ou o aparelho nas configurações, ou o processo caiu: abre de novo.
    if let Some(s) = slot.as_mut() {
        if s.dir != c.dir || s.device != c.device || s.child.try_wait().ok().flatten().is_some() {
            let _ = s.child.kill();
            *slot = None;
        }
    }
    if slot.is_none() {
        if let Some((dir, at)) = FAILED.lock().unwrap().as_ref() {
            if *dir == c.dir && at.elapsed() < RETRY_AFTER {
                bail!("o servidor de visão não abriu há pouco");
            }
        }
        match start(&c) {
            Ok(s) => *slot = Some(s),
            Err(e) => {
                *FAILED.lock().unwrap() = Some((c.dir.clone(), Instant::now()));
                return Err(e);
            }
        }
    }
    let server = slot.as_mut().unwrap();
    server.used = Instant::now();
    let result = server.call(request);
    server.used = Instant::now();
    if result.is_err() && server.child.try_wait().ok().flatten().is_some() {
        *slot = None;
    }
    result
}

/// Fecha o servidor, liberando a placa de vídeo.
pub fn stop() {
    if let Some(mut s) = SERVER.lock().unwrap().take() {
        let _ = s.child.kill();
    }
}

/// Fecha o servidor parado há alguns minutos; chamado de tempos em tempos.
pub fn stop_if_idle() {
    let mut slot = SERVER.lock().unwrap();
    if slot.as_ref().is_some_and(|s| s.used.elapsed() > IDLE) {
        if let Some(mut s) = slot.take() {
            let _ = s.child.kill();
        }
    }
}

/// Uma pasta temporária para as imagens de um pedido, apagada no fim.
fn with_files<T>(run: impl FnOnce(&Path) -> anyhow::Result<T>) -> anyhow::Result<T> {
    let dir = std::env::temp_dir().join(format!(
        "toon-vision-{}-{}",
        std::process::id(),
        NEXT_DIR.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&dir)?;
    let result = run(&dir);
    let _ = std::fs::remove_dir_all(&dir);
    result
}

/// Os blocos, os balões e as letras da página; `None` sem o servidor (a página segue sem ele).
pub fn detect(image: &RgbImage) -> Option<Scene> {
    config().ok()?;
    let result = with_files(|dir| {
        let (page, mask) = (dir.join("page.png"), dir.join("mask.png"));
        image.save(&page)?;
        let answer = call(json!({ "cmd": "detect", "image": page, "mask": mask }))?;
        let blocks: Vec<VisionBlock> = serde_json::from_value(answer["blocks"].clone())?;
        let raw: Vec<RawBubble> = serde_json::from_value(answer["bubbles"].clone())?;
        let (w, h) = (image.width() as usize, image.height() as usize);
        let mut gray = image::open(&mask)?.to_luma8();
        if gray.dimensions() != image.dimensions() {
            gray = image::imageops::resize(
                &gray,
                image.width(),
                image.height(),
                image::imageops::FilterType::Triangle,
            );
        }
        let text_mask = gray.as_raw().iter().map(|&v| (v > 127) as u8).collect();
        let bubbles = raw.iter().map(|b| rasterize(b, w, h)).collect();
        Ok(Scene {
            width: w,
            height: h,
            blocks,
            bubbles,
            text_mask,
        })
    });
    match result {
        Ok(scene) => Some(scene),
        Err(e) => {
            tracing::warn!(
                "detecção dos modelos indisponível, seguindo com o detector próprio: {e:#}"
            );
            None
        }
    }
}

/// Repinta com o LaMa os pixels marcados (1) da máscara; `false` quando o servidor falhou.
pub fn inpaint(image: &mut RgbImage, mask: &[u8]) -> bool {
    let result = with_files(|dir| {
        let (page, erase, out) = (
            dir.join("page.png"),
            dir.join("erase.png"),
            dir.join("out.png"),
        );
        image.save(&page)?;
        GrayImage::from_raw(
            image.width(),
            image.height(),
            mask.iter().map(|&m| if m != 0 { 255 } else { 0 }).collect(),
        )
        .context("máscara de outro tamanho")?
        .save(&erase)?;
        call(json!({ "cmd": "inpaint", "image": page, "mask": erase, "out": out }))?;
        let clean = image::open(&out)?.to_rgb8();
        if clean.dimensions() != image.dimensions() {
            bail!("o LaMa devolveu uma página de outro tamanho");
        }
        Ok(clean)
    });
    match result {
        Ok(clean) => {
            *image = clean;
            true
        }
        Err(e) => {
            tracing::warn!("LaMa falhou, apagando com o preenchimento próprio: {e:#}");
            false
        }
    }
}

// ---------------------------------------------------------------------------------------------------
// Usar o que os modelos acharam
// ---------------------------------------------------------------------------------------------------

/// Preenche o polígono (par-ímpar, pelo centro de cada pixel) sobre a caixa do balão.
fn rasterize(b: &RawBubble, w: usize, h: usize) -> Bubble {
    let bbox: IBox = [
        (b.bbox[0].max(0.0) as usize).min(w),
        (b.bbox[1].max(0.0) as usize).min(h),
        (b.bbox[2].max(0.0).ceil() as usize).min(w),
        (b.bbox[3].max(0.0).ceil() as usize).min(h),
    ];
    let bw = bbox[2].saturating_sub(bbox[0]).max(1);
    let bh = bbox[3].saturating_sub(bbox[1]).max(1);
    let mut mask = vec![0u8; bw * bh];
    let mut area = 0;
    let n = b.polygon.len();
    let mut xs = Vec::new();
    for y in 0..bh {
        let py = (bbox[1] + y) as f32 + 0.5;
        xs.clear();
        for i in 0..n {
            let [x0, y0] = b.polygon[i];
            let [x1, y1] = b.polygon[(i + 1) % n];
            if (y0 <= py) != (y1 <= py) {
                xs.push(x0 + (py - y0) / (y1 - y0) * (x1 - x0));
            }
        }
        xs.sort_by(f32::total_cmp);
        for pair in xs.chunks_exact(2) {
            let from =
                ((pair[0] - 0.5).ceil().max(bbox[0] as f32) as usize).saturating_sub(bbox[0]);
            let to = ((pair[1] - 0.5).floor() + 1.0).max(0.0) as usize;
            let to = to.saturating_sub(bbox[0]).min(bw);
            for x in from..to {
                mask[y * bw + x] = 1;
                area += 1;
            }
        }
    }
    Bubble {
        bbox,
        w: bw,
        h: bh,
        mask,
        area,
        frame: b.frame,
    }
}

/// Os blocos dos modelos nas linhas y0..y1 da página, nas coordenadas da imagem da faixa (reduzida
/// por `scale`). Blocos cortados pela borda ficam para a faixa vizinha, a não ser com `cut`.
pub fn regions_in_slice(scene: &Scene, y0: f32, y1: f32, scale: f32, cut: bool) -> Vec<TextRegion> {
    scene
        .blocks
        .iter()
        .filter(|b| {
            if cut {
                b.bbox[3] > y0 && b.bbox[1] < y1
            } else {
                b.bbox[1] >= y0 && b.bbox[3] <= y1
            }
        })
        .map(|b| TextRegion {
            r#box: [
                (b.bbox[0] / scale).max(0.0).round() as usize,
                ((b.bbox[1] - y0) / scale).max(0.0).round() as usize,
                (b.bbox[2] / scale).max(0.0).round() as usize,
                ((b.bbox[3] - y0) / scale).max(0.0).round() as usize,
            ],
            letter_height: (b.letter_height / scale) as f64,
            glyphs: b.glyphs,
        })
        .collect()
}

/// Pixels da caixa dentro do balão.
pub fn inside_count(b: &Bubble, bx: [f32; 4]) -> usize {
    let x0 = (bx[0] - b.bbox[0] as f32).floor().max(0.0) as usize;
    let y0 = (bx[1] - b.bbox[1] as f32).floor().max(0.0) as usize;
    let x1 = ((bx[2] - b.bbox[0] as f32).ceil().max(0.0) as usize).min(b.w);
    let y1 = ((bx[3] - b.bbox[1] as f32).ceil().max(0.0) as usize).min(b.h);
    let mut n = 0;
    for y in y0..y1 {
        for x in x0..x1 {
            n += b.mask[y * b.w + x] as usize;
        }
    }
    n
}

/// O balão que contém a caixa: um contorno que cobre só parte do texto não é o balão dele.
pub fn bubble_at(scene: &Scene, bx: [f32; 4]) -> Option<&Bubble> {
    let area = ((bx[2] - bx[0]) * (bx[3] - bx[1])).max(1.0);
    let (best, inside) = scene
        .bubbles
        .iter()
        .map(|b| (b, inside_count(b, bx)))
        .filter(|(_, n)| *n > 0)
        .max_by_key(|(_, n)| *n)?;
    let cx = ((bx[0] + bx[2]) / 2.0).round() as i64 - best.bbox[0] as i64;
    let cy = ((bx[1] + bx[3]) / 2.0).round() as i64 - best.bbox[1] as i64;
    let centred = cx >= 0
        && cy >= 0
        && (cx as usize) < best.w
        && (cy as usize) < best.h
        && best.mask[cy as usize * best.w + cx as usize] == 1;
    let inside = inside as f32;
    (inside >= area * 0.85 || (centred && inside >= area * 0.6)).then_some(best)
}

/// Se o interior de um balão de fala ocupa boa parte da caixa, com o papel aparecendo ali: uma marca
/// d'água que divide a caixa com a fala do balão levaria a fala junto se fosse apagada.
pub fn touches_speech(image: &RgbImage, scene: &Scene, bx: [f32; 4]) -> bool {
    let area = (bx[2] - bx[0]) * (bx[3] - bx[1]);
    if !scene
        .bubbles
        .iter()
        .any(|b| !b.frame && inside_count(b, bx) as f32 > 0.15 * area)
    {
        return false;
    }
    let (x0, y0) = (bx[0].max(0.0) as u32, bx[1].max(0.0) as u32);
    let x1 = (bx[2].max(0.0) as u32).min(image.width());
    let y1 = (bx[3].max(0.0) as u32).min(image.height());
    if x1 <= x0 || y1 <= y0 {
        return false;
    }
    let mut paper = 0;
    for y in y0..y1 {
        for x in x0..x1 {
            let p = image.get_pixel(x, y);
            if p[0] > 235 && p[1] > 235 && p[2] > 235 {
                paper += 1;
            }
        }
    }
    paper as f32 > 0.25 * ((x1 - x0) * (y1 - y0)) as f32
}

fn clamp_box(b: [f32; 4], w: usize, h: usize) -> IBox {
    [
        (b[0].round().max(0.0) as usize).min(w),
        (b[1].round().max(0.0) as usize).min(h),
        (b[2].round().max(0.0) as usize).min(w),
        (b[3].round().max(0.0) as usize).min(h),
    ]
}

/// Pixels a repintar num bloco: as letras que os modelos e a busca do overlay acharam, crescidas sobre
/// a borda suavizada, e dentro de um balão toda a área do texto (a borda do balão fica).
pub fn add_erase_area(
    out: &mut [u8],
    scene: &Scene,
    bx: [f32; 4],
    letter_height: f32,
    glyphs: Option<GlyphMask>,
) {
    use crate::glyphs::{dilate, erode, odd};
    let (w, h) = (scene.width, scene.height);
    let bubble = bubble_at(scene, bx);
    let pad = (letter_height * if bubble.is_some() { 0.8 } else { 0.4 })
        .round()
        .max(4.0);
    let r = clamp_box([bx[0] - pad, bx[1] - pad, bx[2] + pad, bx[3] + pad], w, h);
    if let Some(b) = bubble {
        let k = odd(((letter_height * 0.25).round() as usize).max(3));
        let inner = erode(&b.mask, b.w, b.h, k);
        for y in r[1]..r[3] {
            for x in r[0]..r[2] {
                let (bx, by) = (x as i64 - b.bbox[0] as i64, y as i64 - b.bbox[1] as i64);
                if bx >= 0
                    && by >= 0
                    && (bx as usize) < b.w
                    && (by as usize) < b.h
                    && inner[by as usize * b.w + bx as usize] != 0
                {
                    out[y * w + x] = 1;
                }
            }
        }
    }
    let (rw, rh) = (r[2].saturating_sub(r[0]), r[3].saturating_sub(r[1]));
    if rw == 0 || rh == 0 {
        return;
    }
    let mut local = vec![0u8; rw * rh];
    for y in 0..rh {
        for x in 0..rw {
            local[y * rw + x] = scene.text_mask[(y + r[1]) * w + x + r[0]];
        }
    }
    if let Some(g) = glyphs {
        for y in 0..g.wh {
            for x in 0..g.ww {
                let (lx, ly) = (
                    (x + g.win[0]) as i64 - r[0] as i64,
                    (y + g.win[1]) as i64 - r[1] as i64,
                );
                if g.mask[y * g.ww + x] != 0
                    && lx >= 0
                    && ly >= 0
                    && (lx as usize) < rw
                    && (ly as usize) < rh
                {
                    local[ly as usize * rw + lx as usize] = 1;
                }
            }
        }
    }
    let grown = dilate(
        &local,
        rw,
        rh,
        odd(((letter_height * 0.45).round() as usize).max(5)),
    );
    for y in 0..rh {
        for x in 0..rw {
            if grown[y * rw + x] != 0 {
                out[(y + r[1]) * w + x + r[0]] = 1;
            }
        }
    }
}

/// Uma onomatopeia sobre o desenho: os pixels do letreiro dela na caixa (1 = letra).
pub struct SfxShape {
    pub bbox: IBox,
    pub w: usize,
    pub h: usize,
    pub mask: Vec<u8>,
    /// Fração da caixa coberta pelas letras.
    pub coverage: f32,
}

/// O letreiro de uma onomatopeia na caixa: o que os modelos marcam como texto e o que a busca achou.
pub fn sfx_shape(scene: &Scene, bx: [f32; 4], glyphs: Option<GlyphMask>) -> SfxShape {
    let r = clamp_box(bx, scene.width, scene.height);
    let w = r[2].saturating_sub(r[0]).max(1);
    let h = r[3].saturating_sub(r[1]).max(1);
    let mut mask = vec![0u8; w * h];
    let mut n = 0;
    for y in 0..h {
        for x in 0..w {
            let (px, py) = (x + r[0], y + r[1]);
            if px >= scene.width || py >= scene.height {
                continue;
            }
            let glyph = glyphs.as_ref().is_some_and(|g| {
                px >= g.win[0]
                    && py >= g.win[1]
                    && px - g.win[0] < g.ww
                    && py - g.win[1] < g.wh
                    && g.mask[(py - g.win[1]) * g.ww + px - g.win[0]] != 0
            });
            if scene.text_mask[py * scene.width + px] != 0 || glyph {
                mask[y * w + x] = 1;
                n += 1;
            }
        }
    }
    SfxShape {
        bbox: r,
        w,
        h,
        mask,
        coverage: n as f32 / (w * h) as f32,
    }
}

/// Pixels a repintar numa onomatopeia: os traços, crescidos sobre o contorno.
pub fn add_sfx_erase_area(out: &mut [u8], scene: &Scene, shape: &SfxShape) {
    use crate::glyphs::{dilate, odd};
    let k = odd((((shape.w.min(shape.h)) as f32 * 0.12).round() as usize).max(7));
    let grown = dilate(&shape.mask, shape.w, shape.h, k);
    for y in 0..shape.h {
        for x in 0..shape.w {
            let (px, py) = (x + shape.bbox[0], y + shape.bbox[1]);
            if grown[y * shape.w + x] != 0 && px < scene.width && py < scene.height {
                out[py * scene.width + px] = 1;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn square_polygon_fills_its_box() {
        let b = RawBubble {
            bbox: [10.0, 20.0, 30.0, 40.0],
            polygon: vec![[10.0, 20.0], [30.0, 20.0], [30.0, 40.0], [10.0, 40.0]],
            frame: false,
        };
        let bubble = rasterize(&b, 100, 100);
        assert_eq!((bubble.w, bubble.h), (20, 20));
        assert_eq!(bubble.area, 400);
    }

    #[test]
    fn block_inside_a_bubble_is_found() {
        let b = RawBubble {
            bbox: [0.0, 0.0, 50.0, 50.0],
            polygon: vec![[0.0, 0.0], [50.0, 0.0], [50.0, 50.0], [0.0, 50.0]],
            frame: false,
        };
        let scene = Scene {
            width: 100,
            height: 100,
            blocks: Vec::new(),
            bubbles: vec![rasterize(&b, 100, 100)],
            text_mask: vec![0; 100 * 100],
        };
        assert!(bubble_at(&scene, [10.0, 10.0, 30.0, 20.0]).is_some());
        assert!(bubble_at(&scene, [40.0, 40.0, 80.0, 80.0]).is_none());
    }
}
