import { useRef, useState } from 'react'

interface Props {
  onFile: (file: File) => void
  disabled?: boolean
}

export function DropZone({ onFile, disabled }: Props) {
  const input = useRef<HTMLInputElement>(null)
  const [hover, setHover] = useState(false)

  function pick(files: FileList | null) {
    const file = files?.[0]
    if (file && (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf'))) onFile(file)
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
      <p className="dropzone-sub">ou clique para escolher o arquivo</p>
      <input ref={input} type="file" accept="application/pdf,.pdf" hidden onChange={(e) => pick(e.target.files)} />
    </div>
  )
}
