import { useState } from 'react'
import { activeProfile, isLocalProfile, profileReady, type AppSettings, type GpuSharing, type PublicSettings, type Speed } from '../../../shared/types'
import { LanguageSelect } from './LanguageSelect'

export type RunOptions = Pick<
  AppSettings,
  'sourceLanguage' | 'targetLanguage' | 'concurrency' | 'speed' | 'translateSfx' | 'skipStart' | 'skipEnd' | 'gpuSharing'
>

export interface SetupChoice {
  /** Pages of the output, in order. */
  pages: number[]
  /** Subset of `pages` kept as they are (scanlator credit pages). */
  untranslated: number[]
  options: RunOptions
}

interface Props {
  fileName: string
  numPages: number
  cover: string | null
  settings: PublicSettings
  onStart: (choice: SetupChoice) => void
  onCancel: () => void
  onProfileChange: (profileId: string) => void
  onOpenSettings: () => void
}

export const GPU_LABEL: Record<GpuSharing, string> = {
  auto: 'Automático (separa com modelo local em GPU pequena)',
  phased: 'Em fila, uma IA de cada vez (GPU com pouca memória, como 2 GB)',
  together: 'Tudo junto, página por página (GPU com bastante memória)'
}

const SPEED_LABEL: Record<Speed, string> = {
  fast: 'Rápido (raciocínio baixo)',
  balanced: 'Equilibrado',
  quality: 'Qualidade máxima (mais lento)'
}

export function SetupView({ fileName, numPages, cover, settings, onStart, onCancel, onProfileChange, onOpenSettings }: Props) {
  const [draft, setDraft] = useState<RunOptions>(() => ({
    sourceLanguage: settings.sourceLanguage,
    targetLanguage: settings.targetLanguage,
    concurrency: settings.concurrency,
    speed: settings.speed,
    translateSfx: settings.translateSfx,
    skipStart: settings.skipStart,
    skipEnd: settings.skipEnd,
    gpuSharing: settings.gpuSharing
  }))
  const [mode, setMode] = useState<'all' | 'range'>('all')
  const [from, setFrom] = useState(1)
  const [to, setTo] = useState(numPages)

  const patch = (p: Partial<RunOptions>) => setDraft((d) => ({ ...d, ...p }))
  const first = clamp(Math.min(from, to), 1, numPages)
  const last = clamp(Math.max(from, to), 1, numPages)
  // Always leave at least one page to translate.
  const skipStart = clamp(draft.skipStart, 0, numPages - 1)
  const skipEnd = clamp(draft.skipEnd, 0, numPages - 1 - skipStart)
  const count = mode === 'all' ? numPages - skipStart - skipEnd : last - first + 1
  const profile = activeProfile(settings)
  const ready = profileReady(profile, settings.hasKey)

  function start() {
    if (mode === 'all') {
      const pages = Array.from({ length: numPages }, (_, i) => i + 1)
      const untranslated = pages.filter((n) => n <= skipStart || n > numPages - skipEnd)
      onStart({ pages, untranslated, options: { ...draft, skipStart, skipEnd } })
    } else {
      const pages = Array.from({ length: last - first + 1 }, (_, i) => first + i)
      onStart({ pages, untranslated: [], options: draft })
    }
  }

  return (
    <div className="setup">
      <div className="setup-cover">{cover ? <img src={cover} alt="Capa" /> : <span className="spinner" />}</div>
      <div className="setup-form">
        <h2>{fileName}</h2>
        <p className="hint">{numPages} páginas no PDF</p>

        <section>
          <label className="field-label">O que traduzir</label>
          <div className="segmented">
            <button className={mode === 'all' ? 'active' : ''} onClick={() => setMode('all')}>
              PDF inteiro
            </button>
            <button className={mode === 'range' ? 'active' : ''} onClick={() => setMode('range')}>
              Intervalo de páginas
            </button>
          </div>
          {mode === 'all' && (
            <>
              <div className="row range">
                <span>Não traduzir as primeiras</span>
                <input
                  type="number"
                  min={0}
                  max={numPages - 1}
                  value={skipStart}
                  onChange={(e) => patch({ skipStart: Math.max(0, Number(e.target.value) || 0) })}
                />
                <span>e as últimas</span>
                <input
                  type="number"
                  min={0}
                  max={numPages - 1}
                  value={skipEnd}
                  onChange={(e) => patch({ skipEnd: Math.max(0, Number(e.target.value) || 0) })}
                />
                <span>páginas</span>
              </div>
              <p className="hint">
                Útil para pular as páginas de aviso da scan. Elas continuam no PDF, só não são traduzidas.
                {(skipStart > 0 || skipEnd > 0) && ` Traduzindo da página ${skipStart + 1} à ${numPages - skipEnd}.`}
              </p>
            </>
          )}
          {mode === 'range' && (
            <div className="row range">
              <span>Da página</span>
              <input type="number" min={1} max={numPages} value={from} onChange={(e) => setFrom(Number(e.target.value) || 1)} />
              <span>até</span>
              <input type="number" min={1} max={numPages} value={to} onChange={(e) => setTo(Number(e.target.value) || 1)} />
            </div>
          )}
        </section>

        <section className="grid-2">
          <div>
            <label className="field-label">Idioma original</label>
            <LanguageSelect allowAuto value={draft.sourceLanguage} onChange={(sourceLanguage) => patch({ sourceLanguage })} />
          </div>
          <div>
            <label className="field-label">Traduzir para</label>
            <LanguageSelect value={draft.targetLanguage} onChange={(targetLanguage) => patch({ targetLanguage })} />
          </div>
        </section>

        <section className="grid-2">
          <div>
            <label className="field-label">Páginas ao mesmo tempo</label>
            <select value={draft.concurrency} onChange={(e) => patch({ concurrency: Number(e.target.value) })}>
              {[1, 2, 3, 4, 5, 6, 8].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="field-label">Velocidade</label>
            <select value={draft.speed} onChange={(e) => patch({ speed: e.target.value as Speed })}>
              {(Object.keys(SPEED_LABEL) as Speed[]).map((s) => (
                <option key={s} value={s}>
                  {SPEED_LABEL[s]}
                </option>
              ))}
            </select>
          </div>
        </section>

        <label className="checkbox">
          <input type="checkbox" checked={draft.translateSfx} onChange={(e) => patch({ translateSfx: e.target.checked })} />
          Traduzir onomatopeias
        </label>

        <section>
          <label className="field-label">Uso da GPU</label>
          <select value={draft.gpuSharing} onChange={(e) => patch({ gpuSharing: e.target.value as GpuSharing })}>
            {(Object.keys(GPU_LABEL) as GpuSharing[]).map((g) => (
              <option key={g} value={g}>
                {GPU_LABEL[g]}
              </option>
            ))}
          </select>
          <p className="hint">
            Uma de cada vez: detecta o capítulo todo, depois traduz, depois redesenha, liberando a GPU entre as etapas. Deixa
            modelos locais bem mais rápidos em placas de até 8 GB.
          </p>
        </section>

        <section>
          <label className="field-label">API</label>
          <div className="row">
            <select value={profile?.id ?? ''} onChange={(e) => onProfileChange(e.target.value)}>
              {settings.profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} · {p.model || 'sem modelo'}
                  {settings.hasKey[p.id] || isLocalProfile(p) ? '' : ' (sem chave)'}
                </option>
              ))}
            </select>
            <button className="secondary" onClick={onOpenSettings}>
              Gerenciar APIs
            </button>
          </div>
          {!ready && <p className="error">Essa API está sem chave ou sem modelo. Configure em "Gerenciar APIs".</p>}
        </section>

        <div className="modal-actions">
          <button className="secondary" onClick={onCancel}>
            Cancelar
          </button>
          <button onClick={start} disabled={!ready}>
            Traduzir {count} {count === 1 ? 'página' : 'páginas'}
          </button>
        </div>
      </div>
    </div>
  )
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}
