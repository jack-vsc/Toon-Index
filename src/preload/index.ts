import { contextBridge, ipcRenderer } from 'electron'
import type { WebChapterProgress } from '../shared/types'
import type { MangaApi } from './api'

const api: MangaApi = {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (input) => ipcRenderer.invoke('settings:save', input),
  listModels: (profile, apiKey) => ipcRenderer.invoke('models:list', profile, apiKey),
  testApi: (profile, apiKey) => ipcRenderer.invoke('api:test', profile, apiKey),
  translate: (req) => ipcRenderer.invoke('translate', req),
  vision: {
    detect: (image) => ipcRenderer.invoke('vision:detect', image),
    inpaint: (image, mask) => ipcRenderer.invoke('vision:inpaint', image, mask)
  },
  web: {
    chapter: (url) => ipcRenderer.invoke('web:chapter', url),
    cancel: () => ipcRenderer.invoke('web:cancel'),
    onProgress: (callback) => {
      const listener = (_e: Electron.IpcRendererEvent, p: WebChapterProgress) => callback(p)
      ipcRenderer.on('web:progress', listener)
      return () => {
        ipcRenderer.removeListener('web:progress', listener)
      }
    }
  },
  ai: {
    status: () => ipcRenderer.invoke('ai:status'),
    gpu: () => ipcRenderer.invoke('ai:gpu'),
    stop: (target) => ipcRenderer.invoke('ai:stop', target)
  },
  cancelTranslations: (requestIds) => ipcRenderer.invoke('translate:cancel', requestIds),
  savePdf: (bytes, suggestedName) => ipcRenderer.invoke('pdf:save', bytes, suggestedName),
  showFile: (path) => ipcRenderer.invoke('shell:show-file', path),
  library: {
    list: () => ipcRenderer.invoke('library:list'),
    save: (input) => ipcRenderer.invoke('library:save', input),
    pdf: (id, which) => ipcRenderer.invoke('library:pdf', id, which),
    remove: (id) => ipcRenderer.invoke('library:delete', id)
  },
  works: {
    list: () => ipcRenderer.invoke('works:list'),
    setNames: (workId, names) => ipcRenderer.invoke('works:names', workId, names),
    merge: (intoId, fromId) => ipcRenderer.invoke('works:merge', intoId, fromId),
    move: (entryId, target) => ipcRenderer.invoke('works:move', entryId, target),
    covers: () => ipcRenderer.invoke('works:covers'),
    chapters: (match) => ipcRenderer.invoke('works:chapters', match),
    search: (query) => ipcRenderer.invoke('works:search', query),
    link: (workId, matches) => ipcRenderer.invoke('works:link', workId, matches)
  },
  devices: {
    status: () => ipcRenderer.invoke('devices:status'),
    enable: (enabled) => ipcRenderer.invoke('devices:enable', enabled),
    pairing: () => ipcRenderer.invoke('devices:pairing'),
    revoke: (id) => ipcRenderer.invoke('devices:revoke', id)
  },
  updates: {
    status: () => ipcRenderer.invoke('updates:status'),
    check: () => ipcRenderer.invoke('updates:check'),
    setSources: (workId, sources) => ipcRenderer.invoke('updates:sources', workId, sources),
    setNtfy: (enabled) => ipcRenderer.invoke('updates:ntfy', enabled),
    onChanged: (callback) => {
      const listener = () => callback()
      ipcRenderer.on('updates:changed', listener)
      return () => {
        ipcRenderer.removeListener('updates:changed', listener)
      }
    }
  },
  remote: {
    list: () => ipcRenderer.invoke('remote:list'),
    take: () => ipcRenderer.invoke('remote:take'),
    queue: () => ipcRenderer.invoke('remote:queue'),
    pause: (paused) => ipcRenderer.invoke('remote:pause', paused),
    batch: (work, site, chapters) => ipcRenderer.invoke('remote:batch', work, site, chapters),
    clearBatch: () => ipcRenderer.invoke('remote:clear-batch'),
    update: (id, patch) => ipcRenderer.invoke('remote:update', id, patch),
    onChanged: (callback) => {
      const listener = () => callback()
      ipcRenderer.on('remote:changed', listener)
      return () => {
        ipcRenderer.removeListener('remote:changed', listener)
      }
    }
  },
  reading: {
    list: () => ipcRenderer.invoke('reading:list'),
    finished: (entryId) => ipcRenderer.invoke('reading:finished', entryId),
    mark: (workId, chapter) => ipcRenderer.invoke('reading:mark', workId, chapter),
    forget: (workId, chapter) => ipcRenderer.invoke('reading:forget', workId, chapter),
    scanHistory: () => ipcRenderer.invoke('reading:scan-history'),
    importHistory: (works) => ipcRenderer.invoke('reading:import-history', works),
    openExtension: () => ipcRenderer.invoke('reading:extension'),
    onChanged: (callback) => {
      const listener = () => callback()
      ipcRenderer.on('reading:changed', listener)
      return () => {
        ipcRenderer.removeListener('reading:changed', listener)
      }
    }
  },
  evaluation: {
    config: () => ipcRenderer.invoke('eval:config'),
    read: (path) => ipcRenderer.invoke('eval:read', path),
    write: (name, data) => ipcRenderer.invoke('eval:write', name, data),
    log: (message) => ipcRenderer.invoke('eval:log', message),
    done: () => ipcRenderer.invoke('eval:done')
  }
}

contextBridge.exposeInMainWorld('api', api)
