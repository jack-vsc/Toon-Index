import { useEffect, useState } from 'react'
import type { WebChapterProgress } from '../../../shared/types'
import { cleanIpcError } from '../lib/pipeline'
import { webChapterToPdf } from '../lib/webChapter'

interface Props {
  onFile: (file: File, source: string) => void
  disabled?: boolean
}

/** Opens a chapter from the link of a site's reader page instead of a PDF. */
export function WebLinkInput({ onFile, disabled }: Props) {
  const [url, setUrl] = useState('')
  const [progress, setProgress] = useState<WebChapterProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const busy = progress !== null

  useEffect(() => window.api.web.onProgress(setProgress), [])

  async function open() {
    const link = url.trim()
    if (!link) return
    setError(null)
    setProgress({ stage: 'loading' })
    try {
      const chapter = await window.api.web.chapter(link)
      setProgress({ stage: 'downloading', done: chapter.images.length, total: chapter.images.length })
      const pdf = await webChapterToPdf(chapter)
      onFile(new File([pdf as BlobPart], `${chapter.title}.pdf`, { type: 'application/pdf' }), link)
      setUrl('')
    } catch (err) {
      const message = cleanIpcError(err)
      if (!/cancelado/i.test(message)) setError(message)
    } finally {
      setProgress(null)
    }
  }

  return (
    <div className="web-link">
      <div className="web-link-or">ou abra direto de um site</div>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault()
          if (!busy) open()
        }}
      >
        <input
          type="url"
          placeholder="Cole o link da página de leitura do capítulo"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          disabled={disabled || busy}
        />
        {busy ? (
          <button type="button" className="secondary" onClick={() => window.api.web.cancel()}>
            Cancelar
          </button>
        ) : (
          <button type="submit" disabled={disabled || !url.trim()}>
            Abrir link
          </button>
        )}
      </form>
      {progress && <p className="hint">{describe(progress)}</p>}
      {error && <p className="error">{error}</p>}
    </div>
  )
}

function describe(p: WebChapterProgress): string {
  switch (p.stage) {
    case 'loading':
      return 'Abrindo o site…'
    case 'challenge':
      return 'O site pediu uma verificação: conclua-a na janela que abriu.'
    case 'scrolling':
      return 'Carregando as páginas do capítulo…'
    case 'downloading':
      return p.done === p.total && p.total > 0 ? `Montando o capítulo (${p.total} páginas)…` : `Baixando páginas: ${p.done} de ${p.total}`
  }
}
