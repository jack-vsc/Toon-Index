import { CloudSection } from './CloudSection'
import { useEffect, useState } from 'react'
import type { DevicesStatus, PairingCode } from '../../../shared/devices'
import type { UpdatesStatus } from '../../../shared/updates'

interface Props {
  onClose: () => void
}

/** Turns on answering the phone app, pairs a phone with a QR code, and lists or removes paired phones. */
export function PhoneDialog({ onClose }: Props) {
  const [status, setStatus] = useState<DevicesStatus | null>(null)
  const [pairing, setPairing] = useState<PairingCode | null>(null)
  const [now, setNow] = useState(Date.now())
  const [updates, setUpdates] = useState<UpdatesStatus | null>(null)
  // The notifications go through Firebase: ntfy is offered only without it (or while it is still on).
  const [pushOn, setPushOn] = useState(false)

  useEffect(() => {
    window.api.devices.status().then(setStatus)
    window.api.updates.status().then(setUpdates)
    window.api.cloud.status().then((s) => setPushOn(s.push))
    // Shows the phone once it paired, and counts the code's minutes down.
    const timer = setInterval(() => {
      setNow(Date.now())
      window.api.devices.status().then(setStatus)
    }, 3000)
    return () => clearInterval(timer)
  }, [])

  const expired = pairing && now > pairing.expiresAt

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal phone-dialog" onClick={(e) => e.stopPropagation()}>
        <h2>Celular</h2>
        <p className="hint">
          O app do celular mostra sua biblioteca e onde você parou, e manda para cá o que você lê nele. Ele acessa este PC
          pelo Wi-Fi de casa ou, fora de casa, pelo Tailscale.
        </p>

        {status && (
          <label className="row phone-toggle">
            <input
              type="checkbox"
              checked={status.enabled}
              onChange={async (e) => {
                setStatus(await window.api.devices.enable(e.target.checked))
                setPairing(null)
              }}
            />
            <span>Permitir que celulares pareados acessem este PC pela rede</span>
          </label>
        )}

        {status?.enabled && (
          <>
            <p className="hint">
              Endereços deste PC:{' '}
              {status.addresses.length
                ? status.addresses.map((a) => `${a.address}${a.kind === 'tailscale' ? ' (Tailscale)' : ''}`).join(' · ')
                : 'nenhum encontrado (o PC está conectado à rede?)'}{' '}
              · porta {status.port}
              {!status.addresses.some((a) => a.kind === 'tailscale') && (
                <>
                  <br />
                  Sem Tailscale, o celular só alcança o PC no mesmo Wi-Fi.
                </>
              )}
            </p>

            {!pairing || expired ? (
              <button onClick={async () => setPairing(await window.api.devices.pairing())}>Parear um celular</button>
            ) : (
              <div className="pairing">
                <img src={pairing.qr} alt="QR code de pareamento" />
                <div>
                  <p>No app do celular, toque em "Parear" e aponte a câmera para o código.</p>
                  <p>
                    Ou digite o código <strong className="pairing-code">{pairing.code}</strong>
                  </p>
                  <p className="hint">Vale por mais {Math.max(0, Math.ceil((pairing.expiresAt - now) / 60000))} min e para um celular só.</p>
                </div>
              </div>
            )}
            <p className="hint">
              Na primeira vez, o Windows pode perguntar se o Toon Index pode usar a rede: permita em redes privadas.
            </p>
          </>
        )}

        {status && status.devices.length > 0 && (
          <>
            <h3>Celulares pareados</h3>
            <ul className="device-list">
              {status.devices.map((d) => (
                <li key={d.id}>
                  <span>
                    <strong>{d.name}</strong>
                    <span className="hint">
                      {' '}
                      · pareado em {new Date(d.pairedAt).toLocaleDateString('pt-BR')}
                      {d.lastSeen ? ` · visto ${new Date(d.lastSeen).toLocaleString('pt-BR')}` : ''}
                    </span>
                  </span>
                  <button
                    className="secondary small"
                    onClick={async () => {
                      if (confirm(`Remover "${d.name}"? Ele perde o acesso até ser pareado de novo.`)) setStatus(await window.api.devices.revoke(d.id))
                    }}
                  >
                    Remover
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}

        <CloudSection />

        {updates && (!pushOn || updates.ntfyTopic) && (
          <>
            <h3>Avisos de capítulo novo no celular</h3>
            <label className="row phone-toggle">
              <input type="checkbox" checked={!!updates.ntfyTopic} onChange={async (e) => setUpdates(await window.api.updates.setNtfy(e.target.checked))} />
              <span>Avisar no celular pelo ntfy, mesmo com o PC fora de alcance</span>
            </label>
            {updates.ntfyTopic && (
              <p className="hint">
                Instale o app <strong>ntfy</strong> (Play Store) e, no app Toon Index, toque em Configurações › Avisos de capítulo novo para assinar. Ou assine
                à mão o tópico <code>{updates.ntfyTopic}</code> no servidor ntfy.sh. Quem souber o tópico também vê os avisos: não o
                compartilhe.
              </p>
            )}
          </>
        )}

        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="secondary" onClick={onClose}>
            Fechar
          </button>
        </div>
      </div>
    </div>
  )
}
