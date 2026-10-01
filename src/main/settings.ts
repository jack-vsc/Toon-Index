import { app, safeStorage } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  AUTO_LANGUAGE,
  DEFAULT_SETTINGS,
  LANGUAGES,
  type ApiProfile,
  type AppSettings,
  type PublicSettings,
  type SaveSettingsInput
} from '../shared/types'

type StoredKey = { value: string; encrypted: boolean }

interface StoredFile {
  settings: AppSettings
  /** By profile id: base64 of safeStorage-encrypted key (or plain text when encryption is unavailable). */
  keys: Record<string, StoredKey>
}

/** Settings files written before API profiles existed. */
interface LegacySettings {
  provider?: 'cursor' | 'openai'
  cursor?: { model?: string }
  openai?: { baseUrl?: string; model?: string }
}

const filePath = (): string => join(app.getPath('userData'), 'settings.json')

function readStore(): StoredFile {
  if (!existsSync(filePath())) return { settings: DEFAULT_SETTINGS, keys: {} }
  try {
    const raw = JSON.parse(readFileSync(filePath(), 'utf8')) as {
      settings?: Partial<AppSettings> & LegacySettings
      keys?: Record<string, StoredKey>
    }
    const keys = raw.keys ?? {}
    return { settings: mergeSettings(raw.settings, keys), keys }
  } catch {
    return { settings: DEFAULT_SETTINGS, keys: {} }
  }
}

function mergeSettings(raw: (Partial<AppSettings> & LegacySettings) | undefined, keys: Record<string, StoredKey>): AppSettings {
  const d = DEFAULT_SETTINGS
  const listed = Array.isArray(raw?.profiles) ? raw.profiles : legacyProfiles(raw, keys)
  const profiles = listed.map(normalizeProfile).filter((p): p is ApiProfile => !!p)
  if (!profiles.length) profiles.push(...d.profiles)
  const wantedActive = raw?.activeProfileId ?? raw?.provider

  const merged: AppSettings = {
    activeProfileId: profiles.some((p) => p.id === wantedActive) ? wantedActive! : profiles[0].id,
    profiles,
    sourceLanguage: raw?.sourceLanguage ?? d.sourceLanguage,
    targetLanguage: raw?.targetLanguage ?? d.targetLanguage,
    translateSfx: raw?.translateSfx ?? d.translateSfx,
    concurrency: raw?.concurrency ?? d.concurrency,
    speed: raw?.speed ?? d.speed,
    skipStart: raw?.skipStart ?? d.skipStart,
    skipEnd: raw?.skipEnd ?? d.skipEnd,
    readerMode: raw?.readerMode ?? d.readerMode
  }
  const known = new Set(LANGUAGES.map((l) => l.value))
  if (merged.sourceLanguage !== AUTO_LANGUAGE && !known.has(merged.sourceLanguage)) {
    merged.sourceLanguage = d.sourceLanguage
  }
  if (!known.has(merged.targetLanguage)) merged.targetLanguage = d.targetLanguage
  if (!['fast', 'balanced', 'quality'].includes(merged.speed)) merged.speed = d.speed
  if (!['scroll', 'paged'].includes(merged.readerMode)) merged.readerMode = d.readerMode
  merged.concurrency = Math.min(8, Math.max(1, Math.round(merged.concurrency) || 1))
  merged.skipStart = Math.min(50, Math.max(0, Math.round(merged.skipStart) || 0))
  merged.skipEnd = Math.min(50, Math.max(0, Math.round(merged.skipEnd) || 0))
  return merged
}

/** Profile ids 'cursor' and 'openai' match the old key slots, so saved keys keep working. */
function legacyProfiles(raw: LegacySettings | undefined, keys: Record<string, StoredKey>): ApiProfile[] {
  const profiles: ApiProfile[] = [{ ...DEFAULT_SETTINGS.profiles[0], model: raw?.cursor?.model ?? '' }]
  if (raw?.provider === 'openai' || keys.openai) {
    const model = raw?.openai?.model ?? ''
    const baseUrl = raw?.openai?.baseUrl ?? 'https://api.openai.com/v1'
    let openRouterKey = false
    try {
      openRouterKey = !!keys.openai && decryptKey(keys.openai).startsWith('sk-or-')
    } catch {
      // Undecryptable key: keep the profile as it was.
    }
    profiles.push({
      id: 'openai',
      name: openRouterKey ? 'OpenRouter' : 'OpenAI',
      kind: 'openai',
      baseUrl: openRouterKey && baseUrl.includes('api.openai.com') ? 'https://openrouter.ai/api/v1' : baseUrl,
      models: model ? [model] : [],
      model
    })
  }
  return profiles
}

function decryptKey(entry: StoredKey): string {
  return entry.encrypted ? safeStorage.decryptString(Buffer.from(entry.value, 'base64')) : entry.value
}

function normalizeProfile(p: Partial<ApiProfile> | undefined): ApiProfile | undefined {
  if (!p || typeof p.id !== 'string' || !p.id) return undefined
  const kind = p.kind === 'openai' ? 'openai' : 'cursor'
  const model = typeof p.model === 'string' ? p.model.trim() : ''
  const models = [...new Set((Array.isArray(p.models) ? p.models : []).map((m) => String(m).trim()).filter(Boolean))]
  if (kind === 'openai' && model && !models.includes(model)) models.push(model)
  return {
    id: p.id,
    name: typeof p.name === 'string' && p.name.trim() ? p.name.trim() : kind === 'cursor' ? 'Cursor' : 'API',
    kind,
    baseUrl: kind === 'openai' && typeof p.baseUrl === 'string' ? p.baseUrl.trim() : '',
    models: kind === 'openai' ? models : [],
    model
  }
}

function writeStore(store: StoredFile): void {
  writeFileSync(filePath(), JSON.stringify(store, null, 2), 'utf8')
}

export function getPublicSettings(): PublicSettings {
  const { settings } = readStore()
  const hasKey: Record<string, boolean> = {}
  const keyHint: Record<string, string | null> = {}
  for (const { id } of settings.profiles) {
    let hint: string | null = null
    try {
      hint = getApiKey(id)?.slice(-4) ?? null
    } catch {
      // A key that can no longer be decrypted is as good as missing.
    }
    keyHint[id] = hint
    hasKey[id] = hint !== null
  }
  return { ...settings, hasKey, keyHint }
}

export function getSettings(): AppSettings {
  return readStore().settings
}

export function getApiKey(profileId: string): string | undefined {
  const entry = readStore().keys[profileId]
  return entry ? decryptKey(entry) : undefined
}

export function saveSettings(input: SaveSettingsInput): PublicSettings {
  const store = readStore()
  store.settings = mergeSettings(input.settings, store.keys)
  const ids = new Set(store.settings.profiles.map((p) => p.id))
  for (const id of Object.keys(store.keys)) {
    if (!ids.has(id)) delete store.keys[id]
  }
  for (const [id, key] of Object.entries(input.apiKeys ?? {})) {
    if (!ids.has(id)) continue
    const trimmed = key.trim()
    if (!trimmed) {
      delete store.keys[id]
    } else if (safeStorage.isEncryptionAvailable()) {
      store.keys[id] = { value: safeStorage.encryptString(trimmed).toString('base64'), encrypted: true }
    } else {
      store.keys[id] = { value: trimmed, encrypted: false }
    }
  }
  writeStore(store)
  return getPublicSettings()
}
