import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppError } from '../../shared/errors'
import { activeProfile, isDownloaded, profileReady, type AppSettings, type LibraryEntry, type PublicSettings, type ReaderMode } from '../../shared/types'
import type { ReadingRecord } from '../../shared/reading'
import type { RemoteJob, RemoteQueue } from '../../shared/remoteJobs'
import type { UpdatesStatus, WorkUpdate } from '../../shared/updates'
import { displayName, type Work } from '../../shared/works'
import { DropZone } from './components/DropZone'
import { HomeFeed, LibraryView, useLibrary, WorkPage } from './components/LibraryView'
import { Sidebar, type Page } from './components/Sidebar'
import { ProgressView, statusText } from './components/ProgressView'
import { Reader, type ReaderPage } from './components/Reader'
import { SettingsDialog } from './components/SettingsDialog'
import { SetupView, type SetupChoice } from './components/SetupView'
import { AiMonitor } from './components/AiMonitor'
import { PhoneDialog } from './components/PhoneDialog'
import { BatchDialog } from './components/BatchDialog'
import { runPhased } from './lib/gpuSharing'
import { WebLinkInput } from './components/WebLinkInput'
import { canvasToBlob, renderPage, thumbnailCanvas } from './lib/pdf'
import { cleanIpcError, TranslationJob, type PageState } from './lib/pipeline'
import { usePdfPages } from './lib/usePdfPages'
import { webChapterToPdf } from './lib/webChapter'

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
  const [reading, setReading] = useState<ReadingRecord[]>([])
  const [updates, setUpdates] = useState<UpdatesStatus | null>(null)
  const [aiMonitorOpen, setAiMonitorOpen] = useState(false)
  const [phoneOpen, setPhoneOpen] = useState(false)
  const [remoteJob, setRemoteJob] = useState<RemoteJob | null>(null)
  const [queue, setQueue] = useState<RemoteQueue | null>(null)
  const [batchOpen, setBatchOpen] = useState(false)
  /** Reading with nothing around the pages (the window full screen too). */
  const [immersive, setImmersive] = useState(false)
  /** Where the home view is: the first page, the library, or a work's page. */
  const [page, setPage] = useState<Page>({ kind: 'home' })
  const job = useRef<TranslationJob | null>(null)
  const fileRef = useRef<LoadedFile | null>(null)
  /** A phone's request is being worked on (the state above only shows it). */
  const remoteBusy = useRef(false)
  /** Counts the requests finished, so the next one is taken (a download leaves the home screen as it was). */
  const [remoteFinished, setRemoteFinished] = useState(0)
  /** The library chapter the last finished translation was saved as. */
  const savedEntry = useRef<string | null>(null)

  useEffect(() => {
    window.api.getSettings().then(setSettings)
    refreshLibrary()
    window.api.updates.status().then(setUpdates)
    window.api.remote.queue().then(setQueue)
    const stopQueue = window.api.remote.onChanged(() => window.api.remote.queue().then(setQueue))
    const stopUpdates = window.api.updates.onChanged(() => window.api.updates.status().then(setUpdates))
    // Chapters read in the browser arrive while the app is open (and may bring new works).
    const stopReading = window.api.reading.onChanged(refreshLibrary)
    return () => {
      stopQueue()
      stopUpdates()
      stopReading()
    }
  }, [])

  // Listing the chapters indexes old ones into works, so works are read after it.
  const refreshLibrary = async () => {
    setLibrary(await window.api.library.list())
    setWorks(await window.api.works.list())
    setReading(await window.api.reading.list())
  }

  const profile = settings ? activeProfile(settings) : undefined
  const configured = !!settings && profileReady(profile, settings.hasKey)

  // Chapters the phone asked for are translated one at a time, whenever this window is free (on the
  // home screen, nothing else open).
  useEffect(() => {
    if (view !== 'home' || !configured || !settings) return
    let left = false
    const check = async () => {
      if (left || remoteBusy.current) return
      remoteBusy.current = true
      const next = await window.api.remote.take()
      if (!next) {
        remoteBusy.current = false
      } else if (left) {
        remoteBusy.current = false
        await window.api.remote.update(next.job.id, { status: 'queued', message: undefined })
      } else {
        void runRemote(next.job, next.pdf, settings)
      }
    }
    void check()
    const stop = window.api.remote.onChanged(check)
    return () => {
      left = true
      stop()
    }
  }, [view, configured, settings, remoteFinished])
  const readerMode: ReaderMode = settings?.readerMode ?? 'scroll'

  // Pausing the queue stops the chapter it is on (runRemote puts it back in the queue). The local AIs
  // are stopped at once too: the page they are on would otherwise run to its end, holding the GPU.
  useEffect(() => {
    if (!queue?.paused || !remoteBusy.current) return
    void window.api.web.cancel()
    job.current?.cancel()
    void Promise.all([window.api.ai.stop('ollama-models'), window.api.ai.stop('vision')]).catch(() => undefined)
  }, [queue?.paused])

  const inResult = view === 'result' && !!reader
  // A library chapter opens where it was left, or at its start once it was read to the end.
  const resumeAt = (() => {
    const entry = view === 'result' ? library.find((e) => e.id === reader?.libraryId) : undefined
    if (!entry) return 0
    const record = reading.find((r) => r.workId === entry.workId && r.chapter === entry.chapter)
    return record?.status === 'read' ? 0 : savedPage(entry.id)
  })()
  const pdfPages = usePdfPages(inResult && !showOriginal && !reader.fromJob ? reader.translated : null, resumeAt)
  const originalPages = usePdfPages(inResult && showOriginal ? reader.original : null, resumeAt)
  const jobPages: ReaderPage[] = pages.map((p) => ({
    key: `job-${p.number}`,
    number: p.number,
    url: p.imageUrl,
    aspect: p.aspect,
    tall: p.tall,
    status: statusText(p)
  }))
  const readerPages = view === 'processing' ? jobPages : showOriginal ? originalPages : reader?.fromJob ? jobPages : pdfPages

  /** Opens the chapter for setup; false (with the reason shown) when it could not be opened. */
  async function openFile(selected: File, source?: string): Promise<boolean> {
    if (!settings || !configured) {
      setSettingsOpen(true)
      return false
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
      return true
    } catch (err) {
      setMessage(`Não foi possível abrir o PDF: ${cleanIpcError(err)}`)
      setView('home')
      return false
    }
  }

  /**
   * Translates a chapter the phone asked for, the way it would be done by hand: open, translate
   * every page with the saved settings, save to the library. Pages that failed are left as they are.
   */
  async function runRemote(remote: RemoteJob, pdf: Uint8Array | null, current: PublicSettings) {
    setRemoteJob(remote)
    const update = (patch: Parameters<typeof window.api.remote.update>[1]) => window.api.remote.update(remote.id, patch)
    savedEntry.current = null
    try {
      if (remote.batch?.download) {
        await downloadOnly(remote)
        return
      }
      let selected: File
      if (remote.kind === 'link') {
        await update({ message: 'Abrindo o site' })
        const chapter = await window.api.web.chapter(remote.url!)
        // A range's chapters are named for the work they were asked for, so they land in it.
        const name = remote.batch ? remote.name : chapter.title
        selected = new File([(await webChapterToPdf(chapter)) as BlobPart], `${name}.pdf`, { type: 'application/pdf' })
      } else {
        selected = new File([pdf as BlobPart], remote.name, { type: 'application/pdf' })
      }
      await update({ message: 'Traduzindo' })
      if (!(await openFile(selected, remote.url))) throw new Error('Não foi possível abrir o PDF.')
      await startTranslation(defaultChoice(job.current!.numPages, current))
      if ((await window.api.remote.queue()).paused) throw new Paused()
      if (!savedEntry.current && job.current && job.current.translatedCount > 0) await finish()
      if (!savedEntry.current) throw new Error(job.current?.stopReason?.message ?? 'Nenhuma página foi traduzida.')
      await update({ status: 'done', message: undefined, entryId: savedEntry.current })
      goHome()
      setMessage(`${remote.batch ? 'Traduzido' : 'Pedido do celular traduzido'} e salvo na biblioteca: ${selected.name.replace(/\.pdf$/i, '')}`)
    } catch (err) {
      if (err instanceof Paused || (await window.api.remote.queue()).paused) {
        // Back to the queue, to start over when resumed; the local AIs leave the GPU meanwhile.
        await update({ status: 'queued', message: undefined })
        await Promise.all([window.api.ai.stop('ollama-models'), window.api.ai.stop('vision')]).catch(() => undefined)
      } else {
        await update({ status: 'failed', message: cleanIpcError(err) })
      }
      goHome()
    } finally {
      remoteBusy.current = false
      setRemoteJob(null)
      setRemoteFinished((n) => n + 1)
    }
  }

  /** A chapter of a range asked only to be downloaded: saved to the library as it is, to read offline. */
  async function downloadOnly(remote: RemoteJob) {
    await window.api.remote.update(remote.id, { message: 'Baixando' })
    const chapter = await window.api.web.chapter(remote.url!)
    if ((await window.api.remote.queue()).paused) throw new Paused()
    // The cover first: making the PDF hands the images over.
    const first = await createImageBitmap(new Blob([chapter.images[0] as BlobPart]))
    const canvas = document.createElement('canvas')
    canvas.width = first.width
    canvas.height = Math.min(first.height, Math.round(first.width * 1.5))
    canvas.getContext('2d')!.drawImage(first, 0, 0)
    const cover = new Uint8Array(await (await canvasToBlob(thumbnailCanvas(canvas, 480), 'image/jpeg', 0.85)).arrayBuffer())
    const pdf = await webChapterToPdf(chapter)
    const entry = await window.api.library.save({
      fileName: `${remote.name}.pdf`,
      source: remote.url,
      pageCount: chapter.images.length,
      translatedPages: chapter.images.length,
      original: pdf,
      translated: pdf,
      coverJpeg: cover,
      downloaded: true
    })
    await window.api.remote.update(remote.id, { status: 'done', message: undefined, entryId: entry.id })
    await refreshLibrary()
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
    savedEntry.current = entry.id
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
    let translated: Uint8Array
    try {
      translated = await window.api.library.pdf(entry.id, 'translated')
    } catch (err) {
      setMessage(`Não foi possível abrir "${entry.title}": ${cleanIpcError(err)}`)
      return
    }
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
  const libraryData = useLibrary(library, works, reading, updates)
  const shownWork = page.kind === 'work' ? libraryData.groups.find((g) => g.work.id === page.id) : undefined

  function goTo(next: Page) {
    setPage(next)
    document.querySelector('main.content')?.scrollTo(0, 0)
  }

  // The library chapter open, and the ones before and after it in its work.
  const openEntry = view === 'result' && reader?.libraryId ? library.find((e) => e.id === reader.libraryId) : undefined
  const { prev: prevEntry, next: nextEntry } = neighbours(library, openEntry)
  const openWork = openEntry ? works.find((w) => w.id === openEntry.workId) : undefined
  const workUpdate = openEntry ? updates?.updates[openEntry.workId] : undefined

  // Where each library chapter was left, to open it there again; how far it got goes to the reading list.
  const progressTimer = useRef<number | null>(null)
  const onReaderPage = useCallback(
    (index: number, progress: number) => {
      const id = reader?.libraryId
      if (!id || view !== 'result') return
      try {
        localStorage.setItem(`reader-page:${id}`, String(index))
      } catch {
        // Storage full or blocked: the chapter opens at its start next time.
      }
      if (progressTimer.current) window.clearTimeout(progressTimer.current)
      progressTimer.current = window.setTimeout(() => void window.api.reading.progress(id, progress), 1_500)
    },
    [reader?.libraryId, view]
  )

  function openWorkPage() {
    if (!openEntry) return
    goHome()
    goTo({ kind: 'work', id: openEntry.workId })
  }

  // Shortcuts while reading: N and P for the next and previous chapters, F for full screen.
  useEffect(() => {
    if (view !== 'result') return
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.ctrlKey || e.altKey || e.metaKey) return
      const key = e.key.toLowerCase()
      if (key === 'n' && nextEntry) void openFromLibrary(nextEntry)
      else if (key === 'p' && prevEntry) void openFromLibrary(prevEntry)
      else if (key === 'f') setImmersive((on) => !on)
      else if (key === 'escape' && immersive) setImmersive(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [view, nextEntry, prevEntry, immersive])

  useEffect(() => {
    if (view !== 'result' && immersive) setImmersive(false)
  }, [view])
  // The window closed and hid: a chapter left open would keep the phone's requests waiting (they run
  // from the home screen).
  useEffect(
    () =>
      window.api.background.onHidden(() => {
        if (view === 'result' || (view === 'setup' && !running)) goHome()
      }),
    [view, running]
  )
  // Freeing the GPU from the icon by the clock: the queue's chapter is stopped by the pause above; one
  // started here is cancelled.
  useEffect(
    () =>
      window.api.background.onFreeGpu(() => {
        if (remoteBusy.current) return
        void window.api.web.cancel()
        job.current?.cancel()
      }),
    []
  )
  useEffect(() => {
    if (immersive && !document.fullscreenElement) void document.documentElement.requestFullscreen().catch(() => undefined)
    if (!immersive && document.fullscreenElement) void document.exitFullscreen().catch(() => undefined)
  }, [immersive])
  useEffect(() => {
    const onChange = () => !document.fullscreenElement && setImmersive(false)
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  return (
    <div className={`app ${view === 'home' ? 'with-sidebar' : ''} ${immersive ? 'immersive' : ''}`}>
      {view === 'home' && (
        <Sidebar
          page={page}
          fresh={libraryData.fresh.size}
          onPage={goTo}
          onBatch={() => setBatchOpen(true)}
          onPhone={() => setPhoneOpen(true)}
          onAi={() => setAiMonitorOpen(true)}
          onSettings={() => setSettingsOpen(true)}
        />
      )}
      <div className="main-col">
      {view !== 'home' && (
      <header className="topbar">
        <div className="brand">
          <span className="logo">漫</span>
          {openEntry ? (
            // A library chapter: its work, and the chapters around it.
            <div className="chapter-nav">
              <button className="secondary small" onClick={openWorkPage} title="A página da obra">
                {openWork ? displayName(openWork.names[0]) : 'Obra'}
              </button>
              <button className="secondary small" disabled={!prevEntry} onClick={() => prevEntry && openFromLibrary(prevEntry)} title="Capítulo anterior (P)">
                ‹ {prevEntry ? `Cap. ${prevEntry.chapter}` : 'Anterior'}
              </button>
              <span className="chapter-nav-now">Cap. {openEntry.chapter ?? '?'}</span>
              <button className="secondary small" disabled={!nextEntry} onClick={() => nextEntry && openFromLibrary(nextEntry)} title="Próximo capítulo (N)">
                {nextEntry ? `Cap. ${nextEntry.chapter}` : 'Próximo'} ›
              </button>
            </div>
          ) : (
            <>
              <span>Manga Index</span>
              {title && <span className="file-name">· {title}</span>}
            </>
          )}
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
          {view === 'result' && reader && !(openEntry && isDownloaded(openEntry)) && (
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
              {view === 'result' && (
                <button className="icon" title="Tela cheia (F; Esc para sair)" onClick={() => setImmersive(true)}>
                  ⛶
                </button>
              )}
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
              {reader.translated && <button className="secondary" title="Salvar o PDF do capítulo" onClick={() => download(reader.translated!, reader.title)}>⬇ PDF</button>}
            </>
          )}
          <button className="secondary" onClick={goHome} disabled={running}>
            Início
          </button>
          <button className="icon" title="Configurações" onClick={() => setSettingsOpen(true)}>
            ⚙
          </button>
        </div>
      </header>
      )}

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

          {queue && <BatchBar queue={queue} running={remoteJob} />}

          {message && (
            <div className="banner" onClick={() => setMessage(null)}>
              {message}
            </div>
          )}

          <main className={`content ${showReader && readerMode === 'paged' ? 'no-scroll' : ''}`}>
            {view === 'home' && remoteJob && !remoteJob.batch && (
              <div className="banner remote-banner">
                📱 Pedido do celular: {remoteJob.kind === 'link' ? remoteJob.url : remoteJob.name} — abrindo…
              </div>
            )}
            {view === 'home' && page.kind === 'home' && (
              <HomeFeed data={libraryData} updates={updates} onPick={(id) => goTo({ kind: 'work', id })} onOpen={openFromLibrary}>
              <div className="translate-box">
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
                <div className="batch-open">
                  <button className="secondary" onClick={() => setBatchOpen(true)} disabled={!settings}>
                    Traduzir vários capítulos de uma obra
                  </button>
                </div>
              </div>
              </HomeFeed>
            )}
            {view === 'home' && page.kind === 'library' && (
              <LibraryView data={libraryData} updates={updates} onPick={(id) => goTo({ kind: 'work', id })} onWorksChanged={refreshLibrary} />
            )}
            {view === 'home' && page.kind === 'work' && shownWork && (
              <WorkPage
                key={shownWork.work.id}
                group={shownWork}
                data={libraryData}
                updates={updates}
                others={libraryData.groups.map((g) => g.work).filter((w) => w.id !== shownWork.work.id)}
                onBack={() => goTo({ kind: 'library' })}
                onOpen={openFromLibrary}
                onDownload={downloadEntry}
                onDelete={deleteEntry}
                onWorksChanged={refreshLibrary}
              />
            )}
            {view === 'home' && page.kind === 'work' && !shownWork && (
              <p className="hint center">Essa obra não está mais na biblioteca (foi juntada com outra?).</p>
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

            {showReader && readerPages.length > 0 && (
              <Reader
                key={`${reader?.libraryId ?? 'job'}-${showOriginal}`}
                pages={readerPages}
                mode={readerMode}
                zoom={zoom}
                startPage={resumeAt}
                onPage={onReaderPage}
                // A library chapter read to its last page counts as read.
                onEnd={
                  view === 'result' && reader?.libraryId
                    ? () => {
                        if (progressTimer.current) window.clearTimeout(progressTimer.current)
                        void window.api.reading.finished(reader.libraryId!)
                      }
                    : undefined
                }
                footer={
                  openEntry && (
                    <ChapterEnd
                      entry={openEntry}
                      next={nextEntry}
                      update={workUpdate}
                      immersive={immersive}
                      onNext={() => nextEntry && openFromLibrary(nextEntry)}
                      onWork={openWorkPage}
                      onLeaveFullScreen={() => setImmersive(false)}
                    />
                  )
                }
              />
            )}
            {showReader && immersive && (
              <button className="immersive-exit" onClick={() => setImmersive(false)} title="Sair da tela cheia (Esc)">
                ✕
              </button>
            )}
            {showReader && readerPages.length === 0 && <div className="reader-loading center">Carregando…</div>}
          </main>
      </div>

      {settingsOpen && settings && (
        <SettingsDialog initial={settings} onClose={() => setSettingsOpen(false)} onSaved={setSettings} />
      )}
      {aiMonitorOpen && <AiMonitor onClose={() => setAiMonitorOpen(false)} />}
      {batchOpen && <BatchDialog works={works} reading={reading} onClose={() => setBatchOpen(false)} />}
      {phoneOpen && <PhoneDialog onClose={() => setPhoneOpen(false)} />}
    </div>
  )
}

/** The page (an index) a library chapter was left at; 0 when it was not opened yet. */
function savedPage(entryId: string | undefined): number {
  if (!entryId) return 0
  try {
    return Number(localStorage.getItem(`reader-page:${entryId}`)) || 0
  } catch {
    return 0
  }
}

/** The chapters before and after `entry` in its work, by number (a chapter translated twice counts once). */
function neighbours(library: LibraryEntry[], entry: LibraryEntry | undefined): { prev?: LibraryEntry; next?: LibraryEntry } {
  if (!entry || entry.chapter === null) return {}
  const chapter = entry.chapter
  const same = library.filter((e) => e.workId === entry.workId && e.chapter !== null && e.id !== entry.id)
  const newest = (a: LibraryEntry, b: LibraryEntry) => b.createdAt - a.createdAt
  const after = same.filter((e) => e.chapter! > chapter).sort((a, b) => a.chapter! - b.chapter! || newest(a, b))
  const before = same.filter((e) => e.chapter! < chapter).sort((a, b) => b.chapter! - a.chapter! || newest(a, b))
  return { prev: before[0], next: after[0] }
}

/** After the last page: the next chapter, or where to find it. */
function ChapterEnd({
  entry,
  next,
  update,
  immersive,
  onNext,
  onWork,
  onLeaveFullScreen
}: {
  entry: LibraryEntry
  next?: LibraryEntry
  update?: WorkUpdate
  immersive: boolean
  onNext: () => void
  onWork: () => void
  onLeaveFullScreen: () => void
}) {
  const onSite = !next && update && entry.chapter !== null && update.latest > entry.chapter ? update : null
  return (
    <div className="chapter-end">
      <span className="mono accent-label">FIM DO CAPÍTULO {entry.chapter}</span>
      {next ? (
        <button className="chapter-end-next" onClick={onNext}>
          Próximo: Capítulo {next.chapter} ›
        </button>
      ) : onSite ? (
        <>
          <p className="hint">
            Este é o último capítulo na biblioteca. O site já tem até o {onSite.latest} ({onSite.site}).
          </p>
          <button className="chapter-end-next" onClick={() => (immersive && onLeaveFullScreen(), window.open(onSite.url))}>
            Ler o capítulo {onSite.latest} no site ↗
          </button>
        </>
      ) : (
        <p className="hint">Este é o último capítulo na biblioteca.</p>
      )}
      <button className="secondary" onClick={onWork}>
        Ver a obra
      </button>
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

/** Every page, the first and last ones as the settings say (credit pages) left untranslated. */
function defaultChoice(numPages: number, s: AppSettings): SetupChoice {
  const skipStart = Math.min(s.skipStart, numPages - 1)
  const skipEnd = Math.min(s.skipEnd, numPages - 1 - skipStart)
  const pages = Array.from({ length: numPages }, (_, i) => i + 1)
  return {
    pages,
    untranslated: pages.filter((n) => n <= skipStart || n > numPages - skipEnd),
    options: {
      sourceLanguage: s.sourceLanguage,
      targetLanguage: s.targetLanguage,
      concurrency: s.concurrency,
      speed: s.speed,
      translateSfx: s.translateSfx,
      skipStart,
      skipEnd,
      gpuSharing: s.gpuSharing
    }
  }
}

/** Thrown when the queue was paused mid-chapter: the chapter goes back to the queue. */
class Paused extends Error {}

/**
 * The ranges of chapters being translated: which one now, how many wait, and pausing (the chapter
 * running goes back to the queue and the GPU is freed) or dropping the rest.
 */
function BatchBar({ queue, running }: { queue: RemoteQueue; running: RemoteJob | null }) {
  const waiting = queue.jobs.filter((j) => j.batch && j.status === 'queued')
  const failed = queue.jobs.filter((j) => j.batch && j.status === 'failed' && Date.now() - j.updatedAt < 86_400_000)
  const now = running?.batch ? running : null
  if (!now && !waiting.length) return null
  return (
    <div className={`banner batch-bar ${queue.paused ? 'paused' : ''}`}>
      <span>
        {queue.paused
          ? `⏸ Lote pausado: ${waiting.length} ${waiting.length === 1 ? 'capítulo' : 'capítulos'} na fila`
          : now
            ? `📚 ${now.batch?.download ? 'Baixando' : 'Traduzindo'} ${now.name} · mais ${waiting.length} na fila`
            : `📚 ${waiting.length} na fila: começa assim que o app estiver livre na tela inicial`}
        {failed.length > 0 && ` · ${failed.length} falharam: ${failed.map((f) => f.batch!.chapter).join(', ')}`}
      </span>
      <span className="batch-bar-buttons">
        <button className="small" onClick={() => window.api.remote.pause(!queue.paused)}>
          {queue.paused ? 'Continuar' : 'Pausar'}
        </button>
        <button
          className="secondary small"
          onClick={() => {
            if (confirm(`Tirar da fila os ${waiting.length} capítulos que faltam?`)) void window.api.remote.clearBatch()
          }}
        >
          Cancelar o resto
        </button>
      </span>
    </div>
  )
}
