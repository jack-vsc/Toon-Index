import { useEffect, useState } from 'react'
import type { RemoteJob, RemoteQueue } from '../../../shared/remoteJobs'

/**
 * The queue as it will run: the chapter on now, then the ones waiting, which can be dragged or moved
 * up, down or to the top, or taken off; and the ones that failed, to try again.
 */
export function QueueDialog({ queue, running, onClose }: { queue: RemoteQueue; running: RemoteJob | null; onClose: () => void }) {
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

        {running && (
          <div className="queue-row now">
            <span className="queue-pos">▶</span>
            <JobLabel job={running} />
            <span className="queue-state">{running.message ?? 'agora'}</span>
          </div>
        )}

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
    </span>
  )
}
