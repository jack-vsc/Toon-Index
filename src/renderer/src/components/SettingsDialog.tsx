import { useEffect, useState } from 'react'
import { toAppError, type AppError } from '../../../shared/errors'
import {
  isLocalProfile,
  LOCAL_AI_BASE_URL,
  LOCAL_AI_PROFILE_ID,
  type AiDevice,
  type LocalAiProgress,
  type LocalAiState,
  type ApiProfile,
  type AppSettings,
  type GpuSharing,
  type ModelOption,
  type PublicSettings,
  type ThinkingLevel
} from '../../../shared/types'

/** Anthropic's own API, where the newer Claude models think by default (main/translate/anthropicProvider). */
const isAnthropicUrl = (url: string): boolean => /^https?:\/\/api\.anthropic\.com(\/|$)/.test(url.trim())
import { cleanIpcError } from '../lib/pipeline'
import { LanguageSelect } from './LanguageSelect'

/** Short, to fit the half-width select; the hint below explains them. */
const GPU_SHORT: Record<GpuSharing, string> = {
  auto: 'Automático',
  phased: 'Em fila: uma IA por vez',
  together: 'Tudo junto (muita VRAM)'
}

interface Props {
  initial: PublicSettings
  onClose: () => void
  onSaved: (settings: PublicSettings) => void
}

interface Preset {
  label: string
  profile: Omit<ApiProfile, 'id'>
}

const PRESETS: Preset[] = [
  {
    label: 'OpenRouter',
    profile: {
      name: 'OpenRouter',
      kind: 'openai',
      baseUrl: 'https://openrouter.ai/api/v1',
      // Chapters 52 and 53 against the scan: Haiku placed and translated best for the price of Flash-Lite.
      models: ['anthropic/claude-haiku-5.5', 'google/gemini-2.5-flash', 'google/gemini-2.5-flash-lite'],
      model: 'anthropic/claude-haiku-5.5'
    }
  },
  { label: 'Cursor', profile: { name: 'Cursor', kind: 'cursor', baseUrl: '', models: [], model: '' } },
  {
    label: 'OpenAI',
    profile: { name: 'OpenAI', kind: 'openai', baseUrl: 'https://api.openai.com/v1', models: ['gpt-4.1-mini'], model: 'gpt-4.1-mini' }
  },
  {
    label: 'Gemini',
    profile: {
      name: 'Gemini',
      kind: 'openai',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      models: ['gemini-2.5-flash'],
      model: 'gemini-2.5-flash'
    }
  },
  {
    label: 'Ollama (local)',
    profile: {
      name: 'Ollama (local)',
      kind: 'openai',
      baseUrl: 'http://localhost:11434/v1',
      models: ['gemma4:e4b-it-qat'],
      model: 'gemma4:e4b-it-qat'
    }
  },
  {
    label: 'LM Studio (local)',
    profile: { name: 'LM Studio (local)', kind: 'openai', baseUrl: 'http://localhost:1234/v1', models: [], model: '' }
  },
  { label: 'Outra', profile: { name: 'Minha API', kind: 'openai', baseUrl: '', models: [], model: '' } }
]

type TestState = { status: 'running' } | { status: 'ok'; ms: number } | { status: 'error'; error: AppError }

export function SettingsDialog({ initial, onClose, onSaved }: Props) {
  const { hasKey, keyHint, ...base } = initial
  const [settings, setSettings] = useState<AppSettings>(base)
  const [editingId, setEditingId] = useState(base.activeProfileId)
  const [keys, setKeys] = useState<Record<string, string>>({})
  const [replacing, setReplacing] = useState<Record<string, boolean>>({})
  const [models, setModels] = useState<Record<string, ModelOption[]>>({})
  const [loadingModels, setLoadingModels] = useState(false)
  const [newModel, setNewModel] = useState('')
  const [tests, setTests] = useState<Record<string, TestState>>({})
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const profile = settings.profiles.find((p) => p.id === editingId) ?? settings.profiles[0]
  const test = tests[profile.id]
  const fetched = models[profile.id] ?? []
  const isOpenRouter = profile.kind === 'openai' && profile.baseUrl.includes('openrouter.ai')
  const patch = (p: Partial<AppSettings>) => setSettings((s) => ({ ...s, ...p }))
  const keyReady = (p: ApiProfile) => !!keys[p.id]?.trim() || !!hasKey[p.id] || isLocalProfile(p)

  function patchProfile(id: string, p: Partial<ApiProfile>) {
    setSettings((s) => ({ ...s, profiles: s.profiles.map((x) => (x.id === id ? { ...x, ...p } : x)) }))
    setTests(({ [id]: _old, ...rest }) => rest)
  }

  function selectProfile(id: string) {
    setEditingId(id)
    setNewModel('')
    setError(null)
  }

  function addProfile(preset: Preset) {
    const id = crypto.randomUUID()
    const created: ApiProfile = { ...preset.profile, models: [...preset.profile.models], id }
    setSettings((s) => ({ ...s, profiles: [...s.profiles, created], activeProfileId: id }))
    selectProfile(id)
  }

  function removeProfile(target: ApiProfile) {
    if (settings.profiles.length < 2) return
    if (!window.confirm(`Remover a API "${target.name}"? A chave salva dela será apagada.`)) return
    const remaining = settings.profiles.filter((p) => p.id !== target.id)
    setSettings((s) => ({
      ...s,
      profiles: remaining,
      activeProfileId: s.activeProfileId === target.id ? remaining[0].id : s.activeProfileId
    }))
    setKeys(({ [target.id]: _old, ...rest }) => rest)
    selectProfile(remaining[0].id)
  }

  async function loadModels(silent = false) {
    const target = profile
    setLoadingModels(true)
    if (!silent) setError(null)
    try {
      const { models: list, suggested } = await window.api.listModels(target, keys[target.id])
      setModels((m) => ({ ...m, [target.id]: list }))
      if (target.kind === 'cursor' && (!target.model || !list.some((m) => m.id === target.model))) {
        patchProfile(target.id, { model: suggested })
      }
    } catch (err) {
      if (!silent) setError(cleanIpcError(err))
    } finally {
      setLoadingModels(false)
    }
  }

  function addModel() {
    const id = newModel.trim()
    if (!id) return
    patchProfile(profile.id, {
      models: profile.models.includes(id) ? profile.models : [...profile.models, id],
      model: profile.model || id
    })
    setNewModel('')
  }

  function removeModel(id: string) {
    const remaining = profile.models.filter((m) => m !== id)
    patchProfile(profile.id, { models: remaining, model: profile.model === id ? (remaining[0] ?? '') : profile.model })
  }

  async function runTest() {
    const target = profile
    setTests((t) => ({ ...t, [target.id]: { status: 'running' } }))
    try {
      const { ms } = await window.api.testApi(target, keys[target.id])
      setTests((t) => ({ ...t, [target.id]: { status: 'ok', ms } }))
    } catch (err) {
      setTests((t) => ({ ...t, [target.id]: { status: 'error', error: toAppError(err) } }))
    }
  }

  async function save() {
    setSaving(true)
    setError(null)
    try {
      const apiKeys = Object.fromEntries(Object.entries(keys).filter(([, key]) => key.trim()))
      onSaved(await window.api.saveSettings({ settings, apiKeys }))
      onClose()
    } catch (err) {
      setError(cleanIpcError(err))
    } finally {
      setSaving(false)
    }
  }

  const cursorOptions =
    profile.model && !fetched.some((m) => m.id === profile.model) ? [{ id: profile.model, label: profile.model }, ...fetched] : fetched

  return (
    <div className="modal-backdrop">
      <div className="modal settings-modal">
        <h2>Configurações</h2>

        <section>
          <label className="field-label">APIs cadastradas (a marcada é usada para traduzir)</label>
          <div className="profile-list">
            {settings.profiles.map((p) => (
              <div key={p.id} className={`profile-row ${p.id === profile.id ? 'editing' : ''}`} onClick={() => selectProfile(p.id)}>
                <input
                  type="radio"
                  name="active-profile"
                  title="Usar esta API"
                  checked={p.id === settings.activeProfileId}
                  onChange={() => patch({ activeProfileId: p.id })}
                  onClick={(e) => e.stopPropagation()}
                />
                <div className="profile-info">
                  <strong>{p.name || 'Sem nome'}</strong>
                  <span className="hint">
                    {p.kind === 'cursor' ? 'Cursor' : p.baseUrl || 'sem URL'} · {p.model || 'sem modelo'}
                  </span>
                </div>
                {p.id === settings.activeProfileId && <span className="badge">em uso</span>}
                {!keyReady(p) && <span className="badge warn">sem chave</span>}
              </div>
            ))}
          </div>
          <div className="preset-row">
            <span className="hint">Adicionar:</span>
            {PRESETS.map((preset) => (
              <button key={preset.label} className="secondary small" onClick={() => addProfile(preset)}>
                + {preset.label}
              </button>
            ))}
          </div>
        </section>

        <section className="profile-editor">
          <div className="row">
            <div className="grow">
              <label className="field-label">Nome</label>
              <input value={profile.name} onChange={(e) => patchProfile(profile.id, { name: e.target.value })} />
            </div>
            <button
              className="secondary align-end"
              onClick={() => removeProfile(profile)}
              disabled={settings.profiles.length < 2}
              title={settings.profiles.length < 2 ? 'É preciso ter ao menos uma API' : undefined}
            >
              Remover
            </button>
          </div>

          <div>
            <label className="field-label">Chave de API{isLocalProfile(profile) && ' (opcional)'}</label>
            {hasKey[profile.id] && !replacing[profile.id] ? (
              <div className="row key-saved">
                <span className="badge">✓ salva</span>
                <span className="key-mask">••••••••{keyHint[profile.id]}</span>
                <button className="secondary" onClick={() => setReplacing((r) => ({ ...r, [profile.id]: true }))}>
                  Trocar chave
                </button>
              </div>
            ) : (
              <input
                type="password"
                autoFocus={replacing[profile.id]}
                placeholder={profile.kind === 'cursor' ? 'cursor_...' : isOpenRouter ? 'sk-or-v1-...' : 'sk-...'}
                value={keys[profile.id] ?? ''}
                onChange={(e) => {
                  const value = e.target.value
                  setKeys((k) => ({ ...k, [profile.id]: value }))
                  setTests(({ [profile.id]: _old, ...rest }) => rest)
                }}
              />
            )}
            {isLocalProfile(profile) && (
              <p className="hint">
                Modelo rodando neste computador: não precisa de chave. Instale o{' '}
                <a href="https://ollama.com/download" target="_blank" rel="noreferrer">
                  Ollama
                </a>{' '}
                e baixe o modelo com <code>ollama pull {profile.model || 'qwen3-vl:4b-instruct'}</code>.
              </p>
            )}
            {profile.kind === 'cursor' && (
              <p className="hint">
                Crie em{' '}
                <a href="https://cursor.com/dashboard/integrations" target="_blank" rel="noreferrer">
                  cursor.com/dashboard/integrations
                </a>
                . As chaves ficam criptografadas neste computador.
              </p>
            )}
            {isOpenRouter && (
              <p className="hint">
                Crie em{' '}
                <a href="https://openrouter.ai/keys" target="_blank" rel="noreferrer">
                  openrouter.ai/keys
                </a>{' '}
                e adicione créditos em{' '}
                <a href="https://openrouter.ai/settings/credits" target="_blank" rel="noreferrer">
                  openrouter.ai/settings/credits
                </a>
                .
              </p>
            )}
          </div>

          {profile.kind === 'cursor' ? (
            <div>
              <label className="field-label">Modelo (precisa aceitar imagens)</label>
              <div className="row">
                <select
                  value={profile.model}
                  onChange={(e) => patchProfile(profile.id, { model: e.target.value })}
                  disabled={cursorOptions.length === 0}
                >
                  {cursorOptions.length === 0 && <option value="">Carregue a lista de modelos</option>}
                  {cursorOptions.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
                <button className="secondary" onClick={() => loadModels()} disabled={loadingModels}>
                  {loadingModels ? 'Carregando…' : 'Carregar modelos'}
                </button>
              </div>
            </div>
          ) : (
            <>
              <div>
                <label className="field-label">URL base</label>
                <input
                  value={profile.baseUrl}
                  placeholder="https://..."
                  onChange={(e) => {
                    patchProfile(profile.id, { baseUrl: e.target.value })
                    setModels(({ [profile.id]: _old, ...rest }) => rest)
                  }}
                />
              </div>
              {isAnthropicUrl(profile.baseUrl) && (
                <div>
                  <label className="field-label">Pensamento do Claude antes de responder</label>
                  <select
                    value={profile.thinking ?? 'off'}
                    onChange={(e) => patchProfile(profile.id, { thinking: e.target.value as ThinkingLevel })}
                  >
                    <option value="off">Desligado (mais barato, recomendado para traduzir)</option>
                    <option value="low">Pouco</option>
                    <option value="medium">Médio (o padrão da Anthropic)</option>
                    <option value="high">Muito (mais caro)</option>
                  </select>
                  <p className="hint">
                    Os modelos novos do Claude pensam antes de responder, e esse pensamento é cobrado como texto de saída em toda página.
                    Desligado, cada página custa bem menos. Modelos que não deixam desligar (Opus 5.5, Sonnet 5.5) pensam pouco.
                  </p>
                </div>
              )}
              <div>
                <label className="field-label">Modelos (precisam aceitar imagens; o marcado é o usado)</label>
                <div className="model-list">
                  {profile.models.map((id) => (
                    <div key={id} className={`model-item ${id === profile.model ? 'active' : ''}`}>
                      <label>
                        <input
                          type="radio"
                          name={`model-${profile.id}`}
                          checked={id === profile.model}
                          onChange={() => patchProfile(profile.id, { model: id })}
                        />
                        <span className="model-id">{id}</span>
                        <span className="hint model-price">{fetched.find((m) => m.id === id)?.price}</span>
                      </label>
                      <button className="icon small" title="Remover modelo" onClick={() => removeModel(id)}>
                        ×
                      </button>
                    </div>
                  ))}
                  {profile.models.length === 0 && <p className="hint">Nenhum modelo adicionado.</p>}
                </div>
                <div className="row">
                  <input
                    list={`models-${profile.id}`}
                    placeholder={isOpenRouter ? 'ID do modelo, ex.: anthropic/claude-haiku-5.5' : 'ID do modelo'}
                    value={newModel}
                    onFocus={() => {
                      if (!models[profile.id] && profile.baseUrl.trim()) void loadModels(true)
                    }}
                    onChange={(e) => setNewModel(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && addModel()}
                  />
                  <datalist id={`models-${profile.id}`}>
                    {fetched.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.price ? `${m.label} · ${m.price}` : m.label}
                      </option>
                    ))}
                  </datalist>
                  <button className="secondary" onClick={addModel} disabled={!newModel.trim()}>
                    Adicionar
                  </button>
                </div>
                <p className="hint">
                  {loadingModels
                    ? 'Buscando modelos da API…'
                    : fetched.length
                      ? `${fetched.length} modelos com visão encontrados: digite para filtrar.`
                      : 'Digite o ID exato do modelo, como aparece no site do provedor.'}{' '}
                  {!loadingModels && (
                    <button className="link" onClick={() => loadModels()} disabled={!profile.baseUrl.trim()}>
                      Buscar modelos da API
                    </button>
                  )}
                </p>
              </div>
            </>
          )}

          <div>
            <div className="row test-row">
              <button className="secondary" onClick={runTest} disabled={test?.status === 'running'}>
                {test?.status === 'running' ? 'Testando…' : 'Testar conexão'}
              </button>
              {test?.status === 'ok' && <span className="test-ok">✓ Funcionando ({(test.ms / 1000).toFixed(1)}s)</span>}
              {test?.status === 'error' && <span className="error">{test.error.message}</span>}
            </div>
            {test?.status === 'error' && test.error.detail && (
              <details>
                <summary>Detalhes técnicos</summary>
                <pre>{test.error.detail}</pre>
              </details>
            )}
            <p className="hint">Manda uma imagem minúscula para o modelo marcado: confere chave, créditos, modelo e suporte a imagem.</p>
          </div>
        </section>

        <section className="grid-2">
          <div>
            <label className="field-label">Idioma original (padrão)</label>
            <LanguageSelect allowAuto value={settings.sourceLanguage} onChange={(sourceLanguage) => patch({ sourceLanguage })} />
          </div>
          <div>
            <label className="field-label">Traduzir para (padrão)</label>
            <LanguageSelect value={settings.targetLanguage} onChange={(targetLanguage) => patch({ targetLanguage })} />
          </div>
        </section>

        <LocalAiPanel
          activeModel={settings.activeProfileId === LOCAL_AI_PROFILE_ID ? profile.model : null}
          onUse={(id, downloaded) => {
            const local: ApiProfile = { id: LOCAL_AI_PROFILE_ID, name: 'Neste PC', kind: 'openai', baseUrl: LOCAL_AI_BASE_URL, models: downloaded, model: id }
            setSettings((s) => ({
              ...s,
              profiles: [...s.profiles.filter((p) => p.id !== LOCAL_AI_PROFILE_ID), local],
              activeProfileId: LOCAL_AI_PROFILE_ID
            }))
            selectProfile(LOCAL_AI_PROFILE_ID)
          }}
        />

        <section className="grid-2">
          <div>
            <label className="field-label">Visão (achar e apagar o texto) em</label>
            <select value={settings.visionDevice} onChange={(e) => patch({ visionDevice: e.target.value as AiDevice })}>
              <option value="gpu">Placa de vídeo (GPU)</option>
              <option value="cpu">Processador e RAM (deixa a GPU livre)</option>
            </select>
          </div>
          <div>
            <label className="field-label">Modelo de tradução deste PC em</label>
            <select value={settings.aiDevice} onChange={(e) => patch({ aiDevice: e.target.value as AiDevice })}>
              <option value="gpu">Placa de vídeo (GPU)</option>
              <option value="cpu">Processador e RAM (sem GPU)</option>
            </select>
          </div>
        </section>

        <section className="grid-2">
          <div>
            <label className="field-label">Uso da GPU (padrão)</label>
            <select value={settings.gpuSharing} onChange={(e) => patch({ gpuSharing: e.target.value as GpuSharing })}>
              {(Object.keys(GPU_SHORT) as GpuSharing[]).map((g) => (
                <option key={g} value={g}>
                  {GPU_SHORT[g]}
                </option>
              ))}
            </select>
          </div>
        </section>
        <p className="hint">
          No processador, achar os balões e apagar o texto leva minutos por página em vez de segundos, e um modelo de tradução
          local (Ollama) fica ainda mais lento; a tradução por API não muda. Em fila, cada IA usa a placa sozinha (detecta o
          capítulo todo, depois traduz, depois redesenha): serve para placas com pouca memória, como 2 a 4 GB. Automático usa
          a fila com modelo local em placas de até 12 GB.
        </p>

        <BackgroundToggle />

        <DataBackup />

        <p className="hint">Páginas ao mesmo tempo, velocidade e intervalo são escolhidos ao abrir cada PDF.</p>

        <p className="hint">
          Balões e texto são encontrados por modelos prontos para mangá (scripts/manga_vision.py, pasta models/pretrained), e o
          texto original é apagado com LaMa. Sem o Python/venv, o app usa o detector interno.
        </p>

        {error && <p className="error">{error}</p>}

        <div className="modal-actions">
          <button className="secondary" onClick={onClose}>
            Cancelar
          </button>
          <button onClick={save} disabled={saving}>
            {saving ? 'Salvando…' : 'Salvar'}
          </button>
        </div>
      </div>
    </div>
  )
}

const gb = (bytes: number): string => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1).replace('.', ',')} GB` : `${Math.round(bytes / 1e6)} MB`)

/**
 * Translating on this computer with nothing else installed: llama.cpp's server for the card and a
 * Gemma model, downloaded once (or taken from Ollama), then picked as the profile "Neste PC".
 */
function LocalAiPanel({ activeModel, onUse }: { activeModel: string | null; onUse: (id: string, downloaded: string[]) => void }) {
  const [state, setState] = useState<LocalAiState | null>(null)
  const [progress, setProgress] = useState<LocalAiProgress | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const refresh = () => window.api.localAi.state().then((s) => (setState(s), setProgress(s.progress)))
  useEffect(() => {
    void refresh()
    return window.api.localAi.onProgress(setProgress)
  }, [])
  if (!state) return null
  const engine = state.engines.find((e) => e.id === state.recommended)!
  const ready = state.models.filter((m) => m.state === 'downloaded' || m.state === 'ollama').map((m) => m.id)
  const run = async (action: () => Promise<void>) => {
    setMessage(null)
    try {
      await action()
    } catch (err) {
      setMessage(cleanIpcError(err))
    }
    await refresh()
  }
  return (
    <section className="local-ai">
      <label className="field-label">IA neste PC, sem instalar nada</label>
      <p className="hint">
        Traduz offline com o Gemma, do Google, ou o Qwen treinado com as traduções do Claude, rodando dentro do app. O motor e o modelo são baixados uma vez; a IA só ocupa a
        placa enquanto traduz.
      </p>
      <div className="local-ai-row">
        <span>
          <strong>Motor</strong> · {engine.label}
        </span>
        {engine.installed ? (
          <span className="test-ok">✓ Pronto</span>
        ) : (
          <button className="secondary small" disabled={!!progress} onClick={() => run(() => window.api.localAi.installEngine(engine.id))}>
            Baixar ({gb(engine.size)})
          </button>
        )}
      </div>
      {state.models.map((m) => (
        <div className="local-ai-row" key={m.id}>
          <span>
            <strong>{m.label}</strong> · {m.note}
          </span>
          <span className="local-ai-actions">
            {m.state === 'missing' && (
              <button className="secondary small" disabled={!!progress} onClick={() => run(() => window.api.localAi.installModel(m.id, false))}>
                Baixar ({gb(m.size)})
              </button>
            )}
            {m.state === 'in-ollama' && (
              <button className="secondary small" disabled={!!progress} onClick={() => run(() => window.api.localAi.installModel(m.id, true))}>
                Usar o do Ollama (sem baixar)
              </button>
            )}
            {(m.state === 'downloaded' || m.state === 'ollama') &&
              (activeModel === m.id ? (
                <span className="test-ok">✓ Em uso</span>
              ) : (
                <button className="small" disabled={!engine.installed} onClick={() => onUse(m.id, ready)}>
                  Usar para traduzir
                </button>
              ))}
            {(m.state === 'downloaded' || m.state === 'ollama') && (
              <button
                className="secondary small"
                title={m.state === 'ollama' ? 'Deixa de usar (os arquivos continuam no Ollama)' : 'Apaga os arquivos do modelo'}
                onClick={() => run(() => window.api.localAi.remove(m.id))}
              >
                {m.state === 'ollama' ? 'Desligar' : 'Apagar'}
              </button>
            )}
          </span>
        </div>
      ))}
      {progress && (
        <div className="local-ai-progress">
          <progress value={progress.done} max={progress.total} />
          <span className="hint">
            {progress.task} · {gb(progress.done)} de {gb(progress.total)}
          </span>
          <button className="secondary small" onClick={() => window.api.localAi.cancel()}>
            Cancelar
          </button>
        </div>
      )}
      {activeModel && <p className="hint">Escolhido: salve para traduzir com ele.</p>}
      {message && <p className="error">{message}</p>}
    </section>
  )
}

/** The works and readings exported to a file, or a backup (the PC's or the phone's) merged back in. */
function DataBackup() {
  const [message, setMessage] = useState<string | null>(null)
  const run = async (action: () => Promise<string | null>): Promise<void> => {
    try {
      setMessage(await action())
    } catch (err) {
      setMessage(cleanIpcError(err))
    }
  }
  return (
    <section className="data-backup">
      <label className="field-label">Backup dos dados</label>
      <div className="row">
        <button
          className="secondary"
          onClick={() =>
            run(async () => {
              const saved = await window.api.data.export()
              return saved && `Salvo: ${saved.works} obras e ${saved.chapters} capítulos em ${saved.path}`
            })
          }
        >
          Exportar
        </button>
        <button
          className="secondary"
          onClick={() =>
            run(async () => {
              const merged = await window.api.data.import()
              return merged && `Restaurado: ${merged.works} obras e ${merged.chapters} capítulos juntados aos que já estavam aqui.`
            })
          }
        >
          Restaurar
        </button>
      </div>
      <p className="hint">
        Um arquivo JSON com as obras, onde você parou em cada uma, as listas e as favoritas. O app do celular exporta e restaura o
        mesmo arquivo; restaurar junta, sem apagar nada.
      </p>
      {message && <p className="hint">{message}</p>}

      <label className="field-label" style={{ marginTop: 14 }}>
        Contas dos sites
      </label>
      <div className="row">
        <button className="secondary" onClick={() => void window.api.data.logins()}>
          Abrir arquivo de contas
        </button>
      </div>
      <p className="hint">
        Para sites que só mostram os capítulos a quem entrou (o MediocreToons): com a conta no arquivo, o app entra sozinho ao checar
        capítulos novos. Fica só neste PC, e a senha só vai para o próprio site.
      </p>
    </section>
  )
}

/** Kept on in the background, opening with Windows, so the phone can send chapters at any time. Saved at once. */
function BackgroundToggle() {
  const [enabled, setEnabled] = useState<boolean | null>(null)
  useEffect(() => {
    window.api.background.get().then(setEnabled)
  }, [])
  if (enabled === null) return null
  return (
    <label className="check-row">
      <input type="checkbox" checked={enabled} onChange={async (e) => setEnabled(await window.api.background.set(e.target.checked))} />
      <span>
        <strong>Manter ligado em segundo plano e abrir com o Windows</strong>
        <span className="hint">
          O celular alcança o PC a qualquer hora e os capítulos que ele pedir são traduzidos mesmo com a janela fechada. Fechar a
          janela deixa o app perto do relógio; para sair de vez, use o ícone de lá.
        </span>
      </span>
    </label>
  )
}
