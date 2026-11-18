import { useRef, useState } from 'react'

interface Props {
  onFile: (file: File) => void
  /** Several PDFs at once: they go to the queue, translated one after another. */
  onFiles: (files: File[]) => void
  disabled?: boolean
}

export function DropZone({ onFile, onFiles, disabled }: Props) {
  const input = useRef<HTMLInputElement>(null)
  const [hover, setHover] = useState(false)

  function pick(files: FileList | null) {
    const pdfs = [...(files ?? [])].filter((f) => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'))
    if (pdfs.length === 1) onFile(pdfs[0])
    // In the order of their names, chapter 2 before chapter 10.
    else if (pdfs.length > 1) onFiles(pdfs.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR', { numeric: true })))
    if (input.current) input.current.value = ''
  }

  return (
    <div
      className={`dropzone ${hover ? 'hover' : ''} ${disabled ? 'disabled' : ''}`}
      onClick={() => !disabled && input.current?.click()}
      onDragOver={(e) => {
        e.preventDefault()
        if (!disabled) setHover(true)
      }}
      onDragLeave={() => setHover(false)}
      onDrop={(e) => {
        e.preventDefault()
        setHover(false)
        if (!disabled) pick(e.dataTransfer.files)
      }}
    >
      <div className="dropzone-icon">📄</div>
      <p className="dropzone-title">Arraste o PDF do capítulo aqui</p>
      <p className="dropzone-sub">ou clique para escolher. Vários PDFs de uma vez vão para a fila, um depois do outro.</p>
      <input ref={input} type="file" accept="application/pdf,.pdf" multiple hidden onChange={(e) => pick(e.target.files)} />
    </div>
  )
}
