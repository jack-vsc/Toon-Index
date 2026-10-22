import React, { useEffect, useRef, useState } from 'react'
import { ImageLightbox } from './ImageLightbox'

function runBtnStyle(bg: string): React.CSSProperties {
  return {
    padding: '4px 8px',
    borderRadius: 4,
    border: 'none',
    background: bg,
    color: '#fff',
    cursor: 'pointer',
    fontSize: 11,
    fontWeight: 600,
  }
}

export function AdminDashboard({ onClose }: { onClose: () => void }) {
  const [runs, setRuns] = useState<string[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [artifacts, setArtifacts] = useState<string[]>([])
  const [imageData, setImageData] = useState<string | null>(null)
  const [lightboxOpen, setLightboxOpen] = useState(false)
  const [lightboxTitle, setLightboxTitle] = useState<string | undefined>()
  const [autoScroll, setAutoScroll] = useState(false)
  const logRef = useRef<HTMLPreElement>(null)
  const thumbCache = useRef<Record<string, string | null>>({})
  const [log, setLog] = useState<string>('')
  const [status, setStatus] = useState<any>(null)
  const [activeRuns, setActiveRuns] = useState<string[]>([])
  const [metrics, setMetrics] = useState<any | null>(null)
  const [pythonExe, setPythonExe] = useState(localStorage.getItem('trainPythonExe') || 'python')
  const [script, setScript] = useState(localStorage.getItem('trainScript') || 'scripts/train_yolo.py')
  const [args, setArgs] = useState(localStorage.getItem('trainArgs') || '')
  const [checkpoints, setCheckpoints] = useState<Record<string, boolean>>({})
  const [artifactStamp, setArtifactStamp] = useState('')
  const [runCopyArgs, setRunCopyArgs] = useState<string | null>(null)
  const [runCopyFull, setRunCopyFull] = useState<string | null>(null)
  const lastLogLen = useRef(0)

  useEffect(() => {
    localStorage.setItem('trainPythonExe', pythonExe);
  }, [pythonExe]);

  useEffect(() => {
    localStorage.setItem('trainScript', script);
  }, [script]);

  useEffect(() => {
    localStorage.setItem('trainArgs', args);
  }, [args]);

  async function refreshAll() {
    await refreshRuns()
    await refreshStatus()
  }

  async function refreshRuns() {
    try {
      const r: string[] = await window.api.train.listRuns()
      setRuns(r)
      if (!selected && r.length > 0) setSelected(r[r.length - 1])
      const ck: Record<string, boolean> = {}
      await Promise.all(
        r.map(async (id) => {
          ck[id] = await window.api.train.hasCheckpoint(id)
        })
      )
      setCheckpoints(ck)
    } catch (err) {
      console.error(err)
    }
  }

  async function refreshActive() {
    try {
      const s = await window.api.train.status()
      setActiveRuns(s.active ?? [])
    } catch (err) {
      console.error(err)
    }
  }

  async function refreshRunCopyPayload(run: string) {
    try {
      const p = await window.api.train.getCopyPayload(run)
      setRunCopyArgs(p.argsLine)
      setRunCopyFull(p.fullCommand)
    } catch (err) {
      console.error('refreshRunCopyPayload error', err)
      setRunCopyArgs(null)
      setRunCopyFull(null)
    }
  }

  async function refreshArtifacts(run?: string) {
    const r = run ?? selected
    if (!r) return
    try {
      const a: string[] = await window.api.train.listArtifacts(r)
      setArtifacts((prev) => (prev.length === a.length && prev.every((x, i) => x === a[i]) ? prev : a))
      const stamp = await window.api.train.getArtifactStamp(r)
      setArtifactStamp((prev) => {
        if (prev === stamp) return prev
        for (const key of Object.keys(thumbCache.current)) {
          if (key.startsWith(`${r}/`)) delete thumbCache.current[key]
        }
        return stamp
      })
    } catch (err) {
      console.error('refreshArtifacts error', err)
    }
  }

  async function copyRunArgs(which: 'args' | 'full') {
    const text = which === 'full' ? runCopyFull : runCopyArgs
    if (!text) {
      alert('Args não encontrados (args.yaml ou train.log ausente).')
      return
    }
    try {
      await navigator.clipboard.writeText(text)
      alert(which === 'full' ? 'Comando completo copiado.' : 'Args copiados para o campo de treino.')
      if (which === 'args') setArgs(text)
    } catch {
      alert('Não foi possível copiar para a área de transferência.')
    }
  }

  async function openArtifactViewer(name: string) {
    if (!selected) return
    setLightboxTitle(name)
    setLightboxOpen(true)
    setImageData(null)
    try {
      const data = await window.api.train.getArtifact(selected, name)
      setImageData(data)
    } catch (err) {
      console.error('openArtifactViewer error', err)
      setLightboxOpen(false)
      alert(`Não foi possível abrir ${name}`)
    }
  }

  async function refreshLog(run: string) {
    try {
      const txt: string = await window.api.train.tailLog(run, 400)
      if (txt.length !== lastLogLen.current || txt !== log) {
        lastLogLen.current = txt.length
        setLog(txt)
      }
    } catch (err) {
      console.error('refreshLog error', err)
    }
  }

  async function refreshMetrics(run: string) {
    try {
      const m = await window.api.train.getMetrics(run)
      setMetrics(m)
    } catch (err) {
      console.error('refreshMetrics error', err)
    }
  }

  async function refreshStatus() {
    try {
      const s = await window.api.train.status()
      setStatus(s)
      setActiveRuns(s.active ?? [])
    } catch (err) {
      console.error('refreshStatus error', err)
    }
  }

  function buildNewMarathonArgs(): string[] {
    const trimmed = args.trim()
    if (trimmed) {
      return trimmed.split(/\s+/).filter(Boolean)
    }
    return [
      '--preset',
      'marathon',
      '--data',
      'models/yolo_dataset/data.yaml',
      '--name',
      `genio-${Date.now()}`,
      '--exist-ok',
    ]
  }

  async function handleStart() {
    const argArray = buildNewMarathonArgs()
    const res = await window.api.train.start(pythonExe, script, argArray)
    if (!res.ok) alert(`Erro: ${res.error}`)
    else {
      if (res.runId) setSelected(res.runId)
      await refreshStatus()
      setTimeout(refreshAll, 1500)
    }
  }

  async function handleStopRun(runId: string) {
    const ok = await window.api.train.stop(runId)
    if (!ok) alert('Não foi possível parar (run externa ou já encerrada).')
    await refreshStatus()
  }

  async function handleContinueTraining(runId: string) {
    setSelected(runId)
    const res = await window.api.train.resumeRun(pythonExe, script, runId)
    if (!res.ok) alert(`Erro: ${res.error}`)
    else {
      await refreshStatus()
      setTimeout(refreshAll, 1500)
    }
  }

  async function handlePauseProcess(runId: string) {
    const ok = await window.api.train.suspend(runId)
    if (!ok) alert('Erro ao pausar o processo.')
    else await refreshStatus()
  }

  async function handleResumeProcess(runId: string) {
    const ok = await window.api.train.resume(runId)
    if (!ok) alert('Erro ao retomar o processo.')
    else await refreshStatus()
  }

  useEffect(() => {
    refreshAll()
    if (selected) {
      lastLogLen.current = 0
      refreshArtifacts(selected)
      refreshLog(selected)
      refreshMetrics(selected)
      refreshRunCopyPayload(selected)
    } else {
      setRunCopyArgs(null)
      setRunCopyFull(null)
    }

    const unsubLog = window.api.train.onLog((runId, text) => {
      if (runId === selected) setLog(text)
    })
    const unsubStatus = window.api.train.onStatus((s) => {
      setStatus(s)
      if (!s.running && s.error) {
        alert(`Erro de Treinamento (${s.runId || 'Desconhecido'}):\n${s.error}`)
      }
      refreshActive()
    })
    const unsubArts = window.api.train.onArtifacts((runId, arts) => {
      if (runId === selected) setArtifacts(arts)
    })
    const unsubMetrics = window.api.train.onMetrics((runId, m) => {
      if (runId === selected) setMetrics(m)
    })

    const tick = async () => {
      refreshRuns()
      try {
        const s = await window.api.train.status()
        setStatus(s)
        setActiveRuns(s.active ?? [])
        if (!selected) return
        refreshLog(selected)
        if ((s.active ?? []).includes(selected)) {
          refreshArtifacts(selected)
          refreshMetrics(selected)
        }
      } catch {
        // ignore
      }
    }
    const iv = setInterval(() => {
      void tick()
    }, 3000)

    return () => {
      clearInterval(iv)
      unsubLog?.()
      unsubStatus?.()
      unsubArts?.()
      unsubMetrics?.()
    }
  }, [selected])

  function AsyncThumb({ run, name, stamp }: { run: string; name: string; stamp: string }) {
    const key = `${run}/${name}@${stamp}`
    const [src, setSrc] = React.useState<string | null>(null)
    const [error, setError] = React.useState(false)
    useEffect(() => {
      const cached = thumbCache.current[key]
      if (cached) {
        setSrc(cached)
        return
      }
      let mounted = true
      setError(false)
      setSrc(null)
      window.api.train.getThumb(run, name, 240, 160).then((t) => {
        if (!mounted) return
        if (t) {
          thumbCache.current[key] = t
          setSrc(t)
        } else {
          setError(true)
        }
      }).catch(() => {
        if (mounted) setError(true)
      })
      return () => {
        mounted = false
      }
    }, [run, name, stamp, key])
    if (error) return <div style={{ width: '100%', height: 90, background: '#1a1a1a', color: '#888', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11 }}>Erro ao carregar</div>
    if (!src) return <div style={{ width: '100%', height: 90, background: '#15171a' }} />
    return <img src={src} style={{ width: '100%', height: 90, objectFit: 'cover' }} />
  }

  useEffect(() => {
    if (autoScroll && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight
    }
  }, [log, autoScroll])

  const externalActive: string[] = status?.externalActive ?? []
  const isExternalSelected = selected ? externalActive.includes(selected) : false
  const isLiveSelected = selected ? activeRuns.includes(selected) : false
  const runFinished =
    !!log &&
    (/EarlyStopping/i.test(log) || /epochs completed/i.test(log) || /Results saved to/i.test(log))

  return (
    <>
      <style>{`
        .admin-dashboard-page *::-webkit-scrollbar {
          display: none;
        }
        .admin-dashboard-page * {
          -ms-overflow-style: none;
          scrollbar-width: none;
        }
      `}</style>
      <div
        className="admin-dashboard-page"
        style={{
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        height: '100%',
        background: '#0f1113',
        color: '#ddd',
        padding: 12,
        boxSizing: 'border-box'
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>Admin - Treino</h2>
        <div>
          <button className="icon" onClick={onClose} style={{ marginLeft: 8 }}>
            ✕
          </button>
        </div>
      </div>
      <div
        className="grid"
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
          gap: 12,
          alignItems: 'stretch',
          width: '100%',
          flex: 1,
          overflow: 'hidden'
        }}
      >
        <div className="col" style={{ overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <div style={{ overflowY: 'auto', flex: 1, paddingRight: 8 }}>
            <h3>Runs</h3>
            <button onClick={refreshRuns}>Atualizar</button>
            <ul style={{ listStyle: 'none', padding: 0, margin: '8px 0', border: '1px solid #333', borderRadius: 4, maxHeight: 280, overflowY: 'auto' }}>
              {[...runs].reverse().map((r) => {
                const live = activeRuns.includes(r)
                const external = externalActive.includes(r)
                const managed = live && !external
                const paused = status?.paused?.includes(r)
                const canContinue = checkpoints[r] && !live
                return (
                  <li
                    key={r}
                    onClick={() => setSelected(r)}
                    style={{
                      padding: '8px 10px',
                      borderBottom: '1px solid #222',
                      cursor: 'pointer',
                      background: r === selected ? '#333' : 'transparent',
                      color: r === selected ? '#fff' : '#ddd',
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = r === selected ? '#333' : '#222')}
                    onMouseLeave={(e) => (e.currentTarget.style.background = r === selected ? '#333' : 'transparent')}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 13, wordBreak: 'break-all' }}>{r}</span>
                      <span style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                        {live && (
                          <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, background: external ? '#5c6bc0' : '#4CAF50', color: '#fff' }}>
                            {external ? 'externo' : paused ? 'pausado' : 'ativo'}
                          </span>
                        )}
                      </span>
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }} onClick={(e) => e.stopPropagation()}>
                      {managed && live && !paused && (
                        <>
                          <button type="button" onClick={() => handlePauseProcess(r)} style={runBtnStyle('#ff9800')}>Pausar</button>
                          <button type="button" onClick={() => handleStopRun(r)} style={runBtnStyle('#6be3ff')}>Parar</button>
                        </>
                      )}
                      {managed && paused && (
                        <>
                          <button type="button" onClick={() => handleResumeProcess(r)} style={runBtnStyle('#4CAF50')}>Continuar</button>
                          <button type="button" onClick={() => handleStopRun(r)} style={runBtnStyle('#6be3ff')}>Parar</button>
                        </>
                      )}
                      {canContinue && (
                        <button type="button" onClick={() => handleContinueTraining(r)} style={runBtnStyle('#ff6b6b')}>
                          Continuar treino
                        </button>
                      )}
                    </div>
                  </li>
                )
              })}
            </ul>
            {selected && (
              <div style={{ marginTop: 12, padding: 10, border: '1px solid #333', borderRadius: 6, background: '#16181c' }}>
                <h4 style={{ margin: '0 0 8px 0' }}>Run: {selected}</h4>
                {isExternalSelected && (
                  <p style={{ margin: '0 0 8px 0', fontSize: 12, color: '#9aa5ce' }}>
                    Treino iniciado fora do app — log/artifacts atualizam aqui; Stop/Pause não controlam o processo.
                  </p>
                )}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  <button
                    type="button"
                    disabled={!runCopyArgs}
                    onClick={() => copyRunArgs('args')}
                    style={{ padding: '6px 10px', borderRadius: 4, border: 'none', background: '#444', color: '#fff', cursor: runCopyArgs ? 'pointer' : 'not-allowed' }}
                  >
                    Copiar args
                  </button>
                  <button
                    type="button"
                    disabled={!runCopyFull}
                    onClick={() => copyRunArgs('full')}
                    style={{ padding: '6px 10px', borderRadius: 4, border: 'none', background: '#555', color: '#fff', cursor: runCopyFull ? 'pointer' : 'not-allowed' }}
                  >
                    Copiar comando completo
                  </button>
                </div>
                {runCopyArgs && (
                  <pre style={{ marginTop: 8, fontSize: 11, color: '#aaa', whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 80, overflow: 'auto' }}>{runCopyArgs}</pre>
                )}
              </div>
            )}
            <h4>Status</h4>
            <pre style={{ background: '#1e1e1e', padding: 8, borderRadius: 4, border: '1px solid #444', maxHeight: 150, overflowY: 'auto' }}>{status ? JSON.stringify(status, null, 2) : '—'}</pre>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingBottom: 20 }}>
              <label style={{ fontSize: 12, color: '#aaa', marginTop: 8 }}>Python executable</label>
              <input value={pythonExe} onChange={(e) => setPythonExe(e.target.value)} style={{ padding: 8, borderRadius: 4, border: '1px solid #444', background: '#1e1e1e', color: '#eee' }} />
              <label style={{ fontSize: 12, color: '#aaa' }}>Script path</label>
              <input value={script} onChange={(e) => setScript(e.target.value)} style={{ padding: 8, borderRadius: 4, border: '1px solid #444', background: '#1e1e1e', color: '#eee' }} />
              <label style={{ fontSize: 12, color: '#aaa' }}>Args opcionais (vazio = marathon no dataset)</label>
              <input
                value={args}
                onChange={(e) => setArgs(e.target.value)}
                placeholder="--preset marathon --data models/yolo_dataset/data.yaml ..."
                style={{ padding: 8, borderRadius: 4, border: '1px solid #444', background: '#1e1e1e', color: '#eee' }}
              />
            </div>
          </div>
          <div style={{ paddingTop: 12, paddingBottom: 8 }}>
            <button
              onClick={handleStart}
              style={{
                padding: '12px 16px',
                borderRadius: 6,
                border: 'none',
                background: '#ff6b6b',
                color: '#fff',
                cursor: 'pointer',
                fontWeight: 'bold',
                width: '100%',
              }}
            >
              Iniciar novo treino
            </button>
            <p style={{ margin: '8px 0 0', fontSize: 11, color: '#888', lineHeight: 1.4 }}>
              Preset marathon: mesmo dataset, até 10k épocas, sem early stop — pare com Parar/Pausar na run.
              Para seguir uma run antiga, use <strong>Continuar treino</strong> na lista.
            </p>
          </div>
        </div>
        <div className="col" style={{ overflow: 'auto' }}>
          <h3>Artifacts</h3>
            <button onClick={() => refreshArtifacts()}>Refresh</button>
            <div
              className="artifacts-grid"
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
                gap: 8,
                alignItems: 'start'
              }}
            >
              {artifacts.map((a) => {
                const isImg = /\.(png|jpe?g)$/i.test(a)
                return (
                  <div
                    key={a}
                    style={{
                      border: '1px solid #222',
                      padding: 6,
                      cursor: 'pointer',
                      background: '#0b0c0d',
                      borderRadius: 6,
                      display: 'flex',
                      flexDirection: 'column'
                    }}
                    onClick={() => isImg && openArtifactViewer(a)}
                  >
                    {isImg ? (
                      // request thumbnail on demand to avoid storing large state
                      <AsyncThumb run={selected!} name={a} stamp={artifactStamp} />
                    ) : (
                      <div style={{ color: '#bbb' }}>{a}</div>
                    )}
                    <div style={{ fontSize: 12, marginTop: 6, wordBreak: 'break-all' }}>{a}</div>
                  </div>
                )
              })}
            </div>
            <p style={{ marginTop: 8, fontSize: 12, color: '#888' }}>Clique em uma miniatura para abrir o visualizador (zoom e pan).</p>
          </div>
          <div className="col" style={{ overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            <h3>Log (tail)</h3>
            {selected && !isLiveSelected && runFinished && (
              <p style={{ margin: '0 0 8px 0', fontSize: 13, color: '#81c784' }}>
                Treino finalizado — o log não vai crescer mais. Use o peso em{' '}
                <code style={{ fontSize: 11 }}>weights/best.pt</code>.
              </p>
            )}
            {selected && !isLiveSelected && !runFinished && (
              <p style={{ margin: '0 0 8px 0', fontSize: 13, color: '#ffb74d' }}>
                Nenhum treino ativo nesta run (log/artifacts só atualizam ao vivo enquanto roda).
              </p>
            )}
            <button onClick={() => selected && refreshLog(selected)}>Atualizar log</button>
            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '6px 12px',
              background: '#1e1e1e',
              borderBottom: '1px solid #333',
            }}>
              <div style={{ display: 'flex', fontFamily: 'monospace', fontSize: 11, color: '#888' }}>
                <span style={{ width: 100 }}>Epoch/Batch</span>
                <span style={{ width: 55 }}>GPU</span>
                <span style={{ width: 65 }}>box</span>
                <span style={{ width: 65 }}>cls</span>
                <span style={{ width: 65 }}>dfl</span>
                <span>inst</span>
              </div>
              <button
                onClick={() => {
                  const next = !autoScroll
                  setAutoScroll(next)
                  if (next && logRef.current) {
                    setTimeout(() => { logRef.current!.scrollTop = logRef.current!.scrollHeight }, 0)
                  }
                }}
                style={{
                  padding: '4px 10px',
                  borderRadius: 4,
                  border: 'none',
                  background: autoScroll ? '#ff6b6b' : '#333',
                  color: '#fff',
                  cursor: 'pointer',
                  fontWeight: 'bold',
                  fontSize: 14
                }}
                title={autoScroll ? 'Auto-scroll ativado (clique para desativar)' : 'Ativar auto-scroll'}
              >
                ↓
              </button>
            </div>
            <pre ref={logRef} className="log" style={{ flex: 1, overflowY: 'auto', margin: 0, maxHeight: '35vh' }}>{log}</pre>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginTop: 8 }}>
              <h3 style={{ margin: 0 }}>Métricas</h3>
              <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <div style={{ width: 18, height: 3, background: '#ff6b6b', borderRadius: 2 }} />
                  <span style={{ fontSize: 12, color: '#aaa' }}>Loss (perda)</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <div style={{ width: 18, height: 3, background: '#6be3ff', borderRadius: 2 }} />
                  <span style={{ fontSize: 12, color: '#aaa' }}>mAP</span>
                </div>
              </div>
            </div>
            <div style={{ border: '1px solid #333', padding: 8, overflow: 'visible' }}>
              {metrics ? (
                <MetricsChart metrics={metrics} />
              ) : (
                <div style={{ color: '#888', minHeight: 80 }}>Sem métricas detectadas</div>
              )}
            </div>
        </div>
      </div>
    </div>
    <ImageLightbox
      open={lightboxOpen}
      src={imageData}
      title={lightboxTitle}
      onClose={() => {
        setLightboxOpen(false)
        setImageData(null)
      }}
    />
    </>
  )
}

function MetricsChart({ metrics }: { metrics: any }) {
  // Try to extract arrays for epoch, loss, mAP if available
  const epochs: number[] | null = (metrics.epoch && Array.isArray(metrics.epoch)) ? metrics.epoch : ((metrics.epochs && Array.isArray(metrics.epochs)) ? metrics.epochs : null);
  // heuristics for common keys
  const loss: number[] | null =
    metrics['train/box_loss'] ??
    metrics.loss ??
    metrics['train/loss'] ??
    metrics['box'] ??
    null
  const map50: number[] | null =
    metrics['metrics/mAP50(B)'] ??
    metrics['mAP@0.5'] ??
    metrics['mAP50'] ??
    metrics['mAP50-95'] ??
    metrics['mAP'] ??
    null

  // If metrics is an object with arrays, pick first numeric arrays
  function findNumericArrays(obj: any) {
    const keys = Object.keys(obj)
    const numeric: Record<string, number[]> = {}
    for (const k of keys) {
      const v = obj[k]
      if (Array.isArray(v) && v.every((x: any) => typeof x === 'number')) numeric[k] = v
    }
    return numeric
  }

  const numeric = findNumericArrays(metrics)
  const lossKey = loss ? null : Object.keys(numeric).find((k) => k.toLowerCase().includes('loss'))
  const mapKey = map50
    ? null
    : Object.keys(numeric).find((k) => /mAP50/i.test(k) && !/95/.test(k)) ??
      Object.keys(numeric).find((k) => k.toLowerCase().includes('map'))

  const lossArr: number[] | null = loss ?? (lossKey ? numeric[lossKey] : null)
  const mapArr: number[] | null = map50 ?? (mapKey ? numeric[mapKey] : null)
  const len = Math.max(lossArr?.length ?? 0, mapArr?.length ?? 0)

  // Enhanced SVG plot with axes and zoom
  const width = 560
  const height = 220
  const pad = 36
  const [zoom, setZoom] = React.useState(0) // 0 = full, higher = zoom into recent

  const windowLen = Math.max(5, Math.floor(len * Math.max(0.05, 1 - zoom)))
  const start = Math.max(0, len - windowLen)
  const lossWindow = lossArr ? lossArr.slice(start, start + windowLen) : null
  const mapWindow = mapArr ? mapArr.slice(start, start + windowLen) : null
  const epochsWindow = epochs ? epochs.slice(start, start + windowLen) : null
  const displayLen = Math.max(lossWindow?.length ?? 0, mapWindow?.length ?? 0)

  const toX = (i: number) => pad + ((width - pad * 2) * i) / Math.max(1, displayLen - 1)
  const toY = (v: number, arr: number[] | null, higherIsBetter = false) => {
    if (!arr || arr.length === 0) return height - pad
    const min = Math.min(...arr)
    const max = Math.max(...arr)
    if (min === max) return height - pad
    const t = (v - min) / (max - min)
    const norm = higherIsBetter ? t : 1 - t
    return pad + (height - pad * 2) * (1 - norm)
  }

  const lossPath =
    lossWindow && lossWindow.length
      ? lossWindow.map((v, i) => `${i === 0 ? 'M' : 'L'} ${toX(i)} ${toY(v, lossWindow, false)}`).join(' ')
      : ''
  const mapPath =
    mapWindow && mapWindow.length
      ? mapWindow.map((v, i) => `${i === 0 ? 'M' : 'L'} ${toX(i)} ${toY(v, mapWindow, true)}`).join(' ')
      : ''

  const yArr = lossWindow ?? mapWindow ?? []
  const yMin = yArr.length ? Math.min(...yArr) : 0
  const yMax = yArr.length ? Math.max(...yArr) : 1
  const yTicks = 4
  const ticks = Array.from({ length: yTicks + 1 }, (_, i) => yMin + (i * (yMax - yMin)) / yTicks)

  return (
    <div>
      <svg width={width} height={height}>
        <rect x={0} y={0} width={width} height={height} fill="#0f1113" stroke="#222" />
        {ticks.map((t, idx) => (
          <g key={idx}>
            <line
              x1={pad}
              x2={width - pad}
              y1={pad + (idx / yTicks) * (height - pad * 2)}
              y2={pad + (idx / yTicks) * (height - pad * 2)}
              stroke="#222"
              strokeDasharray="2 4"
            />
            <text x={8} y={pad + (idx / yTicks) * (height - pad * 2) + 4} fill="#666" fontSize={11}>
              {t.toFixed(4)}
            </text>
          </g>
        ))}
        {Array.from({ length: Math.min(displayLen, 6) }).map((_, i) => {
          const idx = Math.floor((i * (displayLen - 1)) / Math.max(1, 5))
          const label = epochsWindow ? String(epochsWindow[idx]) : String(start + idx)
          return (
            <text key={i} x={toX(idx)} y={height - 8} fill="#666" fontSize={11} textAnchor="middle">
              {label}
            </text>
          )
        })}
        {lossPath && <path d={lossPath} stroke="#ff6b6b" fill="none" strokeWidth={2} />}
        {mapPath && <path d={mapPath} stroke="#6be3ff" fill="none" strokeWidth={2} />}
      </svg>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', flexDirection: 'column', width: 220 }}>
            <label style={{ fontSize: 12, color: '#999' }}>Zoom (focus recent)</label>
            <input
              type="range"
              min={0}
              max={0.95}
              step={0.05}
              value={zoom}
              onChange={(e) => setZoom(Number(e.target.value))}
            />
          </div>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            {lossArr && <div style={{ color: '#ff6b6b' }}>Loss (↓ melhor): {lossArr[lossArr.length - 1]?.toFixed(4)}</div>}
            {mapArr && <div style={{ color: '#6be3ff' }}>mAP50 (↑ melhor): {mapArr[mapArr.length - 1]?.toFixed(4)}</div>}
          </div>
        </div>
      </div>
    </div>
  )
}

