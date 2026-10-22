import { spawn, ChildProcess, exec } from 'child_process'
import { join } from 'path'
import { readdirSync, statSync, readFileSync, existsSync, readFile, rmSync, mkdirSync, createWriteStream } from 'fs'
import { app, BrowserWindow } from 'electron'
import { createCanvas, loadImage } from 'canvas'

type ProcInfo = {
  proc: ChildProcess
  startedAt: number
  args: string[]
  poll?: NodeJS.Timeout
  lastLogSize: number
  runId: string
  stderrBuffer: string[]
  paused?: boolean
}

const runsDir = join(process.cwd(), 'runs', 'detect', 'runs', 'train')
/** If train.log / results.csv changed within this window, treat run as active (CLI / external). */
const EXTERNAL_ACTIVITY_MS = 90_000
const processes = new Map<string, ProcInfo>()

function broadcast(channel: string, ...args: any[]) {
  BrowserWindow.getAllWindows().forEach((w) => {
    try {
      w.webContents.send(channel, ...args)
    } catch {
      // ignore
    }
  })
}

export function listRuns(): string[] {
  try {
    if (!existsSync(runsDir)) return []
    return readdirSync(runsDir).filter((d) => {
      try {
        return statSync(join(runsDir, d)).isDirectory()
      } catch {
        return false
      }
    }).sort()
  } catch {
    return []
  }
}

function runActivityMtime(run: string): number {
  let latest = 0
  for (const name of ['train.log', 'results.csv']) {
    const p = join(runsDir, run, name)
    try {
      if (existsSync(p)) {
        const t = statSync(p).mtimeMs
        if (t > latest) latest = t
      }
    } catch {
      // ignore
    }
  }
  return latest
}

export function isRunExternallyActive(run: string): boolean {
  if (processes.has(run)) return false
  const t = runActivityMtime(run)
  if (!t) return false
  return Date.now() - t < EXTERNAL_ACTIVITY_MS
}

export function listExternallyActiveRuns(): string[] {
  return listRuns().filter((id) => isRunExternallyActive(id))
}

export function listActiveRuns(): string[] {
  const managed = [...processes.keys()]
  const external = listExternallyActiveRuns().filter((id) => !processes.has(id))
  const active = [...managed, ...external]
  console.log('trainManager: listActiveRuns returning', active)
  return active
}

export function listArtifacts(run: string): string[] {
  const dir = join(runsDir, run)
  if (!existsSync(dir)) return []
  const names = new Set<string>()
  const walk = (sub: string) => {
    const base = sub ? join(dir, sub) : dir
    if (!existsSync(base)) return
    for (const ent of readdirSync(base, { withFileTypes: true })) {
      const rel = sub ? `${sub}/${ent.name}` : ent.name
      if (ent.isDirectory()) {
        if (ent.name === 'weights') walk(rel)
        continue
      }
      if (/\.(png|jpg|jpeg|webp|pt|txt|json|csv)$/i.test(ent.name)) {
        names.add(rel.replace(/\\/g, '/'))
      }
    }
  }
  walk('')
  return [...names].sort()
}

export function getArtifactStamp(run: string): string {
  const dir = join(runsDir, run)
  if (!existsSync(dir)) return '0'
  const arts = listArtifacts(run).filter((a) => /\.(png|jpe?g|webp)$/i.test(a))
  let max = 0
  for (const a of arts) {
    try {
      const t = statSync(join(dir, a)).mtimeMs
      if (t > max) max = t
    } catch {
      // ignore
    }
  }
  return `${max}:${arts.length}`
}

function parseArgsYamlFile(run: string): Record<string, unknown> | null {
  const p = join(runsDir, run, 'args.yaml')
  if (!existsSync(p)) return null
  const txt = readFileSync(p, 'utf8')
  const out: Record<string, unknown> = {}
  for (const line of txt.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const idx = trimmed.indexOf(':')
    if (idx < 0) continue
    const key = trimmed.slice(0, idx).trim()
    let raw = trimmed.slice(idx + 1).trim()
    if (raw === 'null' || raw === '~') out[key] = null
    else if (raw === 'true') out[key] = true
    else if (raw === 'false') out[key] = false
    else if (/^-?\d+$/.test(raw)) out[key] = Number(raw)
    else if (/^-?\d+\.\d+$/.test(raw)) out[key] = Number(raw)
    else out[key] = raw.replace(/^['"]|['"]$/g, '')
  }
  return out
}

function quoteArg(v: string): string {
  return /\s/.test(v) ? `"${v.replace(/"/g, '\\"')}"` : v
}

/** CLI args for scripts/train_yolo.py (space-separated, no script/python). */
export function getRunTrainArgsLine(run: string): string | null {
  const y = parseArgsYamlFile(run)
  if (!y) {
    const logPath = join(runsDir, run, 'train.log')
    if (existsSync(logPath)) {
      const head = readFileSync(logPath, 'utf8').slice(0, 4000)
      const m = head.match(/Training with kwargs:\s*(\{[\s\S]*?\})\s*$/m)
      if (m) {
        try {
          const kw = JSON.parse(m[1].replace(/'/g, '"')) as Record<string, unknown>
          return buildArgsLineFromKw(kw, run)
        } catch {
          // fall through
        }
      }
    }
    return null
  }
  return buildArgsLineFromYaml(y, run)
}

function buildArgsLineFromKw(kw: Record<string, unknown>, run: string): string {
  const parts: string[] = []
  const add = (flag: string, val: unknown) => {
    if (val === undefined || val === null || val === '') return
    if (typeof val === 'boolean') {
      if (val) parts.push(flag)
      return
    }
    parts.push(flag, quoteArg(String(val)))
  }
  add('--data', kw.data)
  add('--epochs', kw.epochs)
  add('--imgsz', kw.imgsz)
  add('--batch', kw.batch)
  add('--device', kw.device)
  add('--model', kw.model)
  add('--project', kw.project)
  add('--name', kw.name ?? run)
  if (kw.exist_ok) parts.push('--exist-ok')
  add('--patience', kw.patience)
  add('--cache', kw.cache)
  if (kw.rect === true) parts.push('--rect')
  if (kw.rect === false) parts.push('--no-rect')
  if (kw.cos_lr === true) parts.push('--cos-lr')
  if (kw.cos_lr === false) parts.push('--no-cos-lr')
  add('--optimizer', kw.optimizer)
  add('--lr0', kw.lr0)
  add('--lrf', kw.lrf)
  add('--close-mosaic', kw.close_mosaic)
  add('--workers', kw.workers)
  return parts.join(' ')
}

function buildArgsLineFromYaml(y: Record<string, unknown>, run: string): string {
  const kw: Record<string, unknown> = {
    data: y.data,
    epochs: y.epochs,
    imgsz: y.imgsz,
    batch: y.batch,
    device: y.device,
    model: y.model,
    project: y.project,
    name: y.name ?? run,
    exist_ok: y.exist_ok,
    patience: y.patience,
    cache: y.cache,
    rect: y.rect,
    cos_lr: y.cos_lr,
    optimizer: y.optimizer,
    lr0: y.lr0,
    lrf: y.lrf,
    close_mosaic: y.close_mosaic,
    workers: y.workers,
  }
  return buildArgsLineFromKw(kw, run)
}

function tokenizeArgsLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQuote = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '"') {
      inQuote = !inQuote
      continue
    }
    if (!inQuote && c === ' ') {
      if (cur) {
        out.push(cur)
        cur = ''
      }
      continue
    }
    cur += c
  }
  if (cur) out.push(cur)
  return out
}

export function runHasCheckpoint(run: string): boolean {
  const last = join(runsDir, run, 'weights', 'last.pt')
  return existsSync(last)
}

export function getRunTrainArgv(run: string): string[] | null {
  const line = getRunTrainArgsLine(run)
  if (!line) return null
  return tokenizeArgsLine(line)
}

export function resumeRunTraining(
  pythonExe: string,
  script: string,
  runId: string
): { ok: boolean; runId?: string; pid?: number; error?: string } {
  if (!runHasCheckpoint(runId)) {
    return { ok: false, error: `Run "${runId}" não tem weights/last.pt para continuar.` }
  }
  const argv = getRunTrainArgv(runId)
  if (!argv || argv.length === 0) {
    return { ok: false, error: 'Não foi possível ler args.yaml desta run.' }
  }
  const filtered = argv.filter((a) => a !== '--resume')
  const args = [...filtered, '--resume', '--name', runId, '--exist-ok']
  return startTraining(pythonExe, script, args)
}

export function getRunCopyPayload(run: string): {
  argsLine: string | null
  script: string
  fullCommand: string | null
} {
  const argsLine = getRunTrainArgsLine(run)
  const script = 'scripts/train_yolo.py'
  if (!argsLine) {
    return { argsLine: null, script, fullCommand: null }
  }
  const py = join(process.cwd(), '.venv', 'Scripts', 'python.exe')
  const python = existsSync(py) ? py : 'python'
  const fullCommand = `${python} ${script} ${argsLine}`
  return { argsLine, script, fullCommand }
}

export function readArtifactBase64(run: string, name: string): string | null {
  const p = join(runsDir, run, name.replace(/\//g, '\\'))
  if (!existsSync(p)) return null
  const buf = readFileSync(p)
  return `data:image/${name.endsWith('.png') ? 'png' : 'jpeg'};base64,${buf.toString('base64')}`
}

export async function getArtifactThumbnail(run: string, name: string, maxW = 240, maxH = 160): Promise<string | null> {
  try {
    const p = join(runsDir, run, name.replace(/\//g, '\\'))
    if (!existsSync(p)) return null
    const buf = readFileSync(p)
    const img = await loadImage(buf)
    const ratio = Math.min(maxW / img.width, maxH / img.height, 1)
    const w = Math.max(1, Math.round(img.width * ratio))
    const h = Math.max(1, Math.round(img.height * ratio))
    const canvas = createCanvas(w, h)
    const ctx = canvas.getContext('2d')
    ctx.drawImage(img, 0, 0, w, h)
    const out = canvas.toBuffer('image/jpeg', { quality: 0.8 })
    return `data:image/jpeg;base64,${out.toString('base64')}`
  } catch (err) {
    return null
  }
}

export function tailLog(run: string, lines = 200): string {
  const p = join(runsDir, run, 'train.log')
  if (!existsSync(p)) return ''
  const txt = readFileSync(p, 'utf8')
  const arr = txt.split(/\r?\n/)
  return arr.slice(-lines).join('\n')
}

export function readMetrics(run: string): any | null {
  const dir = join(runsDir, run)
  if (!existsSync(dir)) return null
  const jsonPath = join(dir, 'metrics.json')
  const csvPath = join(dir, 'metrics.csv')
  const resultsPath = join(dir, 'results.csv')
  try {
    if (existsSync(jsonPath)) {
      const txt = readFileSync(jsonPath, 'utf8')
      return JSON.parse(txt)
    }
    const csvToMetrics = (path: string) => {
      const txt = readFileSync(path, 'utf8')
      const lines = txt.split(/\r?\n/).filter(Boolean)
      if (lines.length < 2) return null
      const header = lines[0].split(',').map((h) => h.trim())
      const rows = lines.slice(1).map((ln) => ln.split(',').map((c) => c.trim()))
      const out: any = {}
      for (let i = 0; i < header.length; i++) {
        out[header[i]] = rows.map((r) => {
          const v = r[i]
          const n = Number(v)
          return Number.isFinite(n) ? n : v
        })
      }
      return out
    }
    if (existsSync(csvPath)) {
      return csvToMetrics(csvPath)
    }
    if (existsSync(resultsPath)) {
      return csvToMetrics(resultsPath)
    }
    // fallback: search for files matching metrics-*.json
    const files = readdirSync(dir).filter((f) => f.match(/^metrics.*\.json$/))
    if (files.length > 0) {
      const txt = readFileSync(join(dir, files[0]), 'utf8')
      return JSON.parse(txt)
    }
  } catch {
    return null
  }
  return null
}

function pollLogForRun(info: ProcInfo) {
  const logPath = join(runsDir, info.runId, 'train.log')
  const pollFn = async () => {
    try {
      if (!existsSync(logPath)) return
      const stat = statSync(logPath)
      const size = stat.size
      if (size === info.lastLogSize) return
      // read full tail (safe; logs are moderate)
      const txt = readFileSync(logPath, 'utf8')
      info.lastLogSize = size
      const tail = txt.split(/\r?\n/).slice(-500).join('\n')
      broadcast('train:log', info.runId, tail)
      // also broadcast artifacts update
      const arts = listArtifacts(info.runId)
      broadcast('train:artifacts', info.runId, arts)
      // broadcast metrics if available
      const metrics = readMetrics(info.runId)
      if (metrics) broadcast('train:metrics', info.runId, metrics)
    } catch (err) {
      // ignore
    }
  }
  info.poll = setInterval(pollFn, 1000)
}

export function startTraining(pythonExe: string, script: string, args: string[] = []): { ok: boolean; runId?: string; pid?: number; error?: string } {
  try {
    let runId: string;
    let userProvidedName: string | undefined;

    // Create a mutable copy of args for manipulation
    let currentArgs = [...args];

    // Extract user-provided name if any and remove from args
    for (let i = 0; i < currentArgs.length; i++) {
      if (currentArgs[i] === '--name' || currentArgs[i] === '-n') {
        userProvidedName = currentArgs[i + 1];
        currentArgs.splice(i, 2); // Remove --name and its value
        break;
      }
    }

    if (userProvidedName) {
      // Sanitize the user-provided name to be filesystem-friendly
      runId = userProvidedName.replace(/[^a-zA-Z0-9-._]/g, '_');
      if (runId !== userProvidedName) {
          console.warn(`Sanitized runId from "${userProvidedName}" to "${runId}"`);
      }
    } else {
      runId = `run-${Date.now()}`;
    }

    // ensure --project is present for ultralytics scripts
    let allArgs = [script, ...currentArgs]; // Use the modified currentArgs
    const hasProject = allArgs.some((a) => a.startsWith('--project') || a.startsWith('-p'));
    if (!hasProject) {
      allArgs.push('--project', 'runs/train');
    }
    
    // Always ensure --name is set to our determined runId
    // This will override any default ultralytics naming or re-add a sanitized user-provided name
    allArgs.push('--name', runId);
    allArgs.push('--exist-ok'); // Add --exist-ok to prevent Ultralytics from appending numbers
    console.log('trainManager: startTraining starting with runId', runId, 'and final args', allArgs);

    // create run directory for logs/artifacts
    const runDir = join(runsDir, runId); // Use the determined runId here
    try {
      mkdirSync(runDir, { recursive: true });
    } catch {}

    // spawn the process hidden on Windows and capture stdout/stderr to a train.log file
    const outPath = join(runDir, 'train.log');
    const outStream = createWriteStream(outPath, { flags: 'a' });
    const proc = spawn(pythonExe, allArgs, { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const info: ProcInfo = { proc, startedAt: Date.now(), args: allArgs, lastLogSize: 0, runId, stderrBuffer: [] };
    console.log('trainManager: startTraining starting with runId', runId, 'and final args', allArgs);
    processes.set(runId, info); // Use the determined runId here
    // pipe stdout/stderr to log
    if (proc.stdout) proc.stdout.pipe(outStream);
    if (proc.stderr) {
      proc.stderr.pipe(outStream);
      proc.stderr.on('data', (data) => {
        info.stderrBuffer.push(data.toString());
      });
    }

    // after a short delay start polling for the log file and broadcast status
    setTimeout(() => {
      pollLogForRun(info);
      broadcast('train:status', { running: true, runId, pid: proc.pid, startedAt: info.startedAt });
    }, 1000);

    proc.on('exit', (code, signal) => {
      // cleanup poll and streams
      const p = processes.get(runId)
      if (p && p.poll) clearInterval(p.poll)
      try {
        outStream.end()
      } catch {}
      processes.delete(runId);
      let errorMsg = '';
      if (code !== 0 && p && p.stderrBuffer.length > 0) {
        errorMsg = p.stderrBuffer.join('');
      }
      broadcast('train:status', { running: false, runId, code, signal, error: errorMsg });    })

    return { ok: true, runId, pid: proc.pid }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) }
  }
}

export function stopTraining(runId?: string): boolean {
  try {
    if (runId) {
      const info = processes.get(runId)
      if (!info) return false
      if (info.paused) {
        // If it is suspended/paused, resume it first so it can handle the SIGTERM signal gracefully
        resumeTraining(runId)
      }
      info.proc.kill('SIGTERM')
      if (info.poll) clearInterval(info.poll)
      processes.delete(runId)
      broadcast('train:status', { running: false, runId })
      return true
    } else {
      // stop all
      for (const [id, info] of processes.entries()) {
        try {
          if (info.paused) {
            resumeTraining(id)
          }
          info.proc.kill('SIGTERM')
        } catch {}
        if (info.poll) clearInterval(info.poll)
        processes.delete(id)
        broadcast('train:status', { running: false, runId: id })
      }
      return true
    }
  } catch {
    return false
  }
}

export function suspendTraining(runId: string): boolean {
  try {
    const info = processes.get(runId)
    if (!info) return false
    
    if (process.platform === 'win32') {
      const pid = info.proc.pid
      if (pid === undefined) return false
      // PowerShell command to suspend process using NtSuspendProcess
      const psCommand = `$code = @'
using System;
using System.Runtime.InteropServices;
public class ProcessNative {
    [DllImport("ntdll.dll", SetLastError=true)]
    public static extern int NtSuspendProcess(IntPtr processHandle);
}
'@
Add-Type -TypeDefinition $code
$proc = [System.Diagnostics.Process]::GetProcessById(${pid})
[ProcessNative]::NtSuspendProcess($proc.Handle)
`
      exec(`powershell -NoProfile -Command "${psCommand.replace(/\r?\n/g, ' ')}"`, (err) => {
        if (err) console.error('Error suspending process:', err)
      })
    } else {
      info.proc.kill('SIGSTOP')
    }
    
    info.paused = true
    broadcast('train:status', { running: true, paused: true, runId })
    return true
  } catch (err) {
    console.error('suspendTraining error:', err)
    return false
  }
}

export function resumeTraining(runId: string): boolean {
  try {
    const info = processes.get(runId)
    if (!info) return false
    
    if (process.platform === 'win32') {
      const pid = info.proc.pid
      if (pid === undefined) return false
      // PowerShell command to resume process using NtResumeProcess
      const psCommand = `$code = @'
using System;
using System.Runtime.InteropServices;
public class ProcessNative {
    [DllImport("ntdll.dll", SetLastError=true)]
    public static extern int NtResumeProcess(IntPtr processHandle);
}
'@
Add-Type -TypeDefinition $code
$proc = [System.Diagnostics.Process]::GetProcessById(${pid})
[ProcessNative]::NtResumeProcess($proc.Handle)
`
      exec(`powershell -NoProfile -Command "${psCommand.replace(/\r?\n/g, ' ')}"`, (err) => {
        if (err) console.error('Error resuming process:', err)
      })
    } else {
      info.proc.kill('SIGCONT')
    }
    
    info.paused = false
    broadcast('train:status', { running: true, paused: false, runId })
    return true
  } catch (err) {
    console.error('resumeTraining error:', err)
    return false
  }
}

export function trainingStatus(): {
  running: boolean
  active: string[]
  paused: string[]
  externalActive: string[]
} {
  const active: string[] = []
  const paused: string[] = []
  for (const [id, info] of processes.entries()) {
    if (info.paused) {
      paused.push(id)
    } else {
      active.push(id)
    }
  }
  const externalActive = listExternallyActiveRuns().filter((id) => !processes.has(id))
  for (const id of externalActive) {
    if (!active.includes(id)) active.push(id)
  }
  return {
    running: processes.size > 0 || externalActive.length > 0,
    active,
    paused,
    externalActive,
  }
}

