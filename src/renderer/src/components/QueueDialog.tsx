import { useEffect, useState } from 'react'
import type { RemoteJob, RemoteQueue } from '../../../shared/remoteJobs'
import {
  isLocalProfile,
  languageLabel,
  TRANSLATE_OPTION_KEYS,
  type AiDevice,
  type GpuSharing,
  type PublicSettings,
  type Speed,
  type TranslateOptions
} from '../../../shared/types'
import { LanguageSelect } from './LanguageSelect'
import { GPU_LABEL } from './SetupView'

/**
 * The queue as it will run: the chapter on now, then the ones waiting, which can be dragged or moved
 * up, down or to the top, or taken off; and the ones that failed, to try again.
 */
export function QueueDialog({
  queue,
  running,
  settings,
  onClose
}: {
  queue: RemoteQueue
  running: RemoteJob | null
  settings: PublicSettings
  onClose: () => void
}) {
  const waiting = queue.jobs.filter((j) => j.status === 'queued')
  const failed = queue.jobs.filter((j) => j.status === 'failed' && j.kind === 'link' && Date.now() - j.updatedAt < 86_400_000)
  // The order shown while dragging, before it is saved.
  const [order, setOrder] = useState(waiting.map((j) => j.id))
  const [dragging, setDragging] = useState<string | null>(null)
  const ids = waiting.map((j) => j.id).join('|')
  useEffect(() => {
    if (!dragging) setOrder(waiting.map((j) => j.id))
  }, [ids])
  const byId = new Map(waiting.map((j) => [j.id, j]))
  const shown = order.map((id) => byId.get(id)).filter((j): j is RemoteJob => !!j)

  const save = (next: string[]) => {
    setOrder(next)
    void window.api.remote.reorder(next)
  }
  const move = (id: string, to: number) => {
    const next = order.filter((o) => o !== id)
    next.splice(Math.max(0, Math.min(next.length, to)), 0, id)
    save(next)
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal queue-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="queue-head">
          <h2>Fila</h2>
          <button className="secondary small" title="Os capítulos de cada obra em ordem crescente" onClick={() => window.api.remote.sort()}>
            Ordenar por capítulo
          </button>
          <button className="secondary small" onClick={() => window.api.remote.pause(!queue.paused)}>
            {queue.paused ? 'Continuar' : 'Pausar'}
          </button>
        </div>
        <p className="hint">Arraste um capítulo, ou use as setas, para mudar a ordem em que serão traduzidos ou baixados.</p>

        {waiting.length > 0 && <QueueOptions waiting={waiting} settings={settings} />}

        {running && <RunningCard job={running} paused={queue.paused} />}

        <div className="queue-list">
          {shown.length === 0 && <p className="hint">Nada esperando na fila.</p>}
          {shown.map((job, i) => (
            <div
              key={job.id}
              className={`queue-row ${dragging === job.id ? 'dragging' : ''}`}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = 'move'
                setDragging(job.id)
              }}
              onDragOver={(e) => {
                e.preventDefault()
                if (!dragging || dragging === job.id) return
                const next = order.filter((o) => o !== dragging)
                next.splice(next.indexOf(job.id) + (order.indexOf(dragging) < order.indexOf(job.id) ? 1 : 0), 0, dragging)
                setOrder(next)
              }}
              onDragEnd={() => {
                setDragging(null)
                save(order)
              }}
            >
              <span className="queue-grip" title="Arraste">
                ⠿
              </span>
              <span className="queue-pos">{i + 1}</span>
              <JobLabel job={job} />
              <span className="queue-buttons">
                <button className="secondary small" title="Para o começo da fila" disabled={i === 0} onClick={() => move(job.id, 0)}>
                  ⤒
                </button>
                <button className="secondary small" title="Subir" disabled={i === 0} onClick={() => move(job.id, i - 1)}>
                  ↑
                </button>
                <button className="secondary small" title="Descer" disabled={i === shown.length - 1} onClick={() => move(job.id, i + 1)}>
                  ↓
                </button>
                <button className="secondary small" title="Tirar da fila" onClick={() => window.api.remote.cancel(job.id)}>
                  ✕
                </button>
              </span>
            </div>
          ))}
        </div>

        {failed.length > 0 && (
          <>
            <div className="queue-head">
              <h3>Falharam</h3>
              <button className="small" onClick={() => window.api.remote.retryBatch(failed.map((f) => f.id))}>
                Tentar todos de novo
              </button>
            </div>
            <div className="queue-list">
              {failed.map((job) => (
                <div key={job.id} className="queue-row failed">
                  <JobLabel job={job} />
                  <span className="queue-state" title={job.message}>
                    {job.message ?? 'falhou'}
                  </span>
                  <button className="secondary small" onClick={() => window.api.remote.retryBatch([job.id])}>
                    Tentar de novo
                  </button>
                </div>
              ))}
            </div>
          </>
        )}

        <div className="modal-actions">
          <button onClick={onClose}>Fechar</button>
        </div>
      </div>
    </div>
  )
}

const SPEED: Record<Speed, string> = { fast: 'Rápido', balanced: 'Equilibrado', quality: 'Qualidade máxima' }

/**
 * The options the chapters waiting are translated with: the PC's settings, or others chosen here for
 * the whole queue (the vision server on the processor overnight, say).
 */
function QueueOptions({ waiting, settings }: { waiting: RemoteJob[]; settings: PublicSettings }) {
  const own = waiting.find((j) => j.options)?.options
  const mixed = waiting.some((j) => JSON.stringify(j.options ?? null) !== JSON.stringify(waiting[0].options ?? null))
  const [open, setOpen] = useState(false)
  const base = Object.fromEntries(TRANSLATE_OPTION_KEYS.map((k) => [k, settings[k]])) as unknown as TranslateOptions
  const [draft, setDraft] = useState<TranslateOptions>({ ...base, ...own })
  const patch = (p: Partial<TranslateOptions>) => setDraft((d) => ({ ...d, ...p }))
  const profile = settings.profiles.find((p) => p.id === draft.activeProfileId)
  const now = { ...base, ...own }
  const summary = [
    `visão na ${now.visionDevice === 'cpu' ? 'CPU' : 'GPU'}`,
    settings.profiles.find((p) => p.id === now.activeProfileId)?.name,
    SPEED[now.speed],
    languageLabel(now.targetLanguage)
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <div className="queue-options">
      <div className="queue-head">
        <span>
          <strong>Opções da fila:</strong> {mixed ? 'cada capítulo com as suas' : own ? summary : `as do PC (${summary})`}
        </span>
        <button className="secondary small" onClick={() => setOpen(!open)}>
          {open ? 'Fechar' : 'Mudar'}
        </button>
      </div>
      {open && (
        <>
          <div className="grid-2">
            <div>
              <label className="field-label">Visão (achar e apagar o texto) em</label>
              <select value={draft.visionDevice} onChange={(e) => patch({ visionDevice: e.target.value as AiDevice })}>
                <option value="gpu">Placa de vídeo (GPU)</option>
                <option value="cpu">Processador (deixa a GPU livre)</option>
              </select>
            </div>
            <div>
              <label className="field-label">API</label>
              <select value={draft.activeProfileId} onChange={(e) => patch({ activeProfileId: e.target.value })}>
                {settings.profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} · {p.model || 'sem modelo'}
                  </option>
                ))}
              </select>
            </div>
            {profile && isLocalProfile(profile) && (
              <div>
                <label className="field-label">Modelo de tradução local em</label>
                <select value={draft.aiDevice} onChange={(e) => patch({ aiDevice: e.target.value as AiDevice })}>
                  <option value="gpu">Placa de vídeo (GPU)</option>
                  <option value="cpu">Processador e RAM</option>
                </select>
              </div>
            )}
            <div>
              <label className="field-label">Velocidade</label>
              <select value={draft.speed} onChange={(e) => patch({ speed: e.target.value as Speed })}>
                {(Object.keys(SPEED) as Speed[]).map((s) => (
                  <option key={s} value={s}>
                    {SPEED[s]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="field-label">Idioma original</label>
              <LanguageSelect allowAuto value={draft.sourceLanguage} onChange={(sourceLanguage) => patch({ sourceLanguage })} />
            </div>
            <div>
              <label className="field-label">Traduzir para</label>
              <LanguageSelect value={draft.targetLanguage} onChange={(targetLanguage) => patch({ targetLanguage })} />
            </div>
            <div>
              <label className="field-label">Uso da GPU</label>
              <select value={draft.gpuSharing} onChange={(e) => patch({ gpuSharing: e.target.value as GpuSharing })}>
                {(Object.keys(GPU_LABEL) as GpuSharing[]).map((g) => (
                  <option key={g} value={g}>
                    {GPU_LABEL[g]}
                  </option>
                ))}
              </select>
            </div>
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
          </div>
          <label className="checkbox">
            <input type="checkbox" checked={draft.translateSfx} onChange={(e) => patch({ translateSfx: e.target.checked })} />
            Traduzir onomatopeias
          </label>
          <div className="modal-actions">
            <button className="secondary small" onClick={() => (window.api.remote.setOptions(null), setOpen(false))}>
              Usar as do PC
            </button>
            <button className="small" onClick={() => (window.api.remote.setOptions(draft), setOpen(false))}>
              Aplicar aos {waiting.length} da fila
            </button>
          </div>
        </>
      )}
    </div>
  )
}

/** The chapter on now, as a download manager shows one: what it is doing, how far, and a bar. */
function RunningCard({ job, paused }: { job: RemoteJob; paused: boolean }) {
  const share = job.progress ? percent(job.progress) : null
  const site = job.url ? hostOf(job.url) : null
  return (
    <div className="queue-card">
      <div className="queue-card-top">
        <div className="queue-card-text">
          <span className="queue-pill">{job.message ?? 'Começando'}…</span>
          <div className="queue-card-title">
            {job.batch ? (
              <>
                Cap. {job.batch.chapter} · {job.batch.work}
              </>
            ) : job.kind === 'link' ? (
              job.url
            ) : (
              job.name
            )}
          </div>
          <div className="queue-card-sub">
            {[site, job.batch?.download ? 'baixar' : 'traduzir', job.options?.visionDevice === 'cpu' && 'visão na CPU'].filter(Boolean).join(' · ')}
          </div>
        </div>
        <div className="queue-card-numbers">
          <strong>{job.progress ? `${job.progress.done}/${job.progress.total} páginas` : '—'}</strong>
          <span>{share !== null ? `${share}%` : 'abrindo o capítulo'}</span>
        </div>
      </div>
      <div className="queue-bar">
        <span style={{ width: `${share ?? 0}%` }} />
      </div>
      <div className="queue-card-actions">
        <button className="secondary small" onClick={() => window.api.remote.pause(!paused)}>
          {paused ? '▶ Continuar' : '❚❚ Pausar'}
        </button>
      </div>
    </div>
  )
}

const hostOf = (url: string): string | null => {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return null
  }
}

function JobLabel({ job }: { job: RemoteJob }) {
  return (
    <span className="queue-name">
      {job.batch ? (
        <>
          <strong>Cap. {job.batch.chapter}</strong> {job.batch.work}
        </>
      ) : (
        <strong>{job.kind === 'link' ? job.url : job.name}</strong>
      )}
      <span className="badge">{job.batch?.download ? 'baixar' : 'traduzir'}</span>
      {job.options?.visionDevice === 'cpu' && <span className="badge">visão na CPU</span>}
    </span>
  )
}

const percent = ({ done, total }: { done: number; total: number }): number => (total ? Math.round((done / total) * 100) : 0)
