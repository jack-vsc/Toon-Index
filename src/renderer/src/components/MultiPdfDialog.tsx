import { useState } from 'react'
import { isLocalProfile, type ContentType, type PublicSettings, type TranslateOptions } from '../../../shared/types'
import { LanguageSelect } from './LanguageSelect'

interface Props {
  files: File[]
  settings: PublicSettings
  onQueue: (options: Partial<TranslateOptions>) => void
  onClose: () => void
}

const TYPES: [ContentType, string][] = [
  ['auto', 'Automático'],
  ['comic', 'Mangá / webtoon'],
  ['novel', 'Novel (texto)']
]

/** Several PDFs chosen at once: what they are and how to translate them, before they go to the queue. */
export function MultiPdfDialog({ files, settings, onQueue, onClose }: Props) {
  const [contentType, setContentType] = useState<ContentType>(settings.contentType)
  const [sourceLanguage, setSourceLanguage] = useState(settings.sourceLanguage)
  const [targetLanguage, setTargetLanguage] = useState(settings.targetLanguage)
  const [activeProfileId, setActiveProfileId] = useState(settings.activeProfileId)

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Traduzir {files.length} PDFs</h2>
        <p className="hint">Eles vão para a fila, nesta ordem, e são traduzidos um depois do outro.</p>
        <ol className="multi-pdf-list">
          {files.map((f) => (
            <li key={f.name}>{f.name.replace(/\.pdf$/i, '')}</li>
          ))}
        </ol>

        <label className="field-label">Tipo</label>
        <div className="segmented">
          {TYPES.map(([value, label]) => (
            <button key={value} className={contentType === value ? 'active' : ''} onClick={() => setContentType(value)}>
              {label}
            </button>
          ))}
        </div>
        <p className="hint">
          {contentType === 'auto' && 'Cada PDF é olhado sozinho: com texto na maioria das páginas, vira novel; senão, mangá.'}
          {contentType === 'comic' && 'Acha os balões nas imagens, traduz e redesenha o texto por cima.'}
          {contentType === 'novel' &&
            'Lê o texto do próprio PDF, traduz parágrafo por parágrafo e monta as páginas de novo. As ilustrações ficam como estão.'}
        </p>

        <div className="grid-2">
          <div>
            <label className="field-label">Idioma original</label>
            <LanguageSelect allowAuto value={sourceLanguage} onChange={setSourceLanguage} />
          </div>
          <div>
            <label className="field-label">Traduzir para</label>
            <LanguageSelect value={targetLanguage} onChange={setTargetLanguage} />
          </div>
        </div>

        <label className="field-label">API</label>
        <select value={activeProfileId} onChange={(e) => setActiveProfileId(e.target.value)}>
          {settings.profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} · {p.model || 'sem modelo'}
              {settings.hasKey[p.id] || isLocalProfile(p) ? '' : ' (sem chave)'}
            </option>
          ))}
        </select>
        <p className="hint">O resto (páginas ao mesmo tempo, onomatopeias, GPU) segue as configurações do PC.</p>

        <div className="modal-actions">
          <button className="secondary" onClick={onClose}>
            Cancelar
          </button>
          <button onClick={() => onQueue({ contentType, sourceLanguage, targetLanguage, activeProfileId })}>Pôr na fila</button>
        </div>
      </div>
    </div>
  )
}
