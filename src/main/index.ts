import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { existsSync, rmSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AiStopTarget, ApiProfile, SaveLibraryInput, SaveSettingsInput, TranslateRequest } from '../shared/types'
import { aiStatus, gpuTotals, stopAi, stopMonitor } from './aiMonitor'
import { registerEvalIpc } from './evaluate'
import { snapshotRequested, takeSnapshot } from './snapshot'
import { cancelWebChapter, fetchWebChapter } from './webChapter'
import {
  deleteFromLibrary,
  listLibrary,
  listWorks,
  mergeWorks,
  moveToWork,
  readLibraryPdf,
  saveToLibrary,
  setWorkNames,
  workCovers
} from './library'
import type { CatalogMatch } from '../shared/catalog'
import { chapterList, linkWork, searchCatalogToChoose } from './catalog'
import type { ChapterLink } from '../shared/updates'
import type { HistoryWork } from '../shared/reading'
import { finishedInApp, forgetReading, importHistory, listReading, markRead, onReadingChanged, scanHistory } from './reading'
import { devicesStatus, newPairingCode, revokeDevice, setPhonesEnabled } from './devices'
import type { RemoteJob } from '../shared/remoteJobs'
import {
  addBatch,
  clearBatch,
  listRemoteJobs,
  onRemoteJobsChanged,
  pauseRemoteJobs,
  remoteQueue,
  requeueInterrupted,
  takeRemoteJob,
  updateRemoteJob
} from './remoteJobs'
import { checkNow, onUpdatesChanged, setNtfy, setWorkSources, startUpdates, stopUpdates, updatesStatus } from './updates'
import { READING_PORT, restartReadingServer, startReadingServer, stopReadingServer } from './readingServer'
import { getPublicSettings, saveSettings } from './settings'
import { cancelTranslations, listModels, testApi, translate } from './translate'
import { detect as visionDetect, inpaint as visionInpaint, stopVision } from './vision'

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  const windowIcon = join(app.getAppPath(), 'build', 'icon.png')
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: 'Manga Index',
    // The app's own icon in the taskbar (the desktop shortcut runs Electron itself).
    ...(existsSync(windowIcon) && { icon: windowIcon }),
    backgroundColor: '#14151a',
    show: !snapshotRequested(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Translation keeps running while the window is minimized or hidden.
      backgroundThrottling: false
    }
  })
  mainWindow = win


  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (snapshotRequested()) takeSnapshot(win)
  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function extensionDir(): string {
  return app.isPackaged ? join(process.resourcesPath, 'extension') : join(app.getAppPath(), 'extension')
}

function registerIpc(): void {
  ipcMain.handle('settings:get', () => getPublicSettings())

  ipcMain.handle('settings:save', (_e, input: SaveSettingsInput) => saveSettings(input))

  ipcMain.handle('models:list', (_e, profile: ApiProfile, apiKey?: string) => listModels(profile, apiKey))
  ipcMain.handle('api:test', (_e, profile: ApiProfile, apiKey?: string) => testApi(profile, apiKey))

  ipcMain.handle('translate', (_e, req: TranslateRequest) => translate(req))
  ipcMain.handle('vision:detect', (_e, image: Uint8Array) => visionDetect(image))
  ipcMain.handle('vision:inpaint', (_e, image: Uint8Array, mask: Uint8Array) => visionInpaint(image, mask))
  ipcMain.handle('web:chapter', (e, url: string) => fetchWebChapter(url, e.sender))
  ipcMain.handle('web:cancel', () => cancelWebChapter())
  ipcMain.handle('ai:status', () => aiStatus())
  ipcMain.handle('ai:gpu', () => gpuTotals())
  ipcMain.handle('ai:stop', (_e, target: AiStopTarget) => stopAi(target))
  ipcMain.handle('translate:cancel', (_e, requestIds?: string[]) => cancelTranslations(requestIds))

  ipcMain.handle('pdf:save', async (e, bytes: Uint8Array, suggestedName: string) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const options = {
      title: 'Salvar PDF traduzido',
      defaultPath: join(app.getPath('downloads'), suggestedName),
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    }
    const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return null
    await writeFile(result.filePath, bytes)
    return result.filePath
  })

  ipcMain.handle('shell:show-file', (_e, path: string) => shell.showItemInFolder(path))

  ipcMain.handle('library:list', () => listLibrary())
  ipcMain.handle('library:save', (_e, input: SaveLibraryInput) => saveToLibrary(input))
  ipcMain.handle('library:pdf', (_e, id: string, which: 'original' | 'translated') => readLibraryPdf(id, which))
  ipcMain.handle('library:delete', (_e, id: string) => deleteFromLibrary(id))
  ipcMain.handle('works:list', () => listWorks())
  ipcMain.handle('works:names', (_e, workId: string, names: string[]) => setWorkNames(workId, names))
  ipcMain.handle('works:merge', (_e, intoId: string, fromId: string) => mergeWorks(intoId, fromId))
  ipcMain.handle('reading:list', () => listReading())
  ipcMain.handle('reading:finished', (_e, entryId: string) => finishedInApp(entryId))
  ipcMain.handle('reading:mark', (_e, workId: string, chapter: number) => markRead(workId, chapter))
  ipcMain.handle('reading:forget', (_e, workId: string, chapter: number | null) => forgetReading(workId, chapter))
  ipcMain.handle('reading:scan-history', () => scanHistory())
  ipcMain.handle('reading:import-history', (_e, works: HistoryWork[]) => importHistory(works))
  // The extension is loaded unpacked from this folder (chrome://extensions → "Carregar sem compactação").
  ipcMain.handle('reading:extension', () => shell.openPath(extensionDir()))
  ipcMain.handle('devices:status', () => devicesStatus(READING_PORT))
  ipcMain.handle('devices:enable', (_e, enabled: boolean) => {
    setPhonesEnabled(enabled)
    restartReadingServer()
    return devicesStatus(READING_PORT)
  })
  ipcMain.handle('devices:pairing', () => newPairingCode(READING_PORT))
  ipcMain.handle('devices:revoke', (_e, id: string) => {
    revokeDevice(id)
    return devicesStatus(READING_PORT)
  })
  ipcMain.handle('remote:list', () => listRemoteJobs())
  ipcMain.handle('remote:queue', () => remoteQueue())
  ipcMain.handle('remote:pause', (_e, paused: boolean) => pauseRemoteJobs(paused))
  ipcMain.handle('remote:batch', (_e, work: string, site: string, chapters: ChapterLink[]) => addBatch(work, site, chapters))
  ipcMain.handle('remote:clear-batch', () => clearBatch())
  ipcMain.handle('remote:take', () => takeRemoteJob())
  ipcMain.handle('remote:update', (_e, id: string, patch: Partial<Pick<RemoteJob, 'status' | 'message' | 'entryId'>>) =>
    updateRemoteJob(id, patch)
  )
  ipcMain.handle('updates:status', () => updatesStatus())
  ipcMain.handle('updates:check', () => checkNow())
  ipcMain.handle('updates:sources', (_e, workId: string, sources: string[]) => setWorkSources(workId, sources))
  ipcMain.handle('updates:ntfy', (_e, enabled: boolean) => setNtfy(enabled))
  ipcMain.handle('works:covers', () => workCovers())
  ipcMain.handle('works:chapters', (_e, match: Pick<CatalogMatch, 'site' | 'url'>) => chapterList(match))
  ipcMain.handle('works:search', (_e, query: string) => searchCatalogToChoose(query))
  ipcMain.handle('works:link', (_e, workId: string, matches: CatalogMatch[]) => linkWork(workId, matches))
  ipcMain.handle('works:move', (_e, entryId: string, target: { workId: string } | { newName: string }) => moveToWork(entryId, target))
  registerEvalIpc()
}

// Test runs (MI_USER_DATA) keep settings, library and caches in another folder, away from the real ones.
if (process.env.MI_USER_DATA) app.setPath('userData', process.env.MI_USER_DATA)

app.whenReady().then(() => {
  // Leftovers from requests interrupted by closing the app.
  rmSync(join(app.getPath('userData'), 'agent-runs'), { recursive: true, force: true })
  registerIpc()
  createWindow()
  startReadingServer()
  onReadingChanged(() => mainWindow?.webContents.send('reading:changed'))
  requeueInterrupted()
  onRemoteJobsChanged(() => mainWindow?.webContents.send('remote:changed'))
  onUpdatesChanged(() => mainWindow?.webContents.send('updates:changed'))
  startUpdates()
  app.on('activate', () => {
    if (mainWindow) {
      mainWindow.show()
    } else if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Also when quitting without closing the windows first (app.quit()): child processes outlive the app.
app.on('will-quit', () => {
  stopVision()
  stopMonitor()
  stopReadingServer()
  stopUpdates()
  cancelWebChapter()
})
