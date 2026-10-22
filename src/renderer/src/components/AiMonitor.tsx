import { useEffect, useState } from 'react'
import type { AiMonitorStatus, AiStopTarget, LocalAiStatus } from '../../../shared/types'
import { cleanIpcError } from '../lib/pipeline'

const REFRESH_MS = 2_000

interface Props {
  onClose: () => void
}

/** The local AIs and how much of the GPU they hold, with buttons to free it. */
export function AiMonitor({ onClose }: Props) {
  const [status, setStatus] = useState<AiMonitorStatus | null>(null)
  const [busy, setBusy] = useState<AiStopTarget | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    const refresh = async () => {
      try {
        const next = await window.api.ai.status()
        if (alive) setStatus(next)
      } catch (err) {
        if (alive) setError(cleanIpcError(err))
      }
    }
    refresh()
    const timer = setInterval(refresh, REFRESH_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])

  const stop = async (target: AiStopTarget) => {
    setBusy(target)
    setError(null)
    try {
      await window.api.ai.stop(target)
      setStatus(await window.api.ai.status())
    } catch (err) {
      setError(cleanIpcError(err))
    } finally {
      setBusy(null)
    }
  }

  const gpu = status?.gpu
  const anyRunning = status?.ais.some((a) => a.running) ?? false

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal ai-monitor" onClick={(e) => e.stopPropagation()}>
        <h2>IAs e GPU</h2>

        <section>
          {!status ? (
            <p className="hint">Lendo a GPU…</p>
          ) : gpu ? (
            <div className="gpu-card">
              <div className="gpu-head">
                <strong>{gpu.name}</strong>
                {gpu.temperature !== null && <span className="muted">{gpu.temperature} °C</span>}
              </div>
              <Meter label="Uso" value={gpu.utilization} max={100} text={`${gpu.utilization}%`} />
              <Meter
                label="Memória"
                value={gpu.memoryUsed}
                max={gpu.memoryTotal}
                text={`${formatMiB(gpu.memoryUsed)} de ${formatMiB(gpu.memoryTotal)}`}
              />
            </div>
          ) : (
            <p className="hint">GPU NVIDIA não encontrada (nvidia-smi indisponível).</p>
          )}
        </section>

        <section>
          <label className="field-label">IAs locais</label>
          <div className="ai-list">
            {status?.ais.map((ai) => (
              <AiRow key={ai.id} ai={ai} total={gpu?.memoryTotal ?? 0} busy={busy} onStop={stop} />
            ))}
          </div>
        </section>

        {status && status.others.length > 0 && (
          <section>
            <label className="field-label">Outros programas na GPU</label>
            <div className="ai-others">
              {status.others.map((p) => (
                <div key={p.pid} className="ai-other">
                  <span>{p.name.replace(/\.exe$/i, '')}</span>
                  <span className="muted" title={p.capped ? 'O Windows informa mais do que a placa tem' : undefined}>
                    {p.capped ? 'não informado' : formatMiB(p.gpuMemory)}
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}

        {error && <p className="error">{error}</p>}

        <div className="modal-actions">
          <button className="secondary" onClick={() => stop('all')} disabled={!anyRunning || busy !== null}>
            {busy === 'all' ? 'Liberando…' : 'Liberar GPU (encerrar todas)'}
          </button>
          <button onClick={onClose}>Fechar</button>
        </div>
      </div>
    </div>
  )
}

function AiRow({
  ai,
  total,
  busy,
  onStop
}: {
  ai: LocalAiStatus
  total: number
  busy: AiStopTarget | null
  onStop: (target: AiStopTarget) => void
}) {
  const share = ai.gpuMemory && total ? Math.round((ai.gpuMemory / total) * 100) : 0
  return (
    <div className={`ai-row ${ai.running ? 'on' : ''}`}>
      <div className="ai-main">
        <div className="ai-title">
          <span className={`dot ${ai.running ? 'on' : ''}`} />
          <strong>{ai.name}</strong>
          <span className="muted">{ai.running ? 'rodando' : 'parado'}</span>
        </div>
        <div className="muted small">{ai.role}</div>
        {ai.running && (
          <div className="ai-usage">
            {ai.gpuMemory === null ? (
              <span className="muted small">medindo memória…</span>
            ) : (
              <Meter label="VRAM" value={ai.gpuMemory} max={total || 1} text={`${formatMiB(ai.gpuMemory)} (${share}%)`} />
            )}
            {ai.models.map((m) => (
              <div key={m.name} className="muted small">
                {m.name}: {formatMiB(m.sizeMiB)}, {m.sizeMiB ? Math.round((m.gpuMiB / m.sizeMiB) * 100) : 0}% na GPU
              </div>
            ))}
            {ai.pids.length > 0 && <div className="muted small">PID {ai.pids.join(', ')}</div>}
          </div>
        )}
      </div>
      {ai.running && (
        <div className="ai-actions">
          {ai.id === 'ollama' && ai.models.length > 0 && (
            <button className="secondary small" onClick={() => onStop('ollama-models')} disabled={busy !== null}>
              {busy === 'ollama-models' ? 'Descarregando…' : 'Descarregar modelos'}
            </button>
          )}
          <button className="secondary small" onClick={() => onStop(ai.id)} disabled={busy !== null}>
            {busy === ai.id ? 'Encerrando…' : 'Encerrar'}
          </button>
        </div>
      )}
    </div>
  )
}

function Meter({ label, value, max, text }: { label: string; value: number; max: number; text: string }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100))
  const level = pct >= 90 ? 'high' : pct >= 70 ? 'mid' : ''
  return (
    <div className="meter">
      <span className="meter-label">{label}</span>
      <div className="meter-track">
        <div className={`meter-fill ${level}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="meter-text">{text}</span>
    </div>
  )
}

function formatMiB(mib: number): string {
  return mib >= 1024 ? `${(mib / 1024).toFixed(1)} GB` : `${mib} MB`
}
