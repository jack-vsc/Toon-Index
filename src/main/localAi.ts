import { app, net, type WebContents } from 'electron'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { LocalAiEngine, LocalAiModelStatus, LocalAiProgress, LocalAiState } from '../shared/types'
import { getSettings } from './settings'

/**
 * Translation models run by the app itself, with no other program to install: llama.cpp's server
 * (downloaded once, the build for the computer's graphics card) and Google's Gemma models, downloaded
 * from Hugging Face or taken from Ollama when it has them already. The server starts when a page is
 * translated with the "Neste PC" profile and stops when unused or when the GPU is freed.
 */

/** The llama.cpp build the app downloads (github.com/ggml-org/llama.cpp/releases). */
const BUILD = 'b11870'
const RELEASE = `https://github.com/ggml-org/llama.cpp/releases/download/${BUILD}`

interface Download {
  url: string
  name: string
  sha256: string
  size: number
}

const ENGINES: Record<LocalAiEngine, { label: string; files: Download[] }> = {
  // CUDA for NVIDIA cards: fastest there, with CUDA's own libraries alongside.
  cuda: {
    label: 'NVIDIA (CUDA)',
    files: [
      {
        url: `${RELEASE}/llama-${BUILD}-bin-win-cuda-12.4-x64.zip`,
        name: 'llama-cuda.zip',
        sha256: '0e3c2ed58e08362c37274e578b20bfaa5c73970052f333be832f139ce2ee0f48',
        size: 272_663_995
      },
      {
        url: `${RELEASE}/cudart-llama-bin-win-cuda-12.4-x64.zip`,
        name: 'cudart.zip',
        sha256: '8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6',
        size: 391_443_627
      }
    ]
  },
  // Vulkan for every other card (AMD, Intel), and the processor when there is none.
  vulkan: {
    label: 'Qualquer placa (Vulkan)',
    files: [
      {
        url: `${RELEASE}/llama-${BUILD}-bin-win-vulkan-x64.zip`,
        name: 'llama-vulkan.zip',
        sha256: '2420f932bad0ca5838f7d5881f213272ae651a3409218bca37f4be8305b24fd3',
        size: 37_035_796
      }
    ]
  }
}

interface ModelInfo {
  id: string
  label: string
  note: string
  model: Download
  mmproj: Download
  /** The same model in Ollama, used instead of downloading it again. */
  ollama?: string
  /** Context for a page and its answer (8192 when unset); Qwen reads an image in more tokens than Gemma. */
  ctx?: number
}

const HF = 'https://huggingface.co'

/** Google's own files (Apache 2.0), the 4-bit "QAT" versions trained to lose little in compression. */
export const MODELS: ModelInfo[] = [
  // Qwen3.5-2B (Apache 2.0) trained on this app's own Claude translations (Manga Detector Pipeline,
  // runs/q35-2b), Q8_0. Not published anywhere yet: its files are put in place by hand (no url).
  {
    id: 'qwen35-manga-2b',
    label: 'Qwen3.5-2B treinado',
    note: 'Treinado com as traduções do Claude: o mais fiel e o mais rápido; cabe em placas de 4 GB.',
    model: {
      url: '',
      name: 'model.gguf',
      sha256: '8f6a2f8375baf8a13cf6121613dfeb61ac03ea572ad8e4b8b8a2ea969d1e99a0',
      size: 2_012_012_192
    },
    mmproj: {
      url: '',
      name: 'mmproj.gguf',
      sha256: '77d7cb2a85629bfeee146d43be07cc54394926e9aeb0822cd7a820b360817289',
      size: 668_226_592
    },
    // Pages of several slices reach ~9-10k tokens here.
    ctx: 16384
  },
  {
    id: 'gemma-4-e4b',
    label: 'Gemma 4 E4B',
    note: 'Rápido; cabe inteiro em placas de 4 GB.',
    model: {
      url: `${HF}/google/gemma-4-E4B-it-qat-q4_0-gguf/resolve/main/gemma-4-E4B_q4_0-it.gguf`,
      name: 'model.gguf',
      sha256: '676c35070db6dbe52f93e9c864ee0fba4eddea94b9c875d9cb10daff453fbaee',
      size: 5_154_941_280
    },
    mmproj: {
      url: `${HF}/google/gemma-4-E4B-it-qat-q4_0-gguf/resolve/main/gemma-4-E4B-it-mmproj.gguf`,
      name: 'mmproj.gguf',
      sha256: '7498a37cb619e55f2fcf87eb931f56e99389ed6d432e4c5c66110694c0d65578',
      size: 991_552_256
    },
    ollama: 'gemma4/e4b-it-qat'
  },
  {
    id: 'gemma-4-e2b',
    label: 'Gemma 4 E2B',
    note: 'Mais leve e mais rápido; lê o contexto com menos cuidado que o E4B.',
    model: {
      url: `${HF}/google/gemma-4-E2B-it-qat-q4_0-gguf/resolve/main/gemma-4-E2B_q4_0-it.gguf`,
      name: 'model.gguf',
      sha256: 'fa401b55b07ee70a54c6dae3903c783a6e65064312529ea57175cb5f8dec6634',
      size: 3_349_516_256
    },
    mmproj: {
      url: `${HF}/google/gemma-4-E2B-it-qat-q4_0-gguf/resolve/main/gemma-4-E2B-it-mmproj.gguf`,
      name: 'mmproj.gguf',
      sha256: '021059cce659fe7f9170d5599761d7bbaf644b798dab9503aca30dc43e6beb14',
      size: 986_833_664
    },
    ollama: 'gemma4/e2b-it-qat'
  }
]

/** Where the "Neste PC" profile sends pages (LOCAL_AI_BASE_URL). */
const LOCAL_PORT = 47380

/** The server leaves the GPU after this long without a page. */
const IDLE_MS = 5 * 60_000

const root = (): string => join(app.getPath('userData'), 'local-ai')
const engineDir = (engine: LocalAiEngine): string => join(root(), 'engine', engine)
const modelDir = (id: string): string => join(root(), 'models', id)

// ---- state shown in the settings ----

let progress: LocalAiProgress | null = null
let progressTarget: WebContents | null = null

function report(p: LocalAiProgress | null): void {
  progress = p
  if (progressTarget && !progressTarget.isDestroyed()) progressTarget.send('localai:progress', p)
}

export async function localAiState(): Promise<LocalAiState> {
  return {
    recommended: (await hasNvidia()) ? 'cuda' : 'vulkan',
    engines: (Object.keys(ENGINES) as LocalAiEngine[]).map((id) => ({
      id,
      label: ENGINES[id].label,
      size: ENGINES[id].files.reduce((s, f) => s + f.size, 0),
      installed: existsSync(join(engineDir(id), 'llama-server.exe'))
    })),
    models: MODELS.map((m): LocalAiModelStatus => ({
      id: m.id,
      label: m.label,
      note: m.note,
      size: m.model.size + m.mmproj.size,
      state: modelFiles(m.id) ? (readSource(m.id)?.fromOllama ? 'ollama' : 'downloaded') : ollamaFiles(m) ? 'in-ollama' : 'missing'
    })),
    progress,
    running: server ? { model: server.model } : null
  }
}

export function watchProgress(target: WebContents): void {
  progressTarget = target
}

let nvidia: Promise<boolean> | null = null
function hasNvidia(): Promise<boolean> {
  nvidia ??= new Promise((resolve) => execFile('nvidia-smi', ['-L'], { windowsHide: true }, (err, out) => resolve(!err && /GPU/.test(out))))
  return nvidia
}

// ---- downloads ----

let cancelled = false

export function cancelLocalDownload(): void {
  cancelled = true
}

/** Downloads `file` into `dir` checking its SHA-256, reporting as `task`. */
async function download(file: Download, dir: string, task: string, done: number, total: number): Promise<string> {
  mkdirSync(dir, { recursive: true })
  const target = join(dir, file.name)
  const partial = `${target}.part`
  const response = await net.fetch(file.url)
  if (!response.ok || !response.body) throw new Error(`O download respondeu ${response.status}: ${file.url}`)
  const hash = createHash('sha256')
  let received = 0
  let lastReport = 0
  const body = Readable.fromWeb(response.body as never)
  body.on('data', (chunk: Buffer) => {
    if (cancelled) body.destroy(new Error('Download cancelado.'))
    hash.update(chunk)
    received += chunk.length
    if (Date.now() - lastReport > 500) {
      lastReport = Date.now()
      report({ task, done: done + received, total })
    }
  })
  await pipeline(body, createWriteStream(partial))
  if (hash.digest('hex') !== file.sha256) {
    rmSync(partial, { force: true })
    throw new Error(`O arquivo baixado não confere com o original (${file.url}). Tente de novo.`)
  }
  renameSync(partial, target)
  return target
}

/** Downloads and unpacks llama.cpp's server for the graphics card. */
export async function installEngine(engine: LocalAiEngine): Promise<void> {
  cancelled = false
  const spec = ENGINES[engine]
  const total = spec.files.reduce((s, f) => s + f.size, 0)
  const dir = engineDir(engine)
  const temp = join(root(), 'downloads')
  try {
    let done = 0
    for (const file of spec.files) {
      const zip = await download(file, temp, `Baixando o motor (${spec.label})`, done, total)
      done += file.size
      report({ task: 'Descompactando o motor…', done, total })
      mkdirSync(dir, { recursive: true })
      // Windows' own tar opens zip files.
      await new Promise<void>((resolve, reject) =>
        execFile('tar', ['-xf', zip, '-C', dir], { windowsHide: true }, (err) => (err ? reject(new Error(`Não foi possível descompactar o motor: ${err.message}`)) : resolve()))
      )
      rmSync(zip, { force: true })
    }
    if (!existsSync(join(dir, 'llama-server.exe'))) throw new Error('O motor baixado não tem o llama-server.')
  } finally {
    report(null)
  }
}

/** Downloads a model's files (or takes Ollama's copies, when it has the model). */
export async function installModel(id: string, fromOllama: boolean): Promise<void> {
  const info = modelInfo(id)
  const dir = modelDir(id)
  if (fromOllama) {
    const files = ollamaFiles(info)
    if (!files) throw new Error('O Ollama não tem esse modelo.')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'source.json'), JSON.stringify({ ...files, fromOllama: true }, null, 2))
    return
  }
  if (!info.model.url) throw new Error(`O ${info.label} ainda não tem download: os arquivos são copiados à mão para ${dir}.`)
  cancelled = false
  const total = info.model.size + info.mmproj.size
  try {
    const model = await download(info.model, dir, `Baixando o ${info.label}`, 0, total)
    const mmproj = await download(info.mmproj, dir, `Baixando o ${info.label} (leitura de imagens)`, info.model.size, total)
    writeFileSync(join(dir, 'source.json'), JSON.stringify({ model, mmproj, fromOllama: false }, null, 2))
  } finally {
    report(null)
  }
}

export async function removeModel(id: string): Promise<void> {
  if (server?.model === id) stopLocalServer()
  // Ollama's files stay Ollama's.
  rmSync(modelDir(id), { recursive: true, force: true })
}

function modelInfo(id: string): ModelInfo {
  const info = MODELS.find((m) => m.id === id)
  if (!info) throw new Error(`Modelo desconhecido: ${id}`)
  return info
}

function readSource(id: string): { model: string; mmproj: string; fromOllama: boolean } | null {
  try {
    return JSON.parse(readFileSync(join(modelDir(id), 'source.json'), 'utf8'))
  } catch {
    return null
  }
}

function modelFiles(id: string): { model: string; mmproj: string } | null {
  const source = readSource(id)
  return source && existsSync(source.model) && existsSync(source.mmproj) ? source : null
}

/** The model's files in Ollama's store, when it pulled the same model. */
function ollamaFiles(info: ModelInfo): { model: string; mmproj: string } | null {
  if (!info.ollama) return null
  const models = process.env.OLLAMA_MODELS || join(homedir(), '.ollama', 'models')
  try {
    const manifest = JSON.parse(readFileSync(join(models, 'manifests', 'registry.ollama.ai', 'library', ...info.ollama.split('/')), 'utf8')) as {
      layers: { mediaType: string; digest: string }[]
    }
    const blob = (type: string): string | null => {
      const layer = manifest.layers.find((l) => l.mediaType === `application/vnd.ollama.image.${type}`)
      const path = layer && join(models, 'blobs', layer.digest.replace(':', '-'))
      return path && existsSync(path) ? path : null
    }
    const model = blob('model')
    const mmproj = blob('projector')
    return model && mmproj ? { model, mmproj } : null
  } catch {
    return null
  }
}

// ---- the server ----

let server: { model: string; proc: ChildProcess; ready: Promise<void> } | null = null
let idleTimer: NodeJS.Timeout | null = null

/** Started (or switched to `id`) before a page is sent; stops by itself once unused. */
export async function ensureLocalServer(id: string): Promise<void> {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(stopLocalServer, IDLE_MS)
  if (server?.model === id) return server.ready
  stopLocalServer()
  const files = modelFiles(id)
  if (!files) throw new Error('O modelo escolhido não está baixado. Baixe-o em Configurações › IA neste PC.')
  const engine = ((await hasNvidia()) && existsSync(join(engineDir('cuda'), 'llama-server.exe')) ? 'cuda' : 'vulkan') as LocalAiEngine
  const exe = join(engineDir(engine), 'llama-server.exe')
  if (!existsSync(exe)) throw new Error('O motor da IA local não está baixado. Baixe-o em Configurações › IA neste PC.')
  const cpu = getSettings().aiDevice === 'cpu'
  const args = [
    '-m', files.model,
    '--mmproj', files.mmproj,
    '--host', '127.0.0.1',
    '--port', String(LOCAL_PORT),
    // One page at a time with room for it (a page and its answer take a few thousand tokens); the
    // context kept in 8 bits takes half the memory for the same answers, so more of the model fits on
    // the card. --fit puts on the card what fits and the rest in the RAM.
    '--parallel', '1',
    '--ctx-size', String(modelInfo(id).ctx ?? 8192),
    '--cache-type-k', 'q8_0',
    '--cache-type-v', 'q8_0',
    ...(cpu ? ['--n-gpu-layers', '0', '--no-mmproj-offload'] : ['--fit', 'on']),
    // Answers straight away: thinking first takes minutes on a small card and changes nothing here.
    '--reasoning-budget', '0',
    '--no-webui'
  ]
  console.log(`[local-ai] starting ${id} on ${engine}`)
  const proc = spawn(exe, args, { cwd: engineDir(engine), windowsHide: true })
  let log = ''
  proc.stderr?.on('data', (d) => (log = (log + d.toString()).slice(-3000)))
  proc.stdout?.on('data', (d) => (log = (log + d.toString()).slice(-3000)))
  const ready = waitReady(proc, () => log)
  server = { model: id, proc, ready }
  proc.on('exit', (code) => {
    // Stopped on purpose it is no longer the server; otherwise it fell over, and the log says why.
    if (server?.proc !== proc) return
    server = null
    console.error(`[local-ai] server exited (${code}): ${log.trim().split('\n').slice(-6).join(' | ')}`)
  })
  try {
    await ready
  } catch (err) {
    stopLocalServer()
    throw err
  }
}

/** The server answers /health once the model is loaded (seconds to a minute). */
async function waitReady(proc: ChildProcess, log: () => string): Promise<void> {
  const started = Date.now()
  for (;;) {
    if (proc.exitCode !== null) throw new Error(`A IA local não abriu. ${log().trim().split('\n').slice(-4).join(' ')}`)
    try {
      const res = await fetch(`http://127.0.0.1:${LOCAL_PORT}/health`, { signal: AbortSignal.timeout(2000) })
      if (res.ok) return
    } catch {
      // Still loading.
    }
    if (Date.now() - started > 5 * 60_000) throw new Error('A IA local demorou demais para carregar o modelo.')
    await new Promise((r) => setTimeout(r, 700))
  }
}

/** Frees the GPU (between the phases of a run, from the icon by the clock, or when unused). */
export function stopLocalServer(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = null
  server?.proc.kill()
  server = null
}

app.on('will-quit', stopLocalServer)
