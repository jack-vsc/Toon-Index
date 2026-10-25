import { app, BrowserWindow, Menu, nativeImage, Notification, Tray } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RemoteJob } from '../shared/remoteJobs'
import { stopAi } from './aiMonitor'
import { pauseRemoteJobs, remoteQueue } from './remoteJobs'

/**
 * The app kept on in the background: it opens with Windows (no window, an icon by the clock), and
 * closing the window hides it, so the phone can always reach the PC and its requests are translated
 * at any time. Turned off in the settings, closing the window quits as before.
 */

const path = (): string => join(app.getPath('userData'), 'background.json')

/** Started by Windows at sign-in: the window stays hidden until opened from the icon. */
export const startedHidden = process.argv.includes('--hidden')

/** Test runs (MI_USER_DATA) never touch the Windows startup list, nor stay on unless MI_BACKGROUND_TEST asks. */
const testRun = !!process.env.MI_USER_DATA && !process.env.MI_BACKGROUND_TEST

let tray: Tray | null = null
let quitting = false
let toldHidden = false

export function backgroundEnabled(): boolean {
  try {
    return (JSON.parse(readFileSync(path(), 'utf8')) as { enabled?: boolean }).enabled !== false
  } catch {
    return true
  }
}

export function setBackgroundEnabled(enabled: boolean, win: BrowserWindow | null): boolean {
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(path(), JSON.stringify({ enabled }, null, 2))
  applyBackground(win)
  return enabled
}

/** Opening with Windows, and the icon by the clock, as the setting says. */
export function applyBackground(win: BrowserWindow | null): void {
  if (testRun) return
  const enabled = backgroundEnabled()
  // Not installed: Electron itself runs this folder (as the desktop shortcut does).
  const args = app.isPackaged ? ['--hidden'] : [app.getAppPath(), '--hidden']
  if (!process.env.MI_USER_DATA) app.setLoginItemSettings({ openAtLogin: enabled, path: process.execPath, args, name: 'Manga Index' })
  if (enabled && !tray) createTray(win)
  if (!enabled && tray) {
    tray.destroy()
    tray = null
  }
}

function createTray(win: BrowserWindow | null): void {
  const icon = join(app.getAppPath(), 'build', 'icon.png')
  tray = new Tray(existsSync(icon) ? nativeImage.createFromPath(icon).resize({ width: 16, height: 16 }) : nativeImage.createEmpty())
  trayWindow = win
  refreshTray()
  tray.on('click', () => showWindow(win))
}

let trayWindow: BrowserWindow | null = null

/** The icon's menu, with the pause as the queue stands now (called when the queue changes). */
export function refreshTray(): void {
  if (!tray) return
  const paused = remoteQueue().paused
  tray.setToolTip(paused ? 'Manga Index: tradução pausada, GPU livre' : 'Manga Index: ligado em segundo plano')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Abrir o Manga Index', click: () => showWindow(trayWindow) },
      { type: 'separator' },
      paused
        ? { label: 'Continuar a tradução', click: () => pauseRemoteJobs(false) }
        : { label: 'Pausar a tradução e liberar a GPU', click: () => void freeGpu() },
      { type: 'separator' },
      { label: 'Sair (o celular deixa de alcançar o PC)', click: () => quit() }
    ])
  )
}

/**
 * For a game, say: the queue stops (the chapter running goes back to it, and nothing starts until
 * "Continuar"), a chapter translated from the window is cancelled, and the AIs leave the graphics card.
 */
async function freeGpu(): Promise<void> {
  pauseRemoteJobs(true)
  if (trayWindow && !trayWindow.isDestroyed()) trayWindow.webContents.send('app:free-gpu')
  await Promise.all([stopAi('ollama-models'), stopAi('vision')]).catch(() => undefined)
  if (Notification.isSupported()) {
    new Notification({ title: 'GPU liberada', body: 'A tradução está pausada. Para retomar, use "Continuar a tradução" no ícone perto do relógio.' }).show()
  }
}

function showWindow(win: BrowserWindow | null): void {
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

export function quit(): void {
  quitting = true
  app.quit()
}

/**
 * Closing the window hides it while the background is on (the first time, saying so); quitting from
 * the icon's menu, or Windows shutting down, quits.
 */
export function keepInBackground(win: BrowserWindow): void {
  app.on('before-quit', () => (quitting = true))
  win.on('close', (event) => {
    if (quitting || testRun || !backgroundEnabled()) return
    event.preventDefault()
    win.hide()
    win.webContents.send('app:hidden')
    if (!toldHidden && Notification.isSupported()) {
      toldHidden = true
      new Notification({
        title: 'O Manga Index continua ligado',
        body: 'Em segundo plano, para o celular mandar capítulos a qualquer hora. Para sair, use o ícone perto do relógio.'
      }).show()
    }
  })
}

/** A second copy opened (the desktop shortcut while it runs in the background) shows the window. */
export function singleInstance(getWindow: () => BrowserWindow | null): boolean {
  if (testRun) return true
  if (!app.requestSingleInstanceLock()) return false
  app.on('second-instance', () => showWindow(getWindow()))
  return true
}

/** Chapters asked by the phone and done while the window is hidden are announced in Windows. */
export function announceDone(jobs: RemoteJob[], win: BrowserWindow | null): void {
  for (const job of jobs) {
    if (job.status !== 'done' || job.device === 'PC' || seen.has(job.id)) continue
    seen.add(job.id)
    if (!started || (win?.isVisible() ?? false) || !Notification.isSupported()) continue
    const notification = new Notification({ title: 'Capítulo pronto', body: `${job.name.replace(/\.pdf$/i, '')}: já dá para ler no celular.` })
    notification.on('click', () => showWindow(win))
    notification.show()
  }
  started = true
}

const seen = new Set<string>()
/** The jobs done before the app opened are not announced again. */
let started = false
