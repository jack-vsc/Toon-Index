import { useEffect, useState } from 'react'
import type { HistoryWork } from '../../../shared/reading'
import { displayName } from '../../../shared/works'

interface Props {
  onClose: () => void
  onImported: () => void
}

/**
 * Finds the chapters read in the browsers' history and lets the person pick which works are really
 * manga before importing: "Episode 3" of a series or "Chapter 2" of a tutorial look the same.
 */
export function HistoryImport({ onClose, onImported }: Props) {
  const [works, setWorks] = useState<HistoryWork[] | null>(null)
  const [problems, setProblems] = useState<string[]>([])
  const [chosen, setChosen] = useState<Set<number>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<number | null>(null)

  useEffect(() => {
    window.api.reading
      .scanHistory()
      .then((result) => {
        setWorks(result.works)
        setProblems(result.problems)
        // Works already known are surely manga; others with a few chapters most likely are.
        setChosen(new Set(result.works.flatMap((w, i) => (w.workId || w.chapters.length >= 2 ? [i] : []))))
      })
      .catch((err: Error) => setError(err.message))
  }, [])

  async function importChosen() {
    if (!works) return
    setDone(await window.api.reading.importHistory(works.filter((_w, i) => chosen.has(i))))
    onImported()
  }

  const toggle = (i: number) => {
    const next = new Set(chosen)
    if (next.has(i)) next.delete(i)
    else next.add(i)
    setChosen(next)
  }

  return (
    <div className="work-editor history-import">
      <strong>Importar do histórico do navegador</strong>
      <p className="hint">
        Capítulos abertos no Chrome, Brave, Opera e Edge deste computador. O último capítulo de cada obra fica como
        "em andamento" (não dá para saber se você terminou); os anteriores, como lidos. Desmarque o que não for mangá.
      </p>
      {error && <p className="error">{error}</p>}
      {problems.map((p) => (
        <p key={p} className="error">
          {p}
        </p>
      ))}
      {!works && !error && <p className="hint">Lendo o histórico…</p>}
      {works && works.length === 0 && <p className="hint">Nenhum capítulo encontrado no histórico.</p>}
      {works && done === null && works.length > 0 && (
        <>
          <div className="row">
            <button className="secondary small" onClick={() => setChosen(new Set(works.map((_w, i) => i)))}>
              Marcar todas
            </button>
            <button className="secondary small" onClick={() => setChosen(new Set())}>
              Desmarcar todas
            </button>
            <span className="hint">
              {chosen.size} de {works.length} obras
            </span>
          </div>
          <div className="history-list">
            {works.map((w, i) => {
              const numbers = w.chapters.map((c) => c.chapter)
              const last = Math.max(...w.chapters.map((c) => c.at))
              return (
                <label key={i} className="history-item">
                  <input type="checkbox" checked={chosen.has(i)} onChange={() => toggle(i)} />
                  <span>
                    <strong>{displayName(w.name)}</strong>
                    {w.format === 'novel' && <span className="format-tag">novel</span>}
                    {w.workId && <span className="read-mark"> já na biblioteca</span>}
                    <br />
                    <span className="hint">
                      {numbers.length === 1 ? `cap. ${numbers[0]}` : `${numbers.length} capítulos, ${Math.min(...numbers)} a ${Math.max(...numbers)}`} ·{' '}
                      {w.sites.slice(0, 3).join(', ')}
                      {w.sites.length > 3 ? '…' : ''} · {w.browsers.join(', ')} · {new Date(last).toLocaleDateString('pt-BR')}
                    </span>
                  </span>
                </label>
              )
            })}
          </div>
        </>
      )}
      {done !== null && <p className="hint">{done} capítulos importados.</p>}
      <div className="row">
        {works && done === null && works.length > 0 && (
          <button onClick={importChosen} disabled={chosen.size === 0}>
            Importar {chosen.size} {chosen.size === 1 ? 'obra' : 'obras'}
          </button>
        )}
        <button className="secondary" onClick={onClose}>
          Fechar
        </button>
      </div>
    </div>
  )
}
