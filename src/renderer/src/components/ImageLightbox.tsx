import { useEffect } from 'react'
import { TransformComponent, TransformWrapper, useControls } from 'react-zoom-pan-pinch'

interface ImageLightboxProps {
  open: boolean
  src: string | null
  title?: string
  onClose: () => void
}

function LightboxToolbar({ onClose, title }: { onClose: () => void; title?: string }) {
  const { zoomIn, zoomOut, resetTransform } = useControls()

  return (
    <div className="image-lightbox-toolbar" onClick={(e) => e.stopPropagation()}>
      <span className="image-lightbox-title" title={title}>{title ?? 'Imagem'}</span>
      <div className="image-lightbox-actions">
        <button type="button" onClick={() => zoomOut(0.35)} title="Diminuir zoom">−</button>
        <button type="button" onClick={() => resetTransform()} title="Ajustar à tela">Ajustar</button>
        <button type="button" onClick={() => zoomIn(0.35)} title="Aumentar zoom">+</button>
        <button type="button" className="image-lightbox-close" onClick={onClose} title="Fechar (Esc)">
          ✕
        </button>
      </div>
    </div>
  )
}

export function ImageLightbox({ open, src, title, onClose }: ImageLightboxProps) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="image-lightbox-backdrop" onClick={onClose} role="dialog" aria-modal="true" aria-label={title ?? 'Visualizador de imagem'}>
      <TransformWrapper
        initialScale={1}
        minScale={0.08}
        maxScale={12}
        centerOnInit
        limitToBounds={false}
        wheel={{ step: 0.12 }}
        pinch={{ step: 0.12 }}
        panning={{ velocityDisabled: true }}
        doubleClick={{ mode: 'reset' }}
      >
        <LightboxToolbar onClose={onClose} title={title} />
        <div className="image-lightbox-stage" onClick={(e) => e.stopPropagation()}>
          {!src ? (
            <p className="image-lightbox-loading">Carregando imagem…</p>
          ) : (
            <TransformComponent wrapperClass="image-lightbox-wrapper" contentClass="image-lightbox-content">
              <img src={src} alt={title ?? ''} className="image-lightbox-img" draggable={false} />
            </TransformComponent>
          )}
        </div>
      </TransformWrapper>
      <p className="image-lightbox-hint">Scroll = zoom · Arraste = mover · Duplo clique = ajustar · Esc = fechar</p>
    </div>
  )
}
