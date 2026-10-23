import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { rmSync } from 'node:fs'
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
  setWorkNames
} from './library'
import type { HistoryWork } from '../shared/reading'
import { finishedInApp, forgetReading, importHistory, listReading, markRead, onReadingChanged, scanHistory } from './reading'
import { startReadingServer, stopReadingServer } from './readingServer'
import { getPublicSettings, saveSettings } from './settings'
import { cancelTranslations, listModels, testApi, translate } from './translate'
import { detect as visionDetect, inpaint as visionInpaint, stopVision } from './vision'
import {
  listRuns,
  listActiveRuns,
  listArtifacts,
  readArtifactBase64,
  tailLog,
  startTraining,
  stopTraining,
  suspendTraining,
  resumeTraining,
  trainingStatus,
  getArtifactThumbnail,
  readMetrics,
  getArtifactStamp,
  getRunCopyPayload,
  resumeRunTraining,
  runHasCheckpoint
} from './trainManager'

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: 'Manga Index',
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

  win.on('close', async (e) => {
    const status = trainingStatus()
    if (!status.running || win.isDestroyed()) return
    e.preventDefault()
    const result = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['Continuar em background', 'Parar treinamento e fechar'],
      defaultId: 0,
      cancelId: 0,
      title: 'Treinamento em andamento',
      message: 'O treinamento ainda está rodando. O que você quer fazer?',
      detail: 'Se escolher "Continuar em background", o app será minimizado e o treinamento seguirá rodando. Você pode reabrir o app pelo ícone na barra de tarefas.'
    })
    if (result.response === 0) {
      // Continuar em background: esconde a janela, mas não fecha
      win.hide()
    } else {
      // Parar treinamento e fechar
      stopTraining()
      mainWindow = null
      win.destroy()
    }
  })

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
  ipcMain.handle('works:move', (_e, entryId: string, target: { workId: string } | { newName: string }) => moveToWork(entryId, target))
  // Training management IPC
  ipcMain.handle('train:listRuns', () => listRuns())
  ipcMain.handle('train:listActive', () => listActiveRuns())
  ipcMain.handle('train:listArtifacts', (_e, run: string) => listArtifacts(run))
  ipcMain.handle('train:getArtifact', (_e, run: string, name: string) => readArtifactBase64(run, name))
  ipcMain.handle('train:getThumb', (_e, run: string, name: string, maxW?: number, maxH?: number) => getArtifactThumbnail(run, name, maxW ?? 240, maxH ?? 160))
  ipcMain.handle('train:tailLog', (_e, run: string, lines?: number) => tailLog(run, lines ?? 200))
  ipcMain.handle('train:start', (_e, pythonExe: string, script: string, args?: string[]) => startTraining(pythonExe, script, args ?? []))
  ipcMain.handle('train:stop', (_e, runId?: string) => stopTraining(runId))
  ipcMain.handle('train:suspend', (_e, runId: string) => suspendTraining(runId))
  ipcMain.handle('train:resume', (_e, runId: string) => resumeTraining(runId))
  ipcMain.handle('train:metrics', (_e, run: string) => readMetrics(run))
  ipcMain.handle('train:status', () => trainingStatus())
  ipcMain.handle('train:artifactStamp', (_e, run: string) => getArtifactStamp(run))
  ipcMain.handle('train:copyPayload', (_e, run: string) => getRunCopyPayload(run))
  ipcMain.handle('train:hasCheckpoint', (_e, run: string) => runHasCheckpoint(run))
  ipcMain.handle('train:resumeRun', (_e, pythonExe: string, script: string, runId: string) =>
    resumeRunTraining(pythonExe, script, runId)
  )
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
  cancelWebChapter()
})
