import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { AiMonitorStatus, AiStopTarget, GpuStatus, LocalAiId, LocalAiStatus } from '../shared/types'
import { stopVision, visionPid } from './vision'

/**
 * What the local AIs are doing on the GPU. nvidia-smi gives the card's totals quickly; memory per
 * process only comes from Windows performance counters, which take seconds to read, so a PowerShell
 * loop reads them in the background while someone is looking (it stops once nobody asks for a while).
 */

const OLLAMA = 'http://localhost:11434'
/** The sampler stops when no status was asked for in this long. */
const IDLE_MS = 15_000
const MiB = 1024 * 1024

interface ProcRow {
  pid: number
  name: string
  cmd: string
}

interface Sample {
  procs: ProcRow[]
  /** Dedicated memory of every process on the busiest adapter (the discrete GPU), bytes, by pid. */
  memory: Record<number, number>
}

const SAMPLER = `
$ErrorActionPreference = 'SilentlyContinue'
while ($true) {
  $adapter = (Get-Counter '\\GPU Adapter Memory(*)\\Dedicated Usage').CounterSamples | Sort-Object CookedValue -Descending | Select-Object -First 1
  $luid = ($adapter.InstanceName -replace '_phys.*$', '')
  $memory = @{}
  foreach ($s in (Get-Counter '\\GPU Process Memory(*)\\Dedicated Usage').CounterSamples) {
    if ($s.CookedValue -gt 0 -and $s.InstanceName -like "*$luid*" -and $s.InstanceName -match '^pid_(\\d+)_') {
      $memory[$Matches[1]] = [int64]$s.CookedValue + [int64]$memory[$Matches[1]]
    }
  }
  $procs = @(Get-CimInstance Win32_Process | Where-Object { $memory.ContainsKey([string]$_.ProcessId) -or $_.Name -like 'ollama*' -or $_.Name -like 'llama-server*' -or ($_.Name -like 'python*' -and $_.CommandLine -match 'manga_vision') } |
    ForEach-Object { @{ pid = $_.ProcessId; name = $_.Name; cmd = [string]$_.CommandLine } })
  [Console]::Out.WriteLine((@{ procs = $procs; memory = $memory } | ConvertTo-Json -Compress -Depth 4))
  Start-Sleep -Seconds 2
}
`

let sampler: ChildProcessWithoutNullStreams | null = null
let lastSample: Sample | null = null
let lastAsked = 0
let idleTimer: NodeJS.Timeout | null = null

function ensureSampler(): void {
  lastAsked = Date.now()
  if (sampler || process.platform !== 'win32') return
  const script = Buffer.from(SAMPLER, 'utf16le').toString('base64')
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', script], { windowsHide: true })
  sampler = child
  createInterface({ input: child.stdout }).on('line', (line) => {
    try {
      const raw = JSON.parse(line) as { procs: ProcRow[] | ProcRow | null; memory: Record<string, number> }
      const procs = Array.isArray(raw.procs) ? raw.procs : raw.procs ? [raw.procs] : []
      const memory: Record<number, number> = {}
      for (const [pid, bytes] of Object.entries(raw.memory ?? {})) memory[Number(pid)] = bytes
      lastSample = { procs, memory }
    } catch {
      // A partial line while PowerShell starts: the next one comes in two seconds.
    }
  })
  child.on('exit', () => {
    if (sampler === child) sampler = null
  })
  child.stdin.end()
  idleTimer ??= setInterval(() => {
    if (Date.now() - lastAsked < IDLE_MS) return
    stopMonitor()
  }, 5_000)
}

export function stopMonitor(): void {
  sampler?.kill()
  sampler = null
  lastSample = null
  if (idleTimer) clearInterval(idleTimer)
  idleTimer = null
}

export function gpuTotals(): Promise<GpuStatus | null> {
  return new Promise((resolve) => {
    execFile(
      'nvidia-smi',
      ['--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu', '--format=csv,noheader,nounits'],
      { windowsHide: true, timeout: 5_000 },
      (err, stdout) => {
        if (err) return resolve(null)
        const [name, util, used, total, temp] = stdout.trim().split('\n')[0].split(',').map((s) => s.trim())
        resolve({
          name,
          utilization: Number(util) || 0,
          memoryUsed: Number(used) || 0,
          memoryTotal: Number(total) || 0,
          temperature: Number.isFinite(Number(temp)) ? Number(temp) : null
        })
      }
    )
  })
}

interface OllamaModel {
  name: string
  size: number
  size_vram: number
}

async function ollamaModels(): Promise<OllamaModel[] | null> {
  try {
    const res = await fetch(`${OLLAMA}/api/ps`, { signal: AbortSignal.timeout(1_500) })
    if (!res.ok) return null
    return ((await res.json()) as { models?: OllamaModel[] }).models ?? []
  } catch {
    return null
  }
}

function owner(p: ProcRow): LocalAiId | null {
  // Ollama runs each loaded model in a llama-server process of its own.
  if (/^ollama|^llama-server/i.test(p.name)) return 'ollama'
  if (/manga_vision/i.test(p.cmd)) return 'vision'
  return null
}

const AIS: Record<LocalAiId, { name: string; role: string }> = {
  vision: { name: 'Servidor de visão', role: 'Detecção de texto e balões, apagamento (LaMa)' },
  ollama: { name: 'Ollama', role: 'Modelos de linguagem locais (tradução)' }
}

export async function aiStatus(): Promise<AiMonitorStatus> {
  ensureSampler()
  const [gpu, models] = await Promise.all([gpuTotals(), ollamaModels()])
  const sample = lastSample
  const procs = sample?.procs ?? []
  const own = visionPid()
  const ais: LocalAiStatus[] = (Object.keys(AIS) as LocalAiId[]).map((id) => {
    const pids = procs.filter((p) => owner(p) === id).map((p) => p.pid)
    if (id === 'vision' && own && !pids.includes(own)) pids.push(own)
    const memory = sample ? pids.reduce((sum, pid) => sum + (sample.memory[pid] ?? 0), 0) / MiB : null
    return {
      id,
      ...AIS[id],
      running: pids.length > 0 || (id === 'ollama' && models !== null),
      pids,
      gpuMemory: memory === null ? null : Math.round(memory),
      models:
        id === 'ollama' && models
          ? models.map((m) => ({ name: m.name, sizeMiB: Math.round(m.size / MiB), gpuMiB: Math.round(m.size_vram / MiB) }))
          : []
    }
  })
  const ours = new Set(ais.flatMap((a) => a.pids))
  const names = new Map(procs.map((p) => [p.pid, p.name]))
  // Some programs (the desktop compositor, some games) report more than the card holds: no real reading.
  const card = gpu?.memoryTotal ?? Infinity
  const others = Object.entries(sample?.memory ?? {})
    .map(([pid, bytes]) => {
      const mib = Math.round(bytes / MiB)
      return { pid: Number(pid), name: names.get(Number(pid)) ?? `PID ${pid}`, gpuMemory: Math.min(mib, card), capped: mib > card }
    })
    // The desktop compositor counts memory it shares with every window.
    .filter((p) => !ours.has(p.pid) && p.gpuMemory >= 50 && !/^dwm/i.test(p.name))
    .sort((a, b) => b.gpuMemory - a.gpuMemory)
    .slice(0, 4)
  return { gpu, ais, others }
}

/** Stops what the monitor's buttons ask for; Ollama's models are unloaded before its processes end. */
export async function stopAi(target: AiStopTarget): Promise<void> {
  // Processes started outside the app are known from the monitor's last reading; translation runs that
  // only free the GPU don't start the (slow) reader for that.
  const procs = lastSample?.procs ?? []
  const pidsOf = (id: LocalAiId): number[] => procs.filter((p) => owner(p) === id).map((p) => p.pid)
  const kill = (pids: number[]): void => {
    for (const pid of pids) {
      try {
        process.kill(pid)
      } catch {
        // Already gone.
      }
    }
  }
  if (target === 'ollama-models' || target === 'ollama' || target === 'all') {
    const models = (await ollamaModels()) ?? []
    await Promise.all(
      models.map((m) =>
        fetch(`${OLLAMA}/api/generate`, {
          method: 'POST',
          body: JSON.stringify({ model: m.name, keep_alive: 0 }),
          signal: AbortSignal.timeout(10_000)
        }).catch(() => undefined)
      )
    )
  }
  if (target === 'vision' || target === 'all') {
    stopVision()
    kill(pidsOf('vision'))
  }
  if (target === 'ollama' || target === 'all') kill(pidsOf('ollama'))
  // The next reading should not show what was just stopped.
  lastSample = null
}
