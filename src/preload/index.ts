import { contextBridge, ipcRenderer } from 'electron'
import type { LocalAiProgress, WebChapterProgress } from '../shared/types'
import type { MangaApi } from './api'

const api: MangaApi = {
  background: {
    get: () => ipcRenderer.invoke('background:get'),
    set: (enabled) => ipcRenderer.invoke('background:set', enabled),
    onHidden: (callback) => {
      const listener = () => callback()
      ipcRenderer.on('app:hidden', listener)
      return () => ipcRenderer.removeListener('app:hidden', listener)
    },
    onFreeGpu: (callback) => {
      const listener = () => callback()
      ipcRenderer.on('app:free-gpu', listener)
      return () => ipcRenderer.removeListener('app:free-gpu', listener)
    }
  },
  localAi: {
    state: () => ipcRenderer.invoke('localai:state'),
    installEngine: (engine) => ipcRenderer.invoke('localai:engine', engine),
    installModel: (id, fromOllama) => ipcRenderer.invoke('localai:model', id, fromOllama),
    remove: (id) => ipcRenderer.invoke('localai:remove', id),
    cancel: () => ipcRenderer.invoke('localai:cancel'),
    onProgress: (callback) => {
      const listener = (_e: unknown, p: LocalAiProgress | null) => callback(p)
      ipcRenderer.on('localai:progress', listener)
      return () => ipcRenderer.removeListener('localai:progress', listener)
    }
  },
  data: {
    export: () => ipcRenderer.invoke('data:export'),
    import: () => ipcRenderer.invoke('data:import'),
    logins: () => ipcRenderer.invoke('data:logins')
  },
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (input) => ipcRenderer.invoke('settings:save', input),
  onSettingsChanged: (callback) => {
    const listener = () => callback()
    ipcRenderer.on('settings:changed', listener)
    return () => ipcRenderer.removeListener('settings:changed', listener)
  },
  listModels: (profile, apiKey) => ipcRenderer.invoke('models:list', profile, apiKey),
  testApi: (profile, apiKey) => ipcRenderer.invoke('api:test', profile, apiKey),
  translate: (req) => ipcRenderer.invoke('translate', req),
  translateText: (req) => ipcRenderer.invoke('translate:text', req),
  vision: {
    detect: (image) => ipcRenderer.invoke('vision:detect', image),
    inpaint: (image, mask) => ipcRenderer.invoke('vision:inpaint', image, mask)
  },
  web: {
    chapter: (url) => ipcRenderer.invoke('web:chapter', url),
    cancel: () => ipcRenderer.invoke('web:cancel'),
    login: (url) => ipcRenderer.invoke('web:login', url),
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
  storage: {
    usage: () => ipcRenderer.invoke('storage:usage'),
    clear: (area) => ipcRenderer.invoke('storage:clear', area),
    deleteWork: (workId) => ipcRenderer.invoke('storage:delete-work', workId)
  },
  layers: {
    get: (key) => ipcRenderer.invoke('layers:get', key),
    save: (key, layer) => ipcRenderer.invoke('layers:save', key, layer)
  },
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
    setShelf: (workId, patch) => ipcRenderer.invoke('works:shelf', workId, patch),
    setAuto: (workId, auto) => ipcRenderer.invoke('works:auto', workId, auto),
    setUnit: (workId, unit) => ipcRenderer.invoke('works:unit', workId, unit),
    delete: (workId) => ipcRenderer.invoke('works:delete', workId),
    move: (entryId, target) => ipcRenderer.invoke('works:move', entryId, target),
    covers: () => ipcRenderer.invoke('works:covers'),
    chapters: (match) => ipcRenderer.invoke('works:chapters', match),
    search: (query, own) => ipcRenderer.invoke('works:search', query, own),
    link: (workId, matches) => ipcRenderer.invoke('works:link', workId, matches),
    refresh: (workId) => ipcRenderer.invoke('works:refresh', workId)
  },
  cloud: {
    status: () => ipcRenderer.invoke('cloud:status'),
    set: (pasted, androidAppId) => ipcRenderer.invoke('cloud:set', pasted, androidAppId),
    forget: () => ipcRenderer.invoke('cloud:forget'),
    setPushKey: (pasted) => ipcRenderer.invoke('cloud:push-key', pasted),
    testPush: () => ipcRenderer.invoke('cloud:test-push')
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
    batch: (work, site, chapters, download, source, options) => ipcRenderer.invoke('remote:batch', work, site, chapters, download, source, options),
    clearBatch: () => ipcRenderer.invoke('remote:clear-batch'),
    retryBatch: (ids) => ipcRenderer.invoke('remote:retry-batch', ids),
    reorder: (ids) => ipcRenderer.invoke('remote:reorder', ids),
    sort: () => ipcRenderer.invoke('remote:sort'),
    setOptions: (options) => ipcRenderer.invoke('remote:options', options),
    cancel: (id) => ipcRenderer.invoke('remote:cancel', id),
    addPdfs: (files, options) => ipcRenderer.invoke('remote:add-pdfs', files, options),
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
    progress: (entryId, progress) => ipcRenderer.invoke('reading:progress', entryId, progress),
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
    replayed: (id) => ipcRenderer.invoke('eval:replayed', id),
    done: () => ipcRenderer.invoke('eval:done')
  }
}

contextBridge.exposeInMainWorld('api', api)
