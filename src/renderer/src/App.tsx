import { useEffect, useRef, useState } from 'react'
import type { AppError } from '../../shared/errors'
import { activeProfile, profileReady, type AppSettings, type LibraryEntry, type PublicSettings, type ReaderMode } from '../../shared/types'
import type { Work } from '../../shared/works'
import { DropZone } from './components/DropZone'
import { LibraryView } from './components/LibraryView'
import { ProgressView, statusText } from './components/ProgressView'
import { Reader, type ReaderPage } from './components/Reader'
import { SettingsDialog } from './components/SettingsDialog'
import { SetupView, type SetupChoice } from './components/SetupView'
import { AdminDashboard } from './components/AdminDashboard'
import { AiMonitor } from './components/AiMonitor'
import { runPhased } from './lib/gpuSharing'
import { WebLinkInput } from './components/WebLinkInput'
import { canvasToBlob, renderPage, thumbnailCanvas } from './lib/pdf'
import { cleanIpcError, TranslationJob, type PageState } from './lib/pipeline'
import { usePdfPages } from './lib/usePdfPages'

type View = 'home' | 'setup' | 'processing' | 'result'

interface LoadedFile {
  name: string
  bytes: Uint8Array
  /** Link the chapter was read from, when it came from a site. */
  source?: string
}

interface ReaderSource {
  title: string
  /** Translated PDF; null until the job's PDF has been built. */
  translated: Uint8Array | null
  /** Loaded lazily for library entries. */
  original: Uint8Array | null
  libraryId?: string
  /** True when the pages come straight from the running job instead of a PDF. */
  fromJob: boolean
}

export default function App() {
  const [settings, setSettings] = useState<PublicSettings | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [view, setView] = useState<View>('home')
  const [processingTab, setProcessingTab] = useState<'read' | 'grid'>('read')
  const [file, setFile] = useState<LoadedFile | null>(null)
  const [setupInfo, setSetupInfo] = useState<{ numPages: number; cover: string | null } | null>(null)
  const [pages, setPages] = useState<PageState[]>([])
  const [running, setRunning] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [stopReason, setStopReason] = useState<AppError | null>(null)
  const [reader, setReader] = useState<ReaderSource | null>(null)
  const [showOriginal, setShowOriginal] = useState(false)
  const [zoom, setZoom] = useState(60)
  const [message, setMessage] = useState<string | null>(null)
  const [library, setLibrary] = useState<LibraryEntry[]>([])
  const [works, setWorks] = useState<Work[]>([])
  const [adminOpen, setAdminOpen] = useState(false)
  const [aiMonitorOpen, setAiMonitorOpen] = useState(false)
  const job = useRef<TranslationJob | null>(null)
  const fileRef = useRef<LoadedFile | null>(null)

  useEffect(() => {
    window.api.getSettings().then(setSettings)
    refreshLibrary()
  }, [])

  // Listing the chapters indexes old ones into works, so works are read after it.
  const refreshLibrary = async () => {
    setLibrary(await window.api.library.list())
    setWorks(await window.api.works.list())
  }

  const profile = settings ? activeProfile(settings) : undefined
  const configured = !!settings && profileReady(profile, settings.hasKey)
  const readerMode: ReaderMode = settings?.readerMode ?? 'scroll'

  const inResult = view === 'result' && !!reader
  const pdfPages = usePdfPages(inResult && !showOriginal && !reader.fromJob ? reader.translated : null)
  const originalPages = usePdfPages(inResult && showOriginal ? reader.original : null)
  const jobPages: ReaderPage[] = pages.map((p) => ({
    key: `job-${p.number}`,
    number: p.number,
    url: p.imageUrl,
    aspect: p.aspect,
    tall: p.tall,
    status: statusText(p)
  }))
  const readerPages = view === 'processing' ? jobPages : showOriginal ? originalPages : reader?.fromJob ? jobPages : pdfPages

  async function openFile(selected: File, source?: string) {
    if (!settings || !configured) {
      setSettingsOpen(true)
      return
    }
    setMessage(null)
    const bytes = new Uint8Array(await selected.arrayBuffer())
    disposeJob()
    fileRef.current = { name: selected.name, bytes, source }
    setFile(fileRef.current)
    setSetupInfo(null)
    setView('setup')

    try {
      job.current = await TranslationJob.open(bytes, setPages)
      const first = await renderPage(job.current.doc, 1, 480)
      const cover = URL.createObjectURL(await canvasToBlob(thumbnailCanvas(first.canvas, 480), 'image/jpeg', 0.85))
      setSetupInfo({ numPages: job.current.numPages, cover })
    } catch (err) {
      setMessage(`Não foi possível abrir o PDF: ${cleanIpcError(err)}`)
      setView('home')
    }
  }

  async function startTranslation(choice: SetupChoice) {
    if (!job.current || !settings) return
    const saved = await saveSettingsPatch(choice.options)
    if (!saved) return
    setProcessingTab('read')
    setView('processing')
    await job.current.select(choice.pages, choice.untranslated)
    await translate(saved.concurrency)
  }

  async function translate(concurrency = settings?.concurrency ?? 3) {
    const current = job.current
    if (!current || !settings) return
    setRunning(true)
    setStopReason(null)
    await current.run(concurrency, await runPhased(settings))
    setRunning(false)
    setStopping(false)
    setStopReason(current.stopReason)
    if (job.current === current && current.pages.every((p) => p.status === 'done' || p.status === 'skipped')) {
      await finish()
    }
  }

  /** Failed pages go back to the queue; a running job picks them up, otherwise a new run starts. */
  function retryPages(pageNumbers?: number[]) {
    const current = job.current
    if (!current) return
    current.retry(pageNumbers)
    if (!running) void translate()
  }

  function stop() {
    setStopping(true)
    job.current?.cancel()
  }

  async function finish() {
    const current = fileRef.current
    if (!job.current || !current) return
    const { pdf, cover } = await job.current.buildPdf(translatedName(current.name))
    const entry = await window.api.library.save({
      fileName: current.name,
      source: current.source,
      pageCount: job.current.pages.length,
      translatedPages: job.current.translatedCount,
      original: current.bytes,
      translated: pdf,
      coverJpeg: cover
    })
    await refreshLibrary()
    setReader({ title: current.name, translated: pdf, original: current.bytes, libraryId: entry.id, fromJob: true })
    setShowOriginal(false)
    setMessage('Capítulo salvo na biblioteca.')
    setView('result')
  }

  async function openFromLibrary(entry: LibraryEntry) {
    setMessage(null)
    disposeJob()
    setPages([])
    const translated = await window.api.library.pdf(entry.id, 'translated')
    setReader({ title: entry.fileName, translated, original: null, libraryId: entry.id, fromJob: false })
    setShowOriginal(false)
    setView('result')
  }

  async function toggleOriginal(original: boolean) {
    if (original && reader && !reader.original && reader.libraryId) {
      const bytes = await window.api.library.pdf(reader.libraryId, 'original')
      setReader({ ...reader, original: bytes })
    }
    setShowOriginal(original)
  }

  /** Saves on top of the latest settings, so fields edited elsewhere are not overwritten. */
  async function saveSettingsPatch(patch: Partial<AppSettings>): Promise<PublicSettings | null> {
    if (!settings) return null
    const { hasKey: _h, keyHint: _k, ...base } = settings
    setSettings({ ...settings, ...patch })
    const saved = await window.api.saveSettings({ settings: { ...base, ...patch } })
    setSettings(saved)
    return saved
  }

  async function setReaderMode(mode: ReaderMode) {
    await saveSettingsPatch({ readerMode: mode })
  }

  async function download(bytes: Uint8Array, name: string) {
    const saved = await window.api.savePdf(bytes, translatedName(name))
    if (saved) setMessage(`Salvo em ${saved}`)
  }

  async function downloadEntry(entry: LibraryEntry) {
    await download(await window.api.library.pdf(entry.id, 'translated'), entry.fileName)
  }

  async function deleteEntry(entry: LibraryEntry) {
    await window.api.library.remove(entry.id)
    await refreshLibrary()
  }

  function disposeJob() {
    job.current?.dispose()
    job.current = null
  }

  function goHome() {
    disposeJob()
    if (setupInfo?.cover) URL.revokeObjectURL(setupInfo.cover)
    setFile(null)
    setPages([])
    setReader(null)
    setSetupInfo(null)
    setRunning(false)
    setStopping(false)
    setStopReason(null)
    setView('home')
  }

  const failed = pages.filter((p) => p.status === 'error').length
  const pending = pages.filter((p) => p.status === 'pending').length
  const toTranslate = pages.filter((p) => p.status !== 'skipped').length
  const finished = pages.filter((p) => p.status === 'done' || p.status === 'error').length
  const topError = mostCommonError(pages)
  const shownError = stopReason ?? topError?.error
  const title = view === 'result' ? reader?.title : file?.name
  const showReader = (view === 'processing' && processingTab === 'read') || view === 'result'

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">漫</span>
          <span>Manga Index</span>
          {view !== 'home' && title && <span className="file-name">· {title}</span>}
        </div>
        <div className="topbar-actions">
          {view === 'processing' && (
            <div className="segmented small">
              <button className={processingTab === 'read' ? 'active' : ''} onClick={() => setProcessingTab('read')}>
                Ler
              </button>
              <button className={processingTab === 'grid' ? 'active' : ''} onClick={() => setProcessingTab('grid')}>
                Páginas
              </button>
            </div>
          )}
          {view === 'result' && reader && (
            <div className="segmented small">
              <button className={!showOriginal ? 'active' : ''} onClick={() => toggleOriginal(false)}>
                Traduzido
              </button>
              <button className={showOriginal ? 'active' : ''} onClick={() => toggleOriginal(true)}>
                Original
              </button>
            </div>
          )}
          {showReader && (
            <>
              <div className="segmented small" title="Modo de leitura">
                <button className={readerMode === 'scroll' ? 'active' : ''} onClick={() => setReaderMode('scroll')}>
                  Vertical
                </button>
                <button className={readerMode === 'paged' ? 'active' : ''} onClick={() => setReaderMode('paged')}>
                  Por página
                </button>
              </div>
              <label className="zoom">
                Zoom
                <input type="range" min={30} max={100} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} />
              </label>
            </>
          )}
          {view === 'processing' && running && (
            <button className="secondary" onClick={stop} disabled={stopping}>
              {stopping ? 'Parando…' : 'Parar'}
            </button>
          )}
          {view === 'processing' && !running && (failed > 0 || pending > 0) && (
            <>
              <button className="secondary" onClick={() => translate()}>
                {failed > 0 ? `Tentar novamente (${failed + pending})` : `Continuar (${pending})`}
              </button>
              <button onClick={finish}>Gerar PDF assim mesmo</button>
            </>
          )}
          {view === 'result' && reader && (
            <>
              {reader.fromJob && job.current && (
                <button className="secondary" onClick={() => setView('processing')}>
                  Páginas
                </button>
              )}
              {reader.translated && <button onClick={() => download(reader.translated!, reader.title)}>⬇ Baixar PDF</button>}
            </>
          )}
          {view !== 'home' && (
            <button className="secondary" onClick={goHome} disabled={running}>
              Início
            </button>
          )}
          <button className="icon" title="IAs e GPU" onClick={() => setAiMonitorOpen(true)}>
            📊
          </button>
          <button className="icon" title="Configurações" onClick={() => setSettingsOpen(true)}>
            ⚙
          </button>
          <button className="icon" title="Admin treino" onClick={() => setAdminOpen(true)}>
            🧠
          </button>
        </div>
      </header>

      {adminOpen ? (
        <main className="content" style={{ padding: 12, height: 'calc(100vh - 64px)', boxSizing: 'border-box' }}>
          <AdminDashboard onClose={() => setAdminOpen(false)} />
        </main>
      ) : (
        <>
          {view === 'processing' && (
            <div className="progress-strip">
              <div className="progress-bar">
                <div className="progress-fill" style={{ width: `${toTranslate ? (finished / toTranslate) * 100 : 0}%` }} />
              </div>
              <span>
                {finished} de {toTranslate} páginas traduzidas{failed > 0 ? ` · ${failed} com erro` : ''}
                {!running && pending > 0 ? ' · pausado' : ''}
              </span>
            </div>
          )}

          {view === 'processing' && shownError && (
            <div className="error-banner">
              <div className="error-banner-text">
                <strong>
                  {stopReason ? 'Tradução pausada: ' : `${failed} ${failed === 1 ? 'página falhou' : 'páginas falharam'}: `}
                </strong>
                {shownError.message}
                {!stopReason && topError && topError.kinds > 1 && <span className="hint"> Há outros erros: veja a aba Páginas.</span>}
                {shownError.detail && (
                  <details>
                    <summary>Detalhes técnicos</summary>
                    <pre>{shownError.detail}</pre>
                  </details>
                )}
              </div>
              <div className="error-banner-actions">
                {failed > 0 && (
                  <button onClick={() => retryPages()} disabled={stopping}>
                    Tentar de novo ({failed})
                  </button>
                )}
                <button className="secondary" onClick={() => setSettingsOpen(true)}>
                  Trocar API
                </button>
              </div>
            </div>
          )}

          {message && (
            <div className="banner" onClick={() => setMessage(null)}>
              {message}
            </div>
          )}

          <main className={`content ${showReader && readerMode === 'paged' ? 'no-scroll' : ''}`}>
            {view === 'home' && (
              <div className="home">
                <h1>Traduza capítulos de mangá com IA</h1>
                <p className="subtitle">
                  Envie o PDF do capítulo ou o link dele num site. Cada página é lida pela IA, o texto é traduzido e escrito por cima do original.
                </p>
                {settings && !configured && (
                  <div className="warning">
                    Configure sua chave de API e o modelo antes de começar.{' '}
                    <button className="link" onClick={() => setSettingsOpen(true)}>
                      Abrir configurações
                    </button>
                  </div>
                )}
                <DropZone onFile={openFile} disabled={!settings} />
                <WebLinkInput onFile={openFile} disabled={!settings} />

                <h2 className="section-title">Biblioteca</h2>
                <LibraryView
                  entries={library}
                  works={works}
                  onOpen={openFromLibrary}
                  onDownload={downloadEntry}
                  onDelete={deleteEntry}
                  onWorksChanged={refreshLibrary}
                />
              </div>
            )}

            {view === 'setup' && file && settings && setupInfo && (
              <SetupView
                fileName={file.name}
                numPages={setupInfo.numPages}
                cover={setupInfo.cover}
                settings={settings}
                onStart={startTranslation}
                onCancel={goHome}
                onProfileChange={(activeProfileId) => saveSettingsPatch({ activeProfileId })}
                onOpenSettings={() => setSettingsOpen(true)}
              />
            )}
            {view === 'setup' && !setupInfo && <div className="reader-loading center">Abrindo PDF…</div>}

            {view === 'processing' && processingTab === 'grid' && (
              <ProgressView pages={pages} onRetry={stopping ? undefined : (page) => retryPages([page])} />
            )}

            {showReader && readerPages.length > 0 && <Reader pages={readerPages} mode={readerMode} zoom={zoom} />}
            {showReader && readerPages.length === 0 && <div className="reader-loading center">Carregando…</div>}
          </main>
        </>
      )}

      {settingsOpen && settings && (
        <SettingsDialog initial={settings} onClose={() => setSettingsOpen(false)} onSaved={setSettings} />
      )}
      {adminOpen && <AdminDashboard onClose={() => setAdminOpen(false)} />}
      {aiMonitorOpen && <AiMonitor onClose={() => setAiMonitorOpen(false)} />}
    </div>
  )
}

function mostCommonError(pages: PageState[]): { error: AppError; kinds: number } | null {
  const counts = new Map<string, { error: AppError; count: number }>()
  for (const page of pages) {
    if (page.status !== 'error' || !page.error) continue
    const entry = counts.get(page.error.message)
    if (entry) entry.count++
    else counts.set(page.error.message, { error: page.error, count: 1 })
  }
  const top = [...counts.values()].sort((a, b) => b.count - a.count)[0]
  return top ? { error: top.error, kinds: counts.size } : null
}

function translatedName(name: string): string {
  return `${name.replace(/\.pdf$/i, '').replace(/_traduzido$/, '')}_traduzido.pdf`
}
