import { useEffect, useState } from 'react'
import { FIRESTORE_RULES, type CloudStatus } from '../../../shared/cloud'

/**
 * The sync over the internet (the person's Firebase project): pasting the project's config, the
 * security rules to paste back in the console, and how it is going.
 */
export function CloudSection() {
  const [status, setStatus] = useState<CloudStatus | null>(null)
  const [editing, setEditing] = useState(false)
  const [pasted, setPasted] = useState('')
  const [androidAppId, setAndroidAppId] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    void window.api.cloud.status().then(setStatus)
  }, [])
  // The PC may still be connecting when this opens (or the internet came back): asked again until it is.
  useEffect(() => {
    if (!status?.configured || status.connected) return
    const timer = setInterval(() => void window.api.cloud.status().then(setStatus), 3000)
    return () => clearInterval(timer)
  }, [status?.configured, status?.connected])

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      setStatus(await window.api.cloud.set(pasted, androidAppId))
      setEditing(false)
    } catch (err) {
      setError(String((err as Error).message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <h3>Pela internet (sem Tailscale)</h3>
      <p className="hint">
        Com um projeto seu no Firebase (grátis), o celular vê a biblioteca, marca o que leu e manda capítulos para a fila de qualquer lugar.
        Só vão informações para lá, nunca PDFs ou imagens. Os capítulos para ler fora de casa o celular guarda sozinho no Wi-Fi de casa.
      </p>
      {status?.configured && !editing ? (
        <>
          <p>
            {status.connected ? (
              <strong className="ok-text">● Conectado</strong>
            ) : (
              <strong className="error-text">● Não conectado</strong>
            )}
            {status.connected && ` · ${status.members} ${status.members === 1 ? 'celular' : 'celulares'}`}
          </p>
          {status.error && <p className="hint error-text">{status.error}</p>}
          {status.connected && status.members === 0 && (
            <p className="hint">Pareie o celular de novo aqui em casa (Configurações › Parear de novo) para ele entrar.</p>
          )}
          {status.connected && <PushKey status={status} onStatus={setStatus} />}
          <div className="row">
            <button className="secondary small" onClick={() => setEditing(true)}>
              Trocar projeto
            </button>
            <button
              className="secondary small"
              onClick={async () => {
                if (confirm('Desligar a sincronização pela internet? Os celulares voltam a falar com o PC só em casa.')) setStatus(await window.api.cloud.forget())
              }}
            >
              Desligar
            </button>
          </div>
        </>
      ) : (
        <>
          <ol className="hint cloud-steps">
            <li>No console do Firebase, crie um projeto, um banco Firestore (modo produção) e ative Anônimo e E-mail/senha em Authentication.</li>
            <li>Em Firestore › Regras, cole as regras abaixo e publique.</li>
            <li>Em Configurações do projeto, adicione um app Web e um app Android (pacote com.jack.manga_index).</li>
            <li>Cole aqui o bloco firebaseConfig do app Web e o ID do app Android.</li>
          </ol>
          <details>
            <summary>Regras do Firestore</summary>
            <pre className="cloud-rules">{FIRESTORE_RULES}</pre>
            <button className="secondary small" onClick={() => void navigator.clipboard.writeText(FIRESTORE_RULES)}>
              Copiar as regras
            </button>
          </details>
          <label className="field-label">firebaseConfig (do app Web)</label>
          <textarea rows={7} value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder={'const firebaseConfig = {\n  apiKey: "…",\n  …\n};'} />
          <label className="field-label">ID do app Android</label>
          <input value={androidAppId} onChange={(e) => setAndroidAppId(e.target.value)} placeholder="1:123456789:android:abc123…" />
          {error && <p className="hint error-text">{error}</p>}
          <div className="row">
            {status?.configured && (
              <button className="secondary small" onClick={() => setEditing(false)}>
                Cancelar
              </button>
            )}
            <button className="small" disabled={saving || !pasted.trim() || !androidAppId.trim()} onClick={() => void save()}>
              {saving ? 'Conectando…' : 'Salvar e conectar'}
            </button>
          </div>
        </>
      )}
    </>
  )
}

const reason = (err: unknown): string => String((err as Error).message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** The new-chapter notifications on the phones: the project's service key, kept only on this PC. */
function PushKey({ status, onStatus }: { status: CloudStatus; onStatus: (status: CloudStatus) => void }) {
  const [pasted, setPasted] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const run = async (work: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    setNote(null)
    try {
      await work()
    } catch (err) {
      setError(reason(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <h4>Avisos de capítulo novo no celular</h4>
      {status.push ? (
        <>
          <p>
            <strong className="ok-text">● Ligados</strong> <span className="hint">· chegam pelo Firebase, mesmo fora de casa</span>
          </p>
          <div className="row">
            <button
              className="secondary small"
              disabled={busy}
              onClick={() =>
                void run(async () =>
                  setNote(
                    (await window.api.cloud.testPush())
                      ? 'Aviso de teste enviado.'
                      : 'Nenhum celular recebeu: abra o app aqui em casa e permita as notificações em Configurações › Avisos de capítulo novo.'
                  )
                )
              }
            >
              Mandar um aviso de teste
            </button>
            <button
              className="secondary small"
              disabled={busy}
              onClick={() => void run(async () => onStatus(await window.api.cloud.setPushKey(null)))}
            >
              Remover a chave
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="hint">
            No console do Firebase, em Configurações do projeto › Contas de serviço, clique em "Gerar nova chave privada", abra o arquivo
            baixado no Bloco de Notas e cole tudo abaixo. A chave fica só neste PC, criptografada; depois pode apagar o arquivo.
          </p>
          <label className="field-label">Chave (o conteúdo do arquivo .json)</label>
          <textarea
            rows={6}
            style={{ width: '100%', display: 'block' }}
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
            placeholder={'{\n  "type": "service_account",\n  "project_id": "toon-index",\n  …\n}'}
          />
          <div className="row">
            <button
              className="small"
              disabled={busy || !pasted.trim()}
              onClick={() =>
                void run(async () => {
                  onStatus(await window.api.cloud.setPushKey(pasted))
                  setPasted('')
                })
              }
            >
              {busy ? 'Conferindo…' : 'Ligar os avisos'}
            </button>
          </div>
        </>
      )}
      {note && <p className="hint">{note}</p>}
      {error && <p className="hint error-text">{error}</p>}
    </>
  )
}
