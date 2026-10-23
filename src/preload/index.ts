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
    move: (entryId, target) => ipcRenderer.invoke('works:move', entryId, target)
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
  train: {
    listRuns: () => ipcRenderer.invoke('train:listRuns'),
    listActive: () => ipcRenderer.invoke('train:listActive'),
    listArtifacts: (run: string) => ipcRenderer.invoke('train:listArtifacts', run),
    getArtifact: (run: string, name: string) => ipcRenderer.invoke('train:getArtifact', run, name),
    tailLog: (run: string, lines?: number) => ipcRenderer.invoke('train:tailLog', run, lines),
    start: (pythonExe: string, script: string, args?: string[]) => ipcRenderer.invoke('train:start', pythonExe, script, args),
    stop: (runId?: string) => ipcRenderer.invoke('train:stop', runId),
    suspend: (runId: string) => ipcRenderer.invoke('train:suspend', runId),
    resume: (runId: string) => ipcRenderer.invoke('train:resume', runId),
    status: () => ipcRenderer.invoke('train:status'),
    onLog: (cb: (runId: string, text: string) => void) => {
      const listener = (_e: any, runId: string, text: string) => cb(runId, text)
      ipcRenderer.on('train:log', listener)
      return () => {
        ipcRenderer.removeListener('train:log', listener)
      }
    },
    onStatus: (cb: (status: any) => void) => {
      const listener = (_e: any, status: any) => cb(status)
      ipcRenderer.on('train:status', listener)
      return () => {
        ipcRenderer.removeListener('train:status', listener)
      }
    },
    onArtifacts: (cb: (runId: string, arts: string[]) => void) => {
      const listener = (_e: any, runId: string, arts: string[]) => cb(runId, arts)
      ipcRenderer.on('train:artifacts', listener)
      return () => {
        ipcRenderer.removeListener('train:artifacts', listener)
      }
    }
    ,
    getMetrics: (run: string) => ipcRenderer.invoke('train:metrics', run),
    onMetrics: (cb: (runId: string, metrics: any) => void) => {
      const listener = (_e: any, runId: string, metrics: any) => cb(runId, metrics)
      ipcRenderer.on('train:metrics', listener)
      return () => {
        ipcRenderer.removeListener('train:metrics', listener)
      }
    }
    ,
    getThumb: (run: string, name: string, maxW?: number, maxH?: number) => ipcRenderer.invoke('train:getThumb', run, name, maxW, maxH),
    getArtifactStamp: (run: string) => ipcRenderer.invoke('train:artifactStamp', run),
    getCopyPayload: (run: string) => ipcRenderer.invoke('train:copyPayload', run),
    hasCheckpoint: (run: string) => ipcRenderer.invoke('train:hasCheckpoint', run),
    resumeRun: (pythonExe: string, script: string, runId: string) =>
      ipcRenderer.invoke('train:resumeRun', pythonExe, script, runId)
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
