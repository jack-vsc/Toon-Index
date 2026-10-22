import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { VisionDetection } from '../shared/types'

/**
 * The Python vision server (scripts/manga_vision.py): text and speech-bubble detection, and LaMa
 * inpainting. Started on first use and kept running, since loading the models takes a few seconds.
 */

type Pending = { resolve: (value: any) => void; reject: (err: Error) => void }

let proc: ChildProcessWithoutNullStreams | null = null
let ready: Promise<void> | null = null
let nextId = 1
const pending = new Map<number, Pending>()
const workDir = join(tmpdir(), 'manga-vision')

function pythonExe(): string {
  const venv = join(process.cwd(), '.venv', 'Scripts', 'python.exe')
  return existsSync(venv) ? venv : 'python'
}

function start(): Promise<void> {
  if (ready) return ready
  ready = new Promise<void>((resolve, reject) => {
    const script = join(process.cwd(), 'scripts', 'manga_vision.py')
    if (!existsSync(script)) return reject(new Error(`Script de visão não encontrado: ${script}`))
    const child = spawn(pythonExe(), ['-u', script], { cwd: process.cwd(), windowsHide: true })
    proc = child
    let stderr = ''
    child.stderr.on('data', (d) => {
      const text = d.toString()
      stderr = (stderr + text).slice(-4000)
      if (text.includes('[vision]')) process.stdout.write(text)
    })
    createInterface({ input: child.stdout }).on('line', (line) => {
      let msg: any
      try {
        msg = JSON.parse(line)
      } catch {
        return
      }
      if (msg.ready) return resolve()
      const p = pending.get(msg.id)
      if (!p) return
      pending.delete(msg.id)
      if (msg.error) p.reject(new Error(msg.error))
      else p.resolve(msg)
    })
    child.on('exit', (code) => {
      const err = new Error(`Servidor de visão encerrou (código ${code}). ${stderr.trim().split('\n').slice(-3).join(' ')}`)
      for (const p of pending.values()) p.reject(err)
      pending.clear()
      proc = null
      ready = null
      reject(err)
    })
  })
  return ready
}

async function call(cmd: string, args: Record<string, unknown>): Promise<any> {
  await start()
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    proc!.stdin.write(JSON.stringify({ id, cmd, ...args }) + '\n')
  })
}

async function withFiles<T>(run: (path: (name: string) => string) => Promise<T>): Promise<T> {
  const dir = join(workDir, randomUUID())
  await mkdir(dir, { recursive: true })
  try {
    return await run((name) => join(dir, name))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** Finds text blocks, speech bubbles and the pixel mask of the lettering on a page image (PNG/JPEG). */
export function detect(image: Uint8Array): Promise<VisionDetection> {
  return withFiles(async (path) => {
    await writeFile(path('page.png'), image)
    const res = await call('detect', { image: path('page.png'), mask: path('mask.png') })
    return { blocks: res.blocks, bubbles: res.bubbles, textMask: new Uint8Array(await readFile(path('mask.png'))) }
  })
}

/** Repaints the masked pixels (mask: PNG, white = repaint) and returns the page as PNG. */
export function inpaint(image: Uint8Array, mask: Uint8Array): Promise<Uint8Array> {
  return withFiles(async (path) => {
    await writeFile(path('page.png'), image)
    await writeFile(path('mask.png'), mask)
    await call('inpaint', { image: path('page.png'), mask: path('mask.png'), out: path('out.png') })
    return new Uint8Array(await readFile(path('out.png')))
  })
}

/** Process id of the vision server this app started, when it is running. */
export function visionPid(): number | null {
  return proc?.pid ?? null
}

export function stopVision(): void {
  proc?.kill()
  proc = null
  ready = null
}
