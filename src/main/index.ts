import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { rmSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ApiProfile, SaveLibraryInput, SaveSettingsInput, TranslateRequest } from '../shared/types'
import { deleteFromLibrary, listLibrary, readLibraryPdf, saveToLibrary } from './library'
import { getPublicSettings, saveSettings } from './settings'
import { cancelTranslations, listModels, testApi, translate } from './translate'

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: 'Manga Index',
    backgroundColor: '#14151a',
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

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function registerIpc(): void {
  ipcMain.handle('settings:get', () => getPublicSettings())

  ipcMain.handle('settings:save', (_e, input: SaveSettingsInput) => saveSettings(input))

  ipcMain.handle('models:list', (_e, profile: ApiProfile, apiKey?: string) => listModels(profile, apiKey))
  ipcMain.handle('api:test', (_e, profile: ApiProfile, apiKey?: string) => testApi(profile, apiKey))

  ipcMain.handle('translate', (_e, req: TranslateRequest) => translate(req))
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
}

app.whenReady().then(() => {
  // Leftovers from requests interrupted by closing the app.
  rmSync(join(app.getPath('userData'), 'agent-runs'), { recursive: true, force: true })
  registerIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
