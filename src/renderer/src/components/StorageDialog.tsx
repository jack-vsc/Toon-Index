import { useEffect, useState } from 'react'
import { formatBytes, type StorageArea, type StorageUsage } from '../../../shared/storage'

const AREAS: { key: keyof StorageUsage['areas']; label: string; hint: string; clear?: StorageArea; warn?: string }[] = [
  {
    key: 'layers',
    label: 'Camadas de tradução',
    hint: 'Só o que a tradução mudou em cada página. Com elas, traduzir de novo um capítulo apagado leva segundos.',
    clear: 'layers',
    warn: 'Sem as camadas, traduzir de novo um capítulo apagado passa por todas as etapas (detecção e IA).'
  },
  {
    key: 'aiCache',
    label: 'Respostas da IA',
    hint: 'O que a IA respondeu para cada página, para não pagar duas vezes pela mesma.',
    clear: 'aiCache',
    warn: 'As páginas traduzidas de novo voltam a ser pedidas à IA.'
  },
  { key: 'appCache', label: 'Cache do app', hint: 'Do próprio aplicativo; é refeito sozinho.', clear: 'appCache' },
  { key: 'models', label: 'Modelos de IA locais', hint: 'Removidos em "IAs e GPU".' },
  { key: 'phoneUploads', label: 'Fila', hint: 'Os pedidos da fila e os PDFs mandados pelo celular.' }
]

/** How much of the disk the app takes: each work's chapters and what is made again when needed, to clear. */
export function StorageDialog({ onClose }: { onClose: () => void }) {
  const [usage, setUsage] = useState<StorageUsage | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  useEffect(() => {
    void window.api.storage.usage().then(setUsage)
  }, [])

  const run = async (key: string, task: () => Promise<StorageUsage>) => {
    setBusy(key)
    try {
      setUsage(await task())
    } finally {
      setBusy(null)
    }
  }
  const library = usage?.works.reduce((sum, w) => sum + w.translated + w.original + w.other, 0) ?? 0

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal storage-dialog" onClick={(e) => e.stopPropagation()}>
        <h2>Armazenamento</h2>
        {!usage ? (
          <p className="hint">Medindo…</p>
        ) : (
          <>
            <div className="storage-total">
              <strong>{formatBytes(usage.total)}</strong>
              <span>usados pelo Manga Index{usage.free !== null && ` · ${formatBytes(usage.free)} livres no disco`}</span>
            </div>
            <StorageBar
              parts={[
                { label: 'Capítulos', bytes: library },
                ...AREAS.map((a) => ({ label: a.label, bytes: usage.areas[a.key].bytes }))
              ]}
              total={usage.total}
            />

            <h3>Outros</h3>
            <div className="storage-list">
              {AREAS.map((a) => (
                <div key={a.key} className="storage-row">
                  <span className="storage-name">
                    <strong>{a.label}</strong>
                    <span className="hint">{a.hint}</span>
                  </span>
                  <span className="storage-size">{formatBytes(usage.areas[a.key].bytes)}</span>
                  {a.clear ? (
                    <button
                      className="secondary small"
                      disabled={busy !== null || usage.areas[a.key].bytes === 0}
                      onClick={() => {
                        if (a.warn && !confirm(`Limpar ${a.label.toLowerCase()}? ${a.warn}`)) return
                        void run(a.key, () => window.api.storage.clear(a.clear!))
                      }}
                    >
                      {busy === a.key ? 'Limpando…' : 'Limpar'}
                    </button>
                  ) : (
                    <span />
                  )}
                </div>
              ))}
            </div>

            <h3>
              Capítulos por obra <span className="library-count">{formatBytes(library)}</span>
            </h3>
            <p className="hint">
              Apagar os capítulos de uma obra libera o espaço dos PDFs. As leituras e as camadas de tradução ficam: traduzir de novo é rápido.
            </p>
            <div className="storage-list">
              {usage.works.length === 0 && <p className="hint">Nenhum capítulo neste PC.</p>}
              {usage.works.map((w) => (
                <div key={w.workId} className="storage-row">
                  <span className="storage-name">
                    <strong>{w.name}</strong>
                    <span className="hint">
                      {w.chapters} {w.chapters === 1 ? 'capítulo' : 'capítulos'} · traduzidos {formatBytes(w.translated)} · originais{' '}
                      {formatBytes(w.original)}
                    </span>
                  </span>
                  <span className="storage-size">{formatBytes(w.translated + w.original + w.other)}</span>
                  <button
                    className="secondary small"
                    disabled={busy !== null}
                    onClick={() => {
                      if (!confirm(`Apagar os ${w.chapters} capítulos de ${w.name} deste PC? As leituras e as camadas de tradução ficam.`)) return
                      void run(w.workId, () => window.api.storage.deleteWork(w.workId))
                    }}
                  >
                    {busy === w.workId ? 'Apagando…' : 'Apagar'}
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

const COLORS = ['var(--accent)', '#5b8def', '#4ccf8a', '#c58af9', '#f2c94c', '#9e9ea8']

function StorageBar({ parts, total }: { parts: { label: string; bytes: number }[]; total: number }) {
  const shown = parts.filter((p) => p.bytes > 0)
  return (
    <>
      <div className="storage-bar">
        {shown.map((p, i) => (
          <span key={p.label} title={`${p.label}: ${formatBytes(p.bytes)}`} style={{ width: `${(p.bytes / Math.max(1, total)) * 100}%`, background: COLORS[i % COLORS.length] }} />
        ))}
      </div>
      <div className="storage-legend">
        {shown.map((p, i) => (
          <span key={p.label}>
            <i style={{ background: COLORS[i % COLORS.length] }} />
            {p.label} {formatBytes(p.bytes)}
          </span>
        ))}
      </div>
    </>
  )
}
