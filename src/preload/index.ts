import { contextBridge, ipcRenderer } from 'electron'
import type { MangaApi } from './api'

const api: MangaApi = {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (input) => ipcRenderer.invoke('settings:save', input),
  listModels: (profile, apiKey) => ipcRenderer.invoke('models:list', profile, apiKey),
  testApi: (profile, apiKey) => ipcRenderer.invoke('api:test', profile, apiKey),
  translate: (req) => ipcRenderer.invoke('translate', req),
  cancelTranslations: (requestIds) => ipcRenderer.invoke('translate:cancel', requestIds),
  savePdf: (bytes, suggestedName) => ipcRenderer.invoke('pdf:save', bytes, suggestedName),
  showFile: (path) => ipcRenderer.invoke('shell:show-file', path),
  library: {
    list: () => ipcRenderer.invoke('library:list'),
    save: (input) => ipcRenderer.invoke('library:save', input),
    pdf: (id, which) => ipcRenderer.invoke('library:pdf', id, which),
    remove: (id) => ipcRenderer.invoke('library:delete', id)
  }
}

contextBridge.exposeInMainWorld('api', api)
